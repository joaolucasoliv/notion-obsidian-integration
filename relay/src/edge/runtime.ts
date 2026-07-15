import { base64url } from "@grandbox-bridge/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BridgeApiDependencies, BridgeApiInstallation, BridgeApiInstallations } from "../queue/handler.ts";
import {
  EventRepository,
  type EventRepositoryStore,
  type RateCounterName,
  type RateCounterState,
  type StoredWebhookEvent,
} from "../queue/repository.ts";
import { SnapshotRepository, SupabaseSnapshotRepositoryStore } from "../snapshot/repository.ts";
import type { InstallationRepository, WebhookDependencies, WebhookInstallation } from "../webhook/handler.ts";
import type { EdgeRuntimeConfiguration } from "./config.ts";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELAY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RELAY_TOKEN_HASH = /^[A-Za-z0-9_-]{43}$/;
const RATE_COLUMNS: Readonly<Record<RateCounterName, readonly [string, string]>> = {
  api: ["api_rate_window_started_at", "api_rate_count"],
  webhook: ["webhook_rate_window_started_at", "webhook_rate_count"],
  graph: ["graph_rate_window_started_at", "graph_rate_count"],
};

type ServiceRoleClient = SupabaseClient<any, "public", any>;

function databaseFailure(code = "invalid"): never {
  console.error("grandbox-bridge-edge", `database_${code}`);
  throw new Error("Relay database request failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rows(result: { readonly data: unknown; readonly error: unknown }): readonly Record<string, unknown>[] {
  if (result.error !== null && result.error !== undefined) {
    const code = isRecord(result.error) && typeof result.error.code === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(result.error.code)
      ? result.error.code
      : "request_error";
    return databaseFailure(code);
  }
  if (!Array.isArray(result.data) || !result.data.every(isRecord)) {
    return databaseFailure("response_invalid");
  }
  return result.data;
}

function exactlyOne(result: { readonly data: unknown; readonly error: unknown }): Record<string, unknown> | null {
  const resultRows = rows(result);
  if (resultRows.length > 1) return databaseFailure();
  return resultRows[0] ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === "23505";
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === "string" && CANONICAL_UUID.test(value) ? value : null;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return databaseFailure();
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return requiredText(value);
}

function timestamp(value: unknown): string {
  const text = requiredText(value);
  if (!Number.isFinite(new Date(text).getTime())) return databaseFailure();
  return text;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return databaseFailure();
  return value;
}

function optionalJwk(value: unknown): JsonWebKey | null {
  if (value === null) return null;
  if (!isRecord(value)) return databaseFailure();
  return value as JsonWebKey;
}

function parseInstallation(row: Record<string, unknown>): BridgeApiInstallation {
  const id = canonicalUuid(row.id);
  const graphId = canonicalUuid(row.graph_id);
  const relayTokenHash = requiredText(row.relay_token_hash);
  const pendingRelayTokenHash = nullableText(row.pending_relay_token_hash);
  const pendingRelayTokenExpiresAt = nullableTimestamp(row.pending_relay_token_expires_at);
  if (
    id === null
    || graphId === null
    || !RELAY_TOKEN_HASH.test(relayTokenHash)
    || (pendingRelayTokenHash !== null && !RELAY_TOKEN_HASH.test(pendingRelayTokenHash))
    || (pendingRelayTokenHash === null) !== (pendingRelayTokenExpiresAt === null)
  ) {
    return databaseFailure();
  }
  return {
    id,
    graphId,
    relayTokenHash,
    pendingRelayTokenHash,
    pendingRelayTokenExpiresAt,
    bootstrapPublicJwk: optionalJwk(row.bootstrap_public_jwk),
    pendingWebhookTokenCiphertext: nullableText(row.pending_webhook_token_ciphertext),
  };
}

function parseStoredWebhookEvent(row: Record<string, unknown>): StoredWebhookEvent {
  const installationId = canonicalUuid(row.installation_id);
  const id = canonicalUuid(row.event_id);
  const entityId = canonicalUuid(row.entity_id);
  if (installationId === null || id === null || entityId === null) return databaseFailure();
  return {
    installationId,
    id,
    type: requiredText(row.event_type),
    entityId,
    eventAt: timestamp(row.event_at),
    receivedAt: timestamp(row.received_at),
    leaseOwner: nullableText(row.lease_owner),
    leaseExpiresAt: nullableTimestamp(row.lease_expires_at),
    consumedAt: nullableTimestamp(row.consumed_at),
  };
}

function resultContainsRow(result: { readonly data: unknown; readonly error: unknown }): boolean {
  return rows(result).length === 1;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function relayTokenHash(token: string, pepper: string, crypto: Crypto): Promise<string | null> {
  if (!RELAY_TOKEN.test(token) || !crypto.subtle) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(pepper)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, toArrayBuffer(new TextEncoder().encode(token)));
  return base64url(new Uint8Array(signature));
}

/** Service-role data adapter; every query fixes the installation scope itself. */
export class SupabaseEdgeRepositoryStore implements EventRepositoryStore, BridgeApiInstallations, InstallationRepository {
  constructor(
    private readonly client: ServiceRoleClient,
    private readonly relayTokenPepper: string,
    private readonly crypto: Crypto,
  ) {}

  private async installationRowsByTokenHash(tokenHash: string): Promise<readonly BridgeApiInstallation[]> {
    if (!RELAY_TOKEN_HASH.test(tokenHash)) return [];
    const columns = "id,graph_id,relay_token_hash,pending_relay_token_hash,pending_relay_token_expires_at,bootstrap_public_jwk,pending_webhook_token_ciphertext";
    let active;
    let pending;
    try {
      [active, pending] = await Promise.all([
        this.client.from("bridge_installation").select(columns).eq("relay_token_hash", tokenHash),
        this.client.from("bridge_installation").select(columns).eq("pending_relay_token_hash", tokenHash),
      ]);
    } catch {
      console.error("grandbox-bridge-edge", "database_transport_failure");
      throw new Error("Relay database transport failed");
    }
    const byId = new Map<string, BridgeApiInstallation>();
    for (const row of [...rows(active), ...rows(pending)]) {
      const installation = parseInstallation(row);
      byId.set(installation.id, installation);
    }
    return [...byId.values()];
  }

  async findByRelayTokenHash(tokenHash: string): Promise<BridgeApiInstallation | null> {
    const installations = await this.installationRowsByTokenHash(tokenHash);
    if (installations.length > 1) return databaseFailure();
    return installations[0] ?? null;
  }

  async authenticate(bearer: string): Promise<WebhookInstallation | null> {
    const digest = await relayTokenHash(bearer, this.relayTokenPepper, this.crypto);
    if (digest === null) return null;
    const installation = await this.findByRelayTokenHash(digest);
    if (installation === null) return null;
    return { id: installation.id, bootstrapPublicJwk: installation.bootstrapPublicJwk };
  }

  async prepareRelayTokenRotation(input: {
    readonly installationId: string;
    readonly expectedActiveTokenHash: string;
    readonly pendingTokenHash: string;
    readonly expiresAt: string;
    readonly now: Date;
  }): Promise<"prepared" | "idempotent" | "conflict"> {
    if (
      canonicalUuid(input.installationId) === null
      || !RELAY_TOKEN_HASH.test(input.expectedActiveTokenHash)
      || !RELAY_TOKEN_HASH.test(input.pendingTokenHash)
      || !Number.isFinite(input.now.getTime())
      || !Number.isFinite(new Date(input.expiresAt).getTime())
    ) {
      return databaseFailure();
    }
    const current = exactlyOne(await this.client.from("bridge_installation")
      .select("relay_token_hash,pending_relay_token_hash,pending_relay_token_expires_at")
      .eq("id", input.installationId));
    if (current === null || current.relay_token_hash !== input.expectedActiveTokenHash) return "conflict";
    if (current.pending_relay_token_hash === input.pendingTokenHash && current.pending_relay_token_expires_at === input.expiresAt) {
      return "idempotent";
    }
    if (current.pending_relay_token_hash !== null || current.pending_relay_token_expires_at !== null) return "conflict";
    const update = await this.client.from("bridge_installation")
      .update({ pending_relay_token_hash: input.pendingTokenHash, pending_relay_token_expires_at: input.expiresAt })
      .eq("id", input.installationId)
      .eq("relay_token_hash", input.expectedActiveTokenHash)
      .is("pending_relay_token_hash", null)
      .is("pending_relay_token_expires_at", null)
      .select("id");
    return resultContainsRow(update) ? "prepared" : "conflict";
  }

  async commitRelayTokenRotation(input: {
    readonly installationId: string;
    readonly expectedPendingTokenHash: string;
    readonly now: Date;
  }): Promise<boolean> {
    if (canonicalUuid(input.installationId) === null || !RELAY_TOKEN_HASH.test(input.expectedPendingTokenHash) || !Number.isFinite(input.now.getTime())) {
      return databaseFailure();
    }
    const update = await this.client.from("bridge_installation")
      .update({ relay_token_hash: input.expectedPendingTokenHash, pending_relay_token_hash: null, pending_relay_token_expires_at: null })
      .eq("id", input.installationId)
      .eq("pending_relay_token_hash", input.expectedPendingTokenHash)
      .gt("pending_relay_token_expires_at", input.now.toISOString())
      .select("id");
    return resultContainsRow(update);
  }

  async cancelRelayTokenRotation(input: {
    readonly installationId: string;
    readonly expectedActiveTokenHash: string;
    readonly expectedPendingTokenHash: string;
    readonly now: Date;
  }): Promise<boolean> {
    if (
      canonicalUuid(input.installationId) === null
      || !RELAY_TOKEN_HASH.test(input.expectedActiveTokenHash)
      || !RELAY_TOKEN_HASH.test(input.expectedPendingTokenHash)
      || !Number.isFinite(input.now.getTime())
    ) {
      return databaseFailure();
    }
    const update = await this.client.from("bridge_installation")
      .update({ pending_relay_token_hash: null, pending_relay_token_expires_at: null })
      .eq("id", input.installationId)
      .eq("relay_token_hash", input.expectedActiveTokenHash)
      .eq("pending_relay_token_hash", input.expectedPendingTokenHash)
      .gt("pending_relay_token_expires_at", input.now.toISOString())
      .select("id");
    return resultContainsRow(update);
  }

  async clearBootstrapMaterial(input: { readonly installationId: string; readonly expectedCiphertext: string }): Promise<boolean> {
    if (canonicalUuid(input.installationId) === null || input.expectedCiphertext.length === 0) return databaseFailure();
    const update = await this.client.from("bridge_installation")
      .update({ pending_webhook_token_ciphertext: null })
      .eq("id", input.installationId)
      .eq("pending_webhook_token_ciphertext", input.expectedCiphertext)
      .select("id");
    return resultContainsRow(update);
  }

  async consumeBootstrapPublicJwkAndStorePendingWebhookTokenCiphertext(installationId: string, ciphertext: string): Promise<boolean> {
    if (canonicalUuid(installationId) === null || typeof ciphertext !== "string" || ciphertext.length === 0) return databaseFailure();
    const update = await this.client.from("bridge_installation")
      .update({ bootstrap_public_jwk: null, pending_webhook_token_ciphertext: ciphertext })
      .eq("id", installationId)
      .is("pending_webhook_token_ciphertext", null)
      .not("bootstrap_public_jwk", "is", null)
      .select("id");
    return resultContainsRow(update);
  }

  async insertEventIfAbsent(event: StoredWebhookEvent): Promise<boolean> {
    const result = await this.client.from("webhook_event").insert({
      installation_id: event.installationId,
      event_id: event.id,
      event_type: event.type,
      entity_id: event.entityId,
      event_at: event.eventAt,
      received_at: event.receivedAt,
      lease_owner: event.leaseOwner,
      lease_expires_at: event.leaseExpiresAt,
      consumed_at: event.consumedAt,
    }).select("event_id");
    if (result.error !== null && result.error !== undefined) {
      return isUniqueViolation(result.error) ? false : databaseFailure();
    }
    return resultContainsRow(result);
  }

  async listEvents(installationId: string): Promise<readonly StoredWebhookEvent[]> {
    if (canonicalUuid(installationId) === null) return databaseFailure();
    const result = await this.client.from("webhook_event")
      .select("installation_id,event_id,event_type,entity_id,event_at,received_at,lease_owner,lease_expires_at,consumed_at")
      .eq("installation_id", installationId);
    return rows(result).map(parseStoredWebhookEvent);
  }

  async compareAndSetLease(input: {
    readonly installationId: string;
    readonly eventId: string;
    readonly expectedLeaseExpiresAt: string | null;
    readonly leaseOwner: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean> {
    if (canonicalUuid(input.installationId) === null || canonicalUuid(input.eventId) === null) return databaseFailure();
    let update = this.client.from("webhook_event")
      .update({ lease_owner: input.leaseOwner, lease_expires_at: input.leaseExpiresAt })
      .eq("installation_id", input.installationId)
      .eq("event_id", input.eventId)
      .is("consumed_at", null);
    update = input.expectedLeaseExpiresAt === null
      ? update.is("lease_expires_at", null)
      : update.eq("lease_expires_at", input.expectedLeaseExpiresAt);
    return resultContainsRow(await update.select("event_id"));
  }

  async compareAndSetConsumed(input: {
    readonly installationId: string;
    readonly eventId: string;
    readonly expectedLeaseOwner: string;
    readonly consumedAt: string;
  }): Promise<boolean> {
    if (canonicalUuid(input.installationId) === null || canonicalUuid(input.eventId) === null) return databaseFailure();
    const update = await this.client.from("webhook_event")
      .update({ consumed_at: input.consumedAt, lease_owner: null, lease_expires_at: null })
      .eq("installation_id", input.installationId)
      .eq("event_id", input.eventId)
      .eq("lease_owner", input.expectedLeaseOwner)
      .is("consumed_at", null)
      .gt("lease_expires_at", input.consumedAt)
      .select("event_id");
    return resultContainsRow(update);
  }

  async acknowledgeEventsAtomically(input: {
    readonly installationId: string;
    readonly eventIds: readonly string[];
    readonly expectedLeaseOwner: string;
    readonly consumedAt: string;
  }): Promise<boolean> {
    const result = await this.client.rpc("bridge_acknowledge_webhook_events", {
      p_installation_id: input.installationId,
      p_event_ids: input.eventIds,
      p_expected_lease_owner: input.expectedLeaseOwner,
      p_consumed_at: input.consumedAt,
    });
    if (result.error !== null && result.error !== undefined || typeof result.data !== "boolean") return databaseFailure();
    return result.data;
  }

  async deleteConsumedBefore(installationId: string, cutoff: string): Promise<number> {
    if (canonicalUuid(installationId) === null) return databaseFailure();
    const result = await this.client.from("webhook_event")
      .delete()
      .eq("installation_id", installationId)
      .lt("consumed_at", cutoff)
      .select("event_id");
    return rows(result).length;
  }

  async putPageRegistration(input: { readonly installationId: string; readonly notionPageId: string; readonly bridgeId: string }): Promise<void> {
    const result = await this.client.from("synced_page_registry").insert({
      installation_id: input.installationId,
      notion_page_id: input.notionPageId,
      bridge_id: input.bridgeId,
    }).select("bridge_id");
    if (result.error === null || result.error === undefined) return;
    if (!isUniqueViolation(result.error)) return databaseFailure();
    const existing = exactlyOne(await this.client.from("synced_page_registry")
      .select("bridge_id")
      .eq("installation_id", input.installationId)
      .eq("notion_page_id", input.notionPageId));
    if (existing?.bridge_id === input.bridgeId) return;
    return databaseFailure();
  }

  async deletePageRegistration(input: { readonly installationId: string; readonly notionPageId: string; readonly bridgeId: string }): Promise<void> {
    const result = await this.client.from("synced_page_registry")
      .delete()
      .eq("installation_id", input.installationId)
      .eq("notion_page_id", input.notionPageId)
      .eq("bridge_id", input.bridgeId);
    if (result.error !== null && result.error !== undefined) return databaseFailure();
  }

  async findBridgeId(installationId: string, notionPageId: string): Promise<string | null> {
    const row = exactlyOne(await this.client.from("synced_page_registry")
      .select("bridge_id")
      .eq("installation_id", installationId)
      .eq("notion_page_id", notionPageId));
    return row === null ? null : canonicalUuid(row.bridge_id) ?? databaseFailure();
  }

  async routePage(installationId: string, notionPageId: string): Promise<string | null> {
    return this.findBridgeId(installationId, notionPageId);
  }

  async readRateCounter(installationId: string, counter: RateCounterName): Promise<RateCounterState> {
    const columns = RATE_COLUMNS[counter];
    const row = exactlyOne(await this.client.from("bridge_installation")
      .select(`${columns[0]},${columns[1]}`)
      .eq("id", installationId));
    if (row === null) return databaseFailure();
    return { windowStartedAt: timestamp(row[columns[0]]), count: safeInteger(row[columns[1]]) };
  }

  async compareAndSetRateCounter(input: {
    readonly installationId: string;
    readonly counter: RateCounterName;
    readonly expected: RateCounterState;
    readonly next: RateCounterState;
  }): Promise<boolean> {
    const columns = RATE_COLUMNS[input.counter];
    const update = await this.client.from("bridge_installation")
      .update({ [columns[0]]: input.next.windowStartedAt, [columns[1]]: input.next.count })
      .eq("id", input.installationId)
      .eq(columns[0], input.expected.windowStartedAt)
      .eq(columns[1], input.expected.count)
      .select("id");
    return resultContainsRow(update);
  }
}

function safeLog(code: string): void {
  console.warn("grandbox-bridge-edge", code);
}

/** Builds both handler dependency sets from server-only configuration. */
export function createEdgeRuntimeDependencies(
  client: ServiceRoleClient,
  configuration: EdgeRuntimeConfiguration,
  crypto: Crypto = globalThis.crypto,
): { readonly bridgeApi: BridgeApiDependencies; readonly webhook: WebhookDependencies } {
  if (!crypto?.subtle) throw new Error("Edge crypto is unavailable");
  const store = new SupabaseEdgeRepositoryStore(client, configuration.relayTokenPepper, crypto);
  const events = new EventRepository(store);
  const snapshots = new SnapshotRepository(new SupabaseSnapshotRepositoryStore({
    rpc: async (functionName, args) => {
      const result = await client.rpc(functionName, args);
      return { data: result.data, error: result.error };
    },
  }));
  const clock = { now: () => new Date() };
  return {
    bridgeApi: {
      events,
      snapshots,
      installations: store,
      verificationToken: async (installationId) => configuration.verificationToken(installationId),
      relayTokenPepper: configuration.relayTokenPepper,
      clock,
      crypto,
      log: { write: safeLog },
    },
    webhook: {
      verificationToken: async (installationId) => configuration.verificationToken(installationId),
      installation: store,
      pages: store,
      events,
      clock,
      crypto,
      log: { write: safeLog },
    },
  };
}
