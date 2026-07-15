import { base64url } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import {
  EventRepository,
  type EventRepositoryStore,
  type RateCounterName,
  type RateCounterState,
  type StoredWebhookEvent,
  type WebhookEventInput,
} from "./repository.js";
import {
  handleBridgeApi,
  type BridgeApiDependencies,
  type BridgeApiInstallation,
  type BridgeApiInstallations,
  type SafeBridgeApiLogger,
} from "./handler.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const BRIDGE_ID = "44444444-4444-4444-8444-444444444444";
const SECOND_PAGE_ID = "55555555-5555-4555-8555-555555555555";
const EVENT_ID = "66666666-6666-4666-8666-666666666666";
const SECOND_EVENT_ID = "77777777-7777-4777-8777-777777777777";
const RELAY_TOKEN = token(1);
const NEXT_RELAY_TOKEN = token(2);
const SECOND_RELAY_TOKEN = token(3);
const RELAY_TOKEN_PEPPER = "fixture-relay-token-pepper";
const FIXTURE_VERIFICATION_TOKEN = "fixture-webhook-verification-value";
const ENCRYPTED_WEBHOOK_TOKEN = base64url(Uint8Array.from({ length: 48 }, (_, index) => index + 1));
const NOW = new Date("2026-07-15T12:00:00.000Z");

const SAFE_EVENT: WebhookEventInput = {
  id: EVENT_ID,
  type: "page.updated",
  entityId: PAGE_ID,
  eventAt: NOW.toISOString(),
};

function token(value: number): string {
  return base64url(new Uint8Array(32).fill(value));
}

function eventKey(installationId: string, eventId: string): string {
  return installationId + ":" + eventId;
}

function counterKey(installationId: string, counter: RateCounterName): string {
  return installationId + ":" + counter;
}

function plusSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1_000);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function hmacBase64url(key: string, message: string): Promise<string> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(key)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    toArrayBuffer(new TextEncoder().encode(message)),
  );
  return base64url(new Uint8Array(signature));
}

class FixtureClock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  set(value: Date): void {
    this.value = new Date(value);
  }
}

class MemoryEventStore implements EventRepositoryStore {
  readonly events = new Map<string, StoredWebhookEvent>();
  private readonly pages = new Map<string, { readonly installationId: string; readonly pageId: string; readonly bridgeId: string }>();
  private readonly bridgePages = new Map<string, string>();
  private readonly counters = new Map<string, RateCounterState>();

  async insertEventIfAbsent(event: StoredWebhookEvent): Promise<boolean> {
    const key = eventKey(event.installationId, event.id);
    if (this.events.has(key)) return false;
    this.events.set(key, { ...event });
    return true;
  }

  async listEvents(installationId: string): Promise<readonly StoredWebhookEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.installationId === installationId)
      .map((event) => ({ ...event }));
  }

  async compareAndSetLease(input: {
    readonly installationId: string;
    readonly eventId: string;
    readonly expectedLeaseExpiresAt: string | null;
    readonly leaseOwner: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean> {
    const key = eventKey(input.installationId, input.eventId);
    const event = this.events.get(key);
    if (event === undefined || event.consumedAt !== null || event.leaseExpiresAt !== input.expectedLeaseExpiresAt) return false;
    this.events.set(key, { ...event, leaseOwner: input.leaseOwner, leaseExpiresAt: input.leaseExpiresAt });
    return true;
  }

  async compareAndSetConsumed(input: {
    readonly installationId: string;
    readonly eventId: string;
    readonly expectedLeaseOwner: string;
    readonly consumedAt: string;
  }): Promise<boolean> {
    const key = eventKey(input.installationId, input.eventId);
    const event = this.events.get(key);
    if (event === undefined || event.consumedAt !== null || event.leaseOwner !== input.expectedLeaseOwner) return false;
    this.events.set(key, { ...event, consumedAt: input.consumedAt, leaseOwner: null, leaseExpiresAt: null });
    return true;
  }

  async acknowledgeEventsAtomically(input: {
    readonly installationId: string;
    readonly eventIds: readonly string[];
    readonly expectedLeaseOwner: string;
    readonly consumedAt: string;
  }): Promise<boolean> {
    const entries = input.eventIds.map((eventId) => [eventKey(input.installationId, eventId), this.events.get(eventKey(input.installationId, eventId))] as const);
    if (
      entries.some(
        ([, event]) =>
          event === undefined ||
          event.consumedAt !== null ||
          event.leaseOwner !== input.expectedLeaseOwner ||
          event.leaseExpiresAt === null ||
          event.leaseExpiresAt <= input.consumedAt,
      )
    ) {
      return false;
    }
    for (const [key, event] of entries) {
      if (event === undefined) return false;
      this.events.set(key, { ...event, consumedAt: input.consumedAt, leaseOwner: null, leaseExpiresAt: null });
    }
    return true;
  }

  async deleteConsumedBefore(installationId: string, cutoff: string): Promise<number> {
    let deleted = 0;
    for (const [key, event] of this.events) {
      if (event.installationId === installationId && event.consumedAt !== null && event.consumedAt < cutoff) {
        this.events.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async putPageRegistration(input: {
    readonly installationId: string;
    readonly notionPageId: string;
    readonly bridgeId: string;
  }): Promise<void> {
    const pageKey = eventKey(input.installationId, input.notionPageId);
    const bridgeKey = eventKey(input.installationId, input.bridgeId);
    const existingPage = this.pages.get(pageKey);
    const existingBridgePage = this.bridgePages.get(bridgeKey);
    if ((existingPage !== undefined && existingPage.bridgeId !== input.bridgeId) || (existingBridgePage !== undefined && existingBridgePage !== input.notionPageId)) {
      throw new Error("Page registration conflict");
    }
    this.pages.set(pageKey, { installationId: input.installationId, pageId: input.notionPageId, bridgeId: input.bridgeId });
    this.bridgePages.set(bridgeKey, input.notionPageId);
  }

  async deletePageRegistration(input: {
    readonly installationId: string;
    readonly notionPageId: string;
    readonly bridgeId: string;
  }): Promise<void> {
    const pageKey = eventKey(input.installationId, input.notionPageId);
    const current = this.pages.get(pageKey);
    if (current === undefined || current.bridgeId !== input.bridgeId) return;
    this.pages.delete(pageKey);
    this.bridgePages.delete(eventKey(input.installationId, input.bridgeId));
  }

  async findBridgeId(installationId: string, notionPageId: string): Promise<string | null> {
    return this.pages.get(eventKey(installationId, notionPageId))?.bridgeId ?? null;
  }

  async readRateCounter(installationId: string, counter: RateCounterName): Promise<RateCounterState> {
    return this.counters.get(counterKey(installationId, counter)) ?? { windowStartedAt: NOW.toISOString(), count: 0 };
  }

  async compareAndSetRateCounter(input: {
    readonly installationId: string;
    readonly counter: RateCounterName;
    readonly expected: RateCounterState;
    readonly next: RateCounterState;
  }): Promise<boolean> {
    const key = counterKey(input.installationId, input.counter);
    const current = this.counters.get(key) ?? { windowStartedAt: NOW.toISOString(), count: 0 };
    if (current.windowStartedAt !== input.expected.windowStartedAt || current.count !== input.expected.count) return false;
    this.counters.set(key, { ...input.next });
    return true;
  }

  seedRateWindow(installationId: string, count: number, startedAt = NOW): void {
    this.counters.set(counterKey(installationId, "api"), { count, windowStartedAt: startedAt.toISOString() });
  }

  pageRows(): ReadonlyArray<{ readonly installationId: string; readonly pageId: string; readonly bridgeId: string }> {
    return [...this.pages.values()].sort((left, right) => left.pageId.localeCompare(right.pageId));
  }
}

interface MutableInstallation extends BridgeApiInstallation {
  relayTokenHash: string;
  pendingRelayTokenHash: string | null;
  pendingRelayTokenExpiresAt: string | null;
  bootstrapPublicJwk: JsonWebKey | null;
  pendingWebhookTokenCiphertext: string | null;
}

class MemoryInstallations implements BridgeApiInstallations {
  private readonly installations = new Map<string, MutableInstallation>();

  constructor(rows: readonly MutableInstallation[]) {
    for (const row of rows) this.installations.set(row.id, { ...row });
  }

  async findByRelayTokenHash(tokenHash: string): Promise<BridgeApiInstallation | null> {
    for (const installation of this.installations.values()) {
      if (installation.relayTokenHash === tokenHash || installation.pendingRelayTokenHash === tokenHash) return { ...installation };
    }
    return null;
  }

  async prepareRelayTokenRotation(input: {
    readonly installationId: string;
    readonly expectedActiveTokenHash: string;
    readonly pendingTokenHash: string;
    readonly expiresAt: string;
  }): Promise<boolean> {
    const installation = this.installations.get(input.installationId);
    if (installation === undefined || installation.relayTokenHash !== input.expectedActiveTokenHash) return false;
    installation.pendingRelayTokenHash = input.pendingTokenHash;
    installation.pendingRelayTokenExpiresAt = input.expiresAt;
    return true;
  }

  async commitRelayTokenRotation(input: {
    readonly installationId: string;
    readonly expectedPendingTokenHash: string;
    readonly now: Date;
  }): Promise<boolean> {
    const installation = this.installations.get(input.installationId);
    if (
      installation === undefined ||
      installation.pendingRelayTokenHash !== input.expectedPendingTokenHash ||
      installation.pendingRelayTokenExpiresAt === null ||
      new Date(installation.pendingRelayTokenExpiresAt).getTime() <= input.now.getTime()
    ) {
      return false;
    }
    installation.relayTokenHash = input.expectedPendingTokenHash;
    installation.pendingRelayTokenHash = null;
    installation.pendingRelayTokenExpiresAt = null;
    return true;
  }

  async cancelRelayTokenRotation(input: {
    readonly installationId: string;
    readonly expectedActiveTokenHash: string;
  }): Promise<boolean> {
    const installation = this.installations.get(input.installationId);
    if (installation === undefined || installation.relayTokenHash !== input.expectedActiveTokenHash) return false;
    installation.pendingRelayTokenHash = null;
    installation.pendingRelayTokenExpiresAt = null;
    return true;
  }

  async clearBootstrapMaterial(input: { readonly installationId: string; readonly expectedCiphertext: string }): Promise<boolean> {
    const installation = this.installations.get(input.installationId);
    if (installation === undefined || installation.pendingWebhookTokenCiphertext !== input.expectedCiphertext) return false;
    installation.bootstrapPublicJwk = null;
    installation.pendingWebhookTokenCiphertext = null;
    return true;
  }

  bootstrapFields(installationId = INSTALLATION_ID): { readonly publicJwk: JsonWebKey | null; readonly ciphertext: string | null } {
    const installation = this.installations.get(installationId);
    if (installation === undefined) throw new Error("Unknown fixture installation");
    return { publicJwk: installation.bootstrapPublicJwk, ciphertext: installation.pendingWebhookTokenCiphertext };
  }
}

class FixtureLogger implements SafeBridgeApiLogger {
  readonly entries: string[] = [];

  write(code: string): void {
    this.entries.push(code);
  }
}

interface Harness {
  readonly clock: FixtureClock;
  readonly store: MemoryEventStore;
  readonly events: EventRepository;
  readonly installations: MemoryInstallations;
  readonly logs: FixtureLogger;
  readonly deps: BridgeApiDependencies;
}

async function harness(): Promise<Harness> {
  const clock = new FixtureClock(NOW);
  const store = new MemoryEventStore();
  const events = new EventRepository(store);
  const installations = new MemoryInstallations([
    {
      id: INSTALLATION_ID,
      relayTokenHash: await hmacBase64url(RELAY_TOKEN_PEPPER, RELAY_TOKEN),
      pendingRelayTokenHash: null,
      pendingRelayTokenExpiresAt: null,
      bootstrapPublicJwk: { kty: "RSA", n: "fixture-public-modulus", e: "AQAB" },
      pendingWebhookTokenCiphertext: ENCRYPTED_WEBHOOK_TOKEN,
    },
    {
      id: SECOND_INSTALLATION_ID,
      relayTokenHash: await hmacBase64url(RELAY_TOKEN_PEPPER, SECOND_RELAY_TOKEN),
      pendingRelayTokenHash: null,
      pendingRelayTokenExpiresAt: null,
      bootstrapPublicJwk: null,
      pendingWebhookTokenCiphertext: null,
    },
  ]);
  const logs = new FixtureLogger();
  return {
    clock,
    store,
    events,
    installations,
    logs,
    deps: {
      events,
      installations,
      verificationToken: async (installationId) => (installationId === INSTALLATION_ID ? FIXTURE_VERIFICATION_TOKEN : null),
      relayTokenPepper: RELAY_TOKEN_PEPPER,
      clock,
      crypto: globalThis.crypto,
      log: logs,
    },
  };
}

function apiRequest(
  path: string,
  bearer: string,
  body?: unknown,
  options: { readonly method?: string; readonly contentType?: string } = {},
): Request {
  const headers = new Headers({ authorization: "Bearer " + bearer });
  if (body !== undefined) headers.set("content-type", options.contentType ?? "application/json");
  return new Request("https://fixture.invalid" + path, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function activationProof(installationId = INSTALLATION_ID): Promise<string> {
  return hmacBase64url(FIXTURE_VERIFICATION_TOKEN, "grandbox-bridge:webhook-activate:v1\0" + installationId);
}

describe("handleBridgeApi", () => {
  it("scopes claims and acknowledgements to the bearer-token installation", async () => {
    const fixture = await harness();
    await fixture.events.enqueue(INSTALLATION_ID, SAFE_EVENT, NOW);
    await fixture.events.enqueue(
      SECOND_INSTALLATION_ID,
      { ...SAFE_EVENT, id: SECOND_EVENT_ID, entityId: SECOND_PAGE_ID },
      NOW,
    );

    const claim = await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-a", limit: 50 }), fixture.deps);
    expect(claim.status).toBe(200);
    expect(await claim.json()).toEqual({ events: [SAFE_EVENT], leaseSeconds: 60 });
    expect((await handleBridgeApi(apiRequest("/v1/events/claim", token(9), { workerId: "worker-a", limit: 1 }), fixture.deps)).status).toBe(401);

    const otherClaim = await handleBridgeApi(
      apiRequest("/v1/events/claim", SECOND_RELAY_TOKEN, { workerId: "worker-b", limit: 1 }),
      fixture.deps,
    );
    expect(await otherClaim.json()).toEqual({
      events: [{ ...SAFE_EVENT, id: SECOND_EVENT_ID, entityId: SECOND_PAGE_ID }],
      leaseSeconds: 60,
    });

    expect(
      (
        await handleBridgeApi(
          apiRequest("/v1/events/ack", RELAY_TOKEN, { workerId: "worker-b", eventIds: [SAFE_EVENT.id] }),
          fixture.deps,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await handleBridgeApi(
          apiRequest("/v1/events/ack", RELAY_TOKEN, { workerId: "worker-a", eventIds: [SAFE_EVENT.id] }),
          fixture.deps,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await handleBridgeApi(
          apiRequest("/v1/events/ack", RELAY_TOKEN, { workerId: "worker-a", eventIds: [SAFE_EVENT.id] }),
          fixture.deps,
        )
      ).status,
    ).toBe(204);
  });

  it("releases an expired lease to a different worker without exposing lease metadata", async () => {
    const fixture = await harness();
    await fixture.events.enqueue(INSTALLATION_ID, SAFE_EVENT, NOW);

    expect(
      await (
        await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-a", limit: 1 }), fixture.deps)
      ).json(),
    ).toEqual({ events: [SAFE_EVENT], leaseSeconds: 60 });
    fixture.clock.set(plusSeconds(NOW, 61));
    expect(
      await (
        await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-b", limit: 1 }), fixture.deps)
      ).json(),
    ).toEqual({ events: [SAFE_EVENT], leaseSeconds: 60 });
  });

  it("rejects an acknowledgement after its lease expires and lets another worker reclaim the event", async () => {
    const fixture = await harness();
    await fixture.events.enqueue(INSTALLATION_ID, SAFE_EVENT, NOW);
    await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-a", limit: 1 }), fixture.deps);

    fixture.clock.set(plusSeconds(NOW, 61));
    expect(
      (
        await handleBridgeApi(
          apiRequest("/v1/events/ack", RELAY_TOKEN, { workerId: "worker-a", eventIds: [SAFE_EVENT.id] }),
          fixture.deps,
        )
      ).status,
    ).toBe(409);
    expect(
      await (
        await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-b", limit: 1 }), fixture.deps)
      ).json(),
    ).toEqual({ events: [SAFE_EVENT], leaseSeconds: 60 });
  });

  it("does not partially acknowledge a multi-event request when one lease conflicts", async () => {
    const fixture = await harness();
    const secondEvent = { ...SAFE_EVENT, id: SECOND_EVENT_ID, entityId: SECOND_PAGE_ID };
    await fixture.events.enqueue(INSTALLATION_ID, SAFE_EVENT, NOW);
    await fixture.events.enqueue(INSTALLATION_ID, secondEvent, NOW);
    await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-a", limit: 1 }), fixture.deps);
    await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-b", limit: 1 }), fixture.deps);

    expect(
      (
        await handleBridgeApi(
          apiRequest("/v1/events/ack", RELAY_TOKEN, { workerId: "worker-a", eventIds: [SAFE_EVENT.id, secondEvent.id] }),
          fixture.deps,
        )
      ).status,
    ).toBe(409);
    expect((await fixture.store.listEvents(INSTALLATION_ID)).find((event) => event.id === SAFE_EVENT.id)?.consumedAt).toBeNull();
  });

  it("registers and unregisters only technical page routing metadata", async () => {
    const fixture = await harness();

    expect(
      (
        await handleBridgeApi(apiRequest("/v1/pages/register", RELAY_TOKEN, { pageId: PAGE_ID, bridgeId: BRIDGE_ID }), fixture.deps)
      ).status,
    ).toBe(204);
    expect(fixture.store.pageRows()).toEqual([{ installationId: INSTALLATION_ID, pageId: PAGE_ID, bridgeId: BRIDGE_ID }]);
    expect(
      (
        await handleBridgeApi(apiRequest("/v1/pages/unregister", RELAY_TOKEN, { pageId: PAGE_ID, bridgeId: BRIDGE_ID }), fixture.deps)
      ).status,
    ).toBe(204);
    expect(fixture.store.pageRows()).toEqual([]);
    expect(
      (
        await handleBridgeApi(apiRequest("/v1/pages/unregister", RELAY_TOKEN, { pageId: PAGE_ID, bridgeId: BRIDGE_ID }), fixture.deps)
      ).status,
    ).toBe(204);
  });

  it("rotates a relay token through recoverable prepare, commit, and cancel phases", async () => {
    const fixture = await harness();

    expect(
      (
        await handleBridgeApi(
          apiRequest("/v1/auth/rotate/prepare", RELAY_TOKEN, { newToken: NEXT_RELAY_TOKEN }),
          fixture.deps,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await handleBridgeApi(apiRequest("/v1/events/claim", NEXT_RELAY_TOKEN, { workerId: "worker-a", limit: 1 }), fixture.deps)
      ).status,
    ).toBe(200);
    expect(
      (
        await handleBridgeApi(
          apiRequest("/v1/auth/rotate/prepare", NEXT_RELAY_TOKEN, { newToken: token(4) }),
          fixture.deps,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleBridgeApi(apiRequest("/v1/auth/rotate/commit", NEXT_RELAY_TOKEN, {}), fixture.deps)
      ).status,
    ).toBe(204);
    expect(
      (
        await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-a", limit: 1 }), fixture.deps)
      ).status,
    ).toBe(401);
    expect(
      (
        await handleBridgeApi(apiRequest("/v1/events/claim", NEXT_RELAY_TOKEN, { workerId: "worker-a", limit: 1 }), fixture.deps)
      ).status,
    ).toBe(200);

    expect(
      (
        await handleBridgeApi(
          apiRequest("/v1/auth/rotate/prepare", NEXT_RELAY_TOKEN, { newToken: token(4) }),
          fixture.deps,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await handleBridgeApi(apiRequest("/v1/auth/rotate/cancel", NEXT_RELAY_TOKEN, {}), fixture.deps)
      ).status,
    ).toBe(204);
    expect(
      (
        await handleBridgeApi(apiRequest("/v1/events/claim", token(4), { workerId: "worker-a", limit: 1 }), fixture.deps)
      ).status,
    ).toBe(401);
  });

  it("returns only encrypted bootstrap material and clears it after an installation-bound proof", async () => {
    const fixture = await harness();

    const pending = await handleBridgeApi(apiRequest("/v1/bootstrap/webhook-token", RELAY_TOKEN), fixture.deps);
    expect(pending.status).toBe(200);
    expect(await pending.clone().json()).toEqual({ ciphertext: ENCRYPTED_WEBHOOK_TOKEN });
    expect(await pending.text()).not.toContain(FIXTURE_VERIFICATION_TOKEN);
    expect(
      (
        await handleBridgeApi(
          apiRequest("/v1/bootstrap/activate", RELAY_TOKEN, { proof: await activationProof() }),
          fixture.deps,
        )
      ).status,
    ).toBe(204);
    expect(fixture.installations.bootstrapFields()).toEqual({ publicJwk: null, ciphertext: null });
  });

  it("rejects invalid bootstrap proofs without clearing ciphertext", async () => {
    const fixture = await harness();

    expect(
      (
        await handleBridgeApi(apiRequest("/v1/bootstrap/activate", RELAY_TOKEN, { proof: base64url(new Uint8Array(32)) }), fixture.deps)
      ).status,
    ).toBe(401);
    expect(fixture.installations.bootstrapFields()).toEqual({
      publicJwk: { kty: "RSA", n: "fixture-public-modulus", e: "AQAB" },
      ciphertext: ENCRYPTED_WEBHOOK_TOKEN,
    });
  });

  it("rejects invalid bounded input and preserves leases when the API window is exhausted", async () => {
    const fixture = await harness();
    await fixture.events.enqueue(INSTALLATION_ID, SAFE_EVENT, NOW);

    expect(
      (
        await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-a", limit: 51 }), fixture.deps)
      ).status,
    ).toBe(400);
    expect(
      (
        await handleBridgeApi(
          apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-a", limit: 1, extra: "ignored-never" }),
          fixture.deps,
        )
      ).status,
    ).toBe(400);

    fixture.store.seedRateWindow(INSTALLATION_ID, 120);
    const throttled = await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-a", limit: 1 }), fixture.deps);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("60");
    expect((await fixture.store.listEvents(INSTALLATION_ID))[0]?.leaseOwner).toBeNull();

    fixture.clock.set(plusSeconds(NOW, 61));
    expect(
      await (
        await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-a", limit: 1 }), fixture.deps)
      ).json(),
    ).toEqual({ events: [SAFE_EVENT], leaseSeconds: 60 });
  });

  it("atomically admits only 120 authenticated API requests and recovers in the next fixed window", async () => {
    const fixture = await harness();

    const statuses = await Promise.all(
      Array.from({ length: 121 }, () =>
        handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-a", limit: 1 }), fixture.deps).then(
          (response) => response.status,
        ),
      ),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(120);
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);

    fixture.clock.set(plusSeconds(NOW, 61));
    expect(
      (
        await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, { workerId: "worker-a", limit: 1 }), fixture.deps)
      ).status,
    ).toBe(200);
  });

  it("keeps request tokens, hashes, proofs, and payloads out of safe diagnostic logs", async () => {
    const fixture = await harness();
    const rawPayload = JSON.stringify({ workerId: "worker-a", limit: 1, privateNote: "fixture-private-note" });

    expect((await handleBridgeApi(apiRequest("/v1/events/claim", RELAY_TOKEN, rawPayload), fixture.deps)).status).toBe(400);
    expect((await handleBridgeApi(apiRequest("/v1/events/claim", token(9), { workerId: "worker-a", limit: 1 }), fixture.deps)).status).toBe(401);
    const observed = fixture.logs.entries.join(" ");
    expect(observed).not.toContain(RELAY_TOKEN);
    expect(observed).not.toContain(RELAY_TOKEN_PEPPER);
    expect(observed).not.toContain(FIXTURE_VERIFICATION_TOKEN);
    expect(observed).not.toContain("fixture-private-note");
  });
});
