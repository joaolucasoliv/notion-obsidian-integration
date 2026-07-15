import { base64url, fromBase64url } from "@grandbox-bridge/shared";
import { authenticateRequestBearer } from "../auth/bearer.ts";
import { constantTimeEqual, utf8 } from "../auth/hmac.ts";
import { boundedRetryAfterSeconds, isJsonContentType, readBodyAtMost } from "../auth/limits.ts";
import {
  badRequest,
  conflict,
  forbidden,
  internalServerError,
  jsonResponse,
  methodNotAllowed,
  noContent,
  notFound,
  payloadTooLarge,
  tooManyRequests,
  unauthorized,
  unsupportedMediaType,
} from "../http/response.ts";
import { bridgeApiRoute, type BridgeApiRoute } from "../http/router.ts";
import { EventRepository, type StoredWebhookEvent } from "./repository.ts";
import {
  handleAuthenticatedSnapshotUpload,
  handlePublicGraphRead,
  publicGraphNotFound,
  type SafeSnapshotLogCode,
  type SnapshotApiDependencies,
} from "../snapshot/handler.ts";
import { SnapshotRepository } from "../snapshot/repository.ts";

const API_BODY_BYTES = 16 * 1024;
const API_RATE_LIMIT = 120;
const API_RATE_WINDOW_SECONDS = 60;
const LEASE_SECONDS = 60;
const ROTATION_SECONDS = 10 * 60;
const TOKEN_BYTES = 32;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_TYPE = /^[a-z][a-z0-9._-]{0,127}$/;
const ACTIVATION_CONTEXT = "grandbox-bridge:webhook-activate:v1\0";
const decoder = new TextDecoder("utf-8", { fatal: true });

export type SafeBridgeApiLogCode =
  | "api_unauthorized"
  | "api_malformed"
  | "api_rate_limited"
  | "api_ack_conflict"
  | "api_state_conflict"
  | "api_internal_error"
  | SafeSnapshotLogCode;

export interface BridgeApiClock {
  now(): Date;
}

/**
 * Installation state intentionally contains only server-side digest metadata
 * and bootstrap ciphertext. It never carries a relay token or plaintext
 * webhook verification token.
 */
export interface BridgeApiInstallation {
  readonly id: string;
  readonly graphId: string;
  readonly relayTokenHash: string;
  readonly pendingRelayTokenHash: string | null;
  readonly pendingRelayTokenExpiresAt: string | null;
  readonly bootstrapPublicJwk: JsonWebKey | null;
  readonly pendingWebhookTokenCiphertext: string | null;
}

/** A service-role adapter supplies installation-scoped atomic mutations. */
export interface BridgeApiInstallations {
  findByRelayTokenHash(tokenHash: string): Promise<BridgeApiInstallation | null>;
  prepareRelayTokenRotation(input: {
    readonly installationId: string;
    readonly expectedActiveTokenHash: string;
    readonly pendingTokenHash: string;
    readonly expiresAt: string;
    readonly now: Date;
  }): Promise<"prepared" | "idempotent" | "conflict">;
  commitRelayTokenRotation(input: {
    readonly installationId: string;
    readonly expectedPendingTokenHash: string;
    readonly now: Date;
  }): Promise<boolean>;
  cancelRelayTokenRotation(input: {
    readonly installationId: string;
    readonly expectedActiveTokenHash: string;
    readonly expectedPendingTokenHash: string;
    readonly now: Date;
  }): Promise<boolean>;
  clearBootstrapMaterial(input: { readonly installationId: string; readonly expectedCiphertext: string }): Promise<boolean>;
}

export interface SafeBridgeApiLogger {
  write(code: SafeBridgeApiLogCode): void;
}

export interface BridgeApiDependencies {
  readonly events: EventRepository;
  readonly snapshots: SnapshotRepository;
  readonly installations: BridgeApiInstallations;
  readonly verificationToken: (installationId: string) => Promise<string | null>;
  readonly relayTokenPepper: string;
  readonly clock: BridgeApiClock;
  readonly crypto: Crypto;
  readonly log: SafeBridgeApiLogger;
}

interface AuthenticatedInstallation {
  readonly installation: BridgeApiInstallation;
  readonly kind: "active" | "pending";
  readonly tokenHash: string;
  readonly tokenHashBytes: Uint8Array;
}

type AuthenticatedBridgeApiRoute = Exclude<BridgeApiRoute, "graph-read" | "graph-read-invalid">;

interface ClaimInput {
  readonly workerId: string;
  readonly limit: number;
}

interface AckInput {
  readonly workerId: string;
  readonly eventIds: readonly string[];
}

interface PageInput {
  readonly pageId: string;
  readonly bridgeId: string;
}

interface RotationInput {
  readonly newToken: string;
}

interface CancelRotationInput {
  readonly pendingToken: string;
}

interface ActivationInput {
  readonly proof: string;
}

interface SafeEvent {
  readonly id: string;
  readonly type: string;
  readonly entityId: string;
  readonly eventAt: string;
}

function toWebArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function logSafely(log: SafeBridgeApiLogger, code: SafeBridgeApiLogCode): void {
  try {
    log.write(code);
  } catch {
    // Diagnostic output is never part of the API security boundary.
  }
}

function snapshotDependencies(deps: BridgeApiDependencies): SnapshotApiDependencies {
  return { snapshots: deps.snapshots, clock: deps.clock, log: deps.log };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (value[index] === " " || value[index] === "\t" || value[index] === "\n" || value[index] === "\r") index += 1;
  return index;
}

function skipJsonString(value: string, start: number): number {
  if (value[start] !== '"') return -1;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') return index + 1;
    if (character === "\\") {
      index += 1;
      if (index >= value.length) return -1;
    }
  }
  return -1;
}

function skipJsonValue(value: string, start: number): number {
  const first = value[start];
  if (first === '"') return skipJsonString(value, start);
  if (first !== "{" && first !== "[") {
    let index = start;
    while (index < value.length && value[index] !== "," && value[index] !== "}" && value[index] !== "]") index += 1;
    return index;
  }

  const stack: string[] = [first === "{" ? "}" : "]"];
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      const next = skipJsonString(value, index);
      if (next < 0) return -1;
      index = next - 1;
      continue;
    }
    if (character === "{") stack.push("}");
    else if (character === "[") stack.push("]");
    else if (character === "}" || character === "]") {
      if (stack.pop() !== character) return -1;
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

/** JSON.parse silently overwrites duplicate keys, so reject those before applying exact schemas. */
function hasUniqueTopLevelKeys(raw: string): boolean {
  let index = skipWhitespace(raw, 0);
  if (raw[index] !== "{") return false;
  index = skipWhitespace(raw, index + 1);
  if (raw[index] === "}") return skipWhitespace(raw, index + 1) === raw.length;

  const keys = new Set<string>();
  while (index < raw.length) {
    const keyStart = index;
    index = skipJsonString(raw, index);
    if (index < 0) return false;
    let key: unknown;
    try {
      key = JSON.parse(raw.slice(keyStart, index));
    } catch {
      return false;
    }
    if (typeof key !== "string" || keys.has(key)) return false;
    keys.add(key);
    index = skipWhitespace(raw, index);
    if (raw[index] !== ":") return false;
    index = skipWhitespace(raw, index + 1);
    index = skipJsonValue(raw, index);
    if (index < 0) return false;
    index = skipWhitespace(raw, index);
    if (raw[index] === "}") return skipWhitespace(raw, index + 1) === raw.length;
    if (raw[index] !== ",") return false;
    index = skipWhitespace(raw, index + 1);
  }
  return false;
}

function parseJsonRecord(raw: Uint8Array): Record<string, unknown> | null {
  let text: string;
  let value: unknown;
  try {
    text = decoder.decode(raw);
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(value) && hasUniqueTopLevelKeys(text) ? value : null;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function workerId(value: unknown): string | null {
  return typeof value === "string" && WORKER_ID.test(value) ? value : null;
}

function relayToken(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 43) return null;
  try {
    return fromBase64url(value).byteLength === TOKEN_BYTES ? value : null;
  } catch {
    return null;
  }
}

function decodeDigest(value: string | null): Uint8Array {
  if (typeof value !== "string") return new Uint8Array(TOKEN_BYTES);
  try {
    const decoded = fromBase64url(value);
    return decoded.byteLength === TOKEN_BYTES ? decoded : new Uint8Array(TOKEN_BYTES);
  } catch {
    return new Uint8Array(TOKEN_BYTES);
  }
}

function sameDigest(left: Uint8Array, right: string | null): boolean {
  return constantTimeEqual(left, decodeDigest(right));
}

function parseClaimInput(record: Record<string, unknown>): ClaimInput | null {
  if (!hasExactKeys(record, ["workerId", "limit"])) return null;
  const worker = workerId(record.workerId);
  const limit = record.limit;
  return worker !== null && Number.isSafeInteger(limit) && typeof limit === "number" && limit >= 1 && limit <= 50
    ? { workerId: worker, limit }
    : null;
}

function parseAckInput(record: Record<string, unknown>): AckInput | null {
  if (!hasExactKeys(record, ["workerId", "eventIds"])) return null;
  const worker = workerId(record.workerId);
  const ids = record.eventIds;
  if (worker === null || !Array.isArray(ids) || ids.length < 1 || ids.length > 50) return null;
  const eventIds = ids.map(uuid);
  if (eventIds.some((id) => id === null)) return null;
  const typedIds = eventIds as string[];
  return new Set(typedIds).size === typedIds.length ? { workerId: worker, eventIds: typedIds } : null;
}

function parsePageInput(record: Record<string, unknown>): PageInput | null {
  if (!hasExactKeys(record, ["pageId", "bridgeId"])) return null;
  const pageId = uuid(record.pageId);
  const bridgeId = uuid(record.bridgeId);
  return pageId !== null && bridgeId !== null ? { pageId, bridgeId } : null;
}

function parseRotationInput(record: Record<string, unknown>): RotationInput | null {
  if (!hasExactKeys(record, ["newToken"])) return null;
  const newToken = relayToken(record.newToken);
  return newToken === null ? null : { newToken };
}

function parseCancelRotationInput(record: Record<string, unknown>): CancelRotationInput | null {
  if (!hasExactKeys(record, ["pendingToken"])) return null;
  const pendingToken = relayToken(record.pendingToken);
  return pendingToken === null ? null : { pendingToken };
}

function parseActivationInput(record: Record<string, unknown>): ActivationInput | null {
  if (!hasExactKeys(record, ["proof"])) return null;
  const proof = relayToken(record.proof);
  return proof === null ? null : { proof };
}

function parseEmptyInput(record: Record<string, unknown>): boolean {
  return hasExactKeys(record, []);
}

async function hmacSha256(key: string, message: string, crypto: Crypto): Promise<Uint8Array> {
  if (typeof key !== "string" || key.length === 0 || !crypto.subtle) throw new Error("Invalid server HMAC configuration");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toWebArrayBuffer(utf8(key)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, toWebArrayBuffer(utf8(message))));
}

async function authenticateRelayToken(
  bearer: string,
  now: Date,
  deps: BridgeApiDependencies,
): Promise<AuthenticatedInstallation | null> {
  const parsedToken = relayToken(bearer);
  if (parsedToken === null) return null;
  const tokenHashBytes = await hmacSha256(deps.relayTokenPepper, parsedToken, deps.crypto);
  const tokenHash = base64url(tokenHashBytes);
  const installation = await deps.installations.findByRelayTokenHash(tokenHash);
  if (installation === null) return null;

  const active = sameDigest(tokenHashBytes, installation.relayTokenHash);
  const pendingMatches = sameDigest(tokenHashBytes, installation.pendingRelayTokenHash);
  const pendingExpiresAt = installation.pendingRelayTokenExpiresAt === null ? Number.NaN : new Date(installation.pendingRelayTokenExpiresAt).getTime();
  const pending = pendingMatches && Number.isFinite(pendingExpiresAt) && pendingExpiresAt > now.getTime();
  if (!active && !pending) return null;
  return { installation, kind: active ? "active" : "pending", tokenHash, tokenHashBytes };
}

async function enforceApiLimit(
  authenticated: AuthenticatedInstallation,
  now: Date,
  deps: BridgeApiDependencies,
): Promise<Response | null> {
  const rate = await deps.events.incrementRateCounter(
    authenticated.installation.id,
    "api",
    now,
    API_RATE_LIMIT,
    API_RATE_WINDOW_SECONDS,
  );
  if (rate.allowed) return null;
  logSafely(deps.log, "api_rate_limited");
  return tooManyRequests(boundedRetryAfterSeconds(rate.windowStartedAt, now, API_RATE_WINDOW_SECONDS));
}

function projectSafeEvent(event: StoredWebhookEvent): SafeEvent | null {
  const eventAt = new Date(event.eventAt).getTime();
  if (!UUID.test(event.id) || !EVENT_TYPE.test(event.type) || !UUID.test(event.entityId) || !Number.isFinite(eventAt)) return null;
  return { id: event.id, type: event.type, entityId: event.entityId, eventAt: new Date(eventAt).toISOString() };
}

async function readPostRecord(request: Request): Promise<{ readonly kind: "record"; readonly value: Record<string, unknown> } | { readonly kind: "too-large" } | { readonly kind: "malformed" }> {
  const raw = await readBodyAtMost(request, API_BODY_BYTES);
  if (raw === null) return { kind: "too-large" };
  const record = parseJsonRecord(raw);
  return record === null ? { kind: "malformed" } : { kind: "record", value: record };
}

async function handleClaim(input: ClaimInput, authenticated: AuthenticatedInstallation, now: Date, deps: BridgeApiDependencies): Promise<Response> {
  await deps.events.cleanupConsumed(authenticated.installation.id, now);
  const claimed = await deps.events.claim(authenticated.installation.id, input.workerId, now, LEASE_SECONDS, input.limit);
  const events = claimed.map(projectSafeEvent);
  if (events.some((event) => event === null)) throw new Error("Unsafe stored webhook event");
  return jsonResponse({ events, leaseSeconds: LEASE_SECONDS });
}

async function handleAck(input: AckInput, authenticated: AuthenticatedInstallation, now: Date, deps: BridgeApiDependencies): Promise<Response> {
  try {
    await deps.events.acknowledgeMany(authenticated.installation.id, input.eventIds, input.workerId, now);
    return noContent();
  } catch {
    logSafely(deps.log, "api_ack_conflict");
    return conflict();
  }
}

async function handlePage(
  route: "pages-register" | "pages-unregister",
  input: PageInput,
  authenticated: AuthenticatedInstallation,
  deps: BridgeApiDependencies,
): Promise<Response> {
  try {
    if (route === "pages-register") {
      await deps.events.registerPage(authenticated.installation.id, input.pageId, input.bridgeId);
    } else {
      await deps.events.unregisterPage(authenticated.installation.id, input.pageId, input.bridgeId);
    }
    return noContent();
  } catch {
    logSafely(deps.log, "api_state_conflict");
    return conflict();
  }
}

async function handleRotation(
  route: "auth-rotate-prepare" | "auth-rotate-commit" | "auth-rotate-cancel",
  input: Record<string, unknown>,
  authenticated: AuthenticatedInstallation,
  now: Date,
  deps: BridgeApiDependencies,
): Promise<Response> {
  if (route === "auth-rotate-prepare") {
    if (authenticated.kind !== "active") return forbidden();
    const parsed = parseRotationInput(input);
    if (parsed === null) return badRequest();
    const nextHashBytes = await hmacSha256(deps.relayTokenPepper, parsed.newToken, deps.crypto);
    if (sameDigest(nextHashBytes, authenticated.installation.relayTokenHash)) {
      return conflict();
    }
    const prepared = await deps.installations.prepareRelayTokenRotation({
      installationId: authenticated.installation.id,
      expectedActiveTokenHash: authenticated.tokenHash,
      pendingTokenHash: base64url(nextHashBytes),
      expiresAt: new Date(now.getTime() + ROTATION_SECONDS * 1_000).toISOString(),
      now,
    });
    if (prepared === "prepared" || prepared === "idempotent") return noContent();
    logSafely(deps.log, "api_state_conflict");
    return conflict();
  }

  if (route === "auth-rotate-commit") {
    if (!parseEmptyInput(input)) return badRequest();
    if (authenticated.kind !== "pending") return forbidden();
    const committed = await deps.installations.commitRelayTokenRotation({
      installationId: authenticated.installation.id,
      expectedPendingTokenHash: authenticated.tokenHash,
      now,
    });
    if (committed) return noContent();
    logSafely(deps.log, "api_state_conflict");
    return conflict();
  }

  const parsed = parseCancelRotationInput(input);
  if (parsed === null) return badRequest();
  if (authenticated.kind !== "active") return forbidden();
  const pendingTokenHash = base64url(await hmacSha256(deps.relayTokenPepper, parsed.pendingToken, deps.crypto));
  const cancelled = await deps.installations.cancelRelayTokenRotation({
    installationId: authenticated.installation.id,
    expectedActiveTokenHash: authenticated.tokenHash,
    expectedPendingTokenHash: pendingTokenHash,
    now,
  });
  if (cancelled) return noContent();
  logSafely(deps.log, "api_state_conflict");
  return conflict();
}

async function handleBootstrap(
  route: "bootstrap-webhook-token" | "bootstrap-activate",
  input: Record<string, unknown> | null,
  authenticated: AuthenticatedInstallation,
  deps: BridgeApiDependencies,
): Promise<Response> {
  const ciphertext = authenticated.installation.pendingWebhookTokenCiphertext;
  if (route === "bootstrap-webhook-token") {
    return ciphertext === null ? notFound() : jsonResponse({ ciphertext });
  }
  if (input === null) return badRequest();
  const parsed = parseActivationInput(input);
  if (parsed === null || ciphertext === null) return parsed === null ? badRequest() : notFound();
  const verificationToken = await deps.verificationToken(authenticated.installation.id);
  if (verificationToken === null) {
    logSafely(deps.log, "api_state_conflict");
    return conflict();
  }
  const supplied = decodeDigest(parsed.proof);
  const expected = await hmacSha256(verificationToken, ACTIVATION_CONTEXT + authenticated.installation.id, deps.crypto);
  if (!constantTimeEqual(expected, supplied)) {
    logSafely(deps.log, "api_unauthorized");
    return unauthorized();
  }
  if (await deps.installations.clearBootstrapMaterial({ installationId: authenticated.installation.id, expectedCiphertext: ciphertext })) {
    return noContent();
  }
  logSafely(deps.log, "api_state_conflict");
  return conflict();
}

async function handleAuthenticatedRoute(
  route: AuthenticatedBridgeApiRoute,
  request: Request,
  authenticated: AuthenticatedInstallation,
  now: Date,
  deps: BridgeApiDependencies,
): Promise<Response> {
  if (route === "snapshot-upload") {
    return handleAuthenticatedSnapshotUpload(
      request,
      { installationId: authenticated.installation.id, graphId: authenticated.installation.graphId },
      snapshotDependencies(deps),
    );
  }
  const isGet = route === "bootstrap-webhook-token";
  const parsedBody = isGet ? null : await readPostRecord(request);
  if (parsedBody?.kind === "too-large") {
    logSafely(deps.log, "api_malformed");
    return payloadTooLarge();
  }
  if (parsedBody?.kind === "malformed") {
    logSafely(deps.log, "api_malformed");
    return badRequest();
  }
  const body = parsedBody?.value ?? null;

  switch (route) {
    case "events-claim": {
      const input = body === null ? null : parseClaimInput(body);
      return input === null ? badRequest() : handleClaim(input, authenticated, now, deps);
    }
    case "events-ack": {
      const input = body === null ? null : parseAckInput(body);
      return input === null ? badRequest() : handleAck(input, authenticated, now, deps);
    }
    case "pages-register":
    case "pages-unregister": {
      const input = body === null ? null : parsePageInput(body);
      return input === null ? badRequest() : handlePage(route, input, authenticated, deps);
    }
    case "auth-rotate-prepare":
    case "auth-rotate-commit":
    case "auth-rotate-cancel":
      return body === null ? badRequest() : handleRotation(route, body, authenticated, now, deps);
    case "bootstrap-webhook-token":
      return handleBootstrap(route, null, authenticated, deps);
    case "bootstrap-activate":
      return handleBootstrap(route, body, authenticated, deps);
  }
}

/**
 * Handles only the explicit relay API surface. Each request authenticates to a
 * single installation; no client-provided installation ID is accepted.
 */
export async function handleBridgeApi(request: Request, deps: BridgeApiDependencies): Promise<Response> {
  try {
    const definition = bridgeApiRoute(request);
    if (definition === null) return notFound();
    if (definition.route === "graph-read-invalid") return publicGraphNotFound();
    if (definition.route === "graph-read") {
      if (definition.graphId === undefined) return notFound();
      return handlePublicGraphRead(request, definition.graphId, snapshotDependencies(deps));
    }

    const now = deps.clock.now();
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid injected clock");
    const authenticated = await authenticateRequestBearer(request, {
      authenticate: (bearer) => authenticateRelayToken(bearer, now, deps),
    });
    if (authenticated === null) {
      logSafely(deps.log, "api_unauthorized");
      return unauthorized();
    }

    const limited = await enforceApiLimit(authenticated, now, deps);
    if (limited !== null) return limited;
    if (request.method !== definition.method) return methodNotAllowed(definition.method);
    if ((definition.method === "POST" || definition.method === "PUT") && !isJsonContentType(request.headers.get("content-type"))) {
      return unsupportedMediaType();
    }
    return handleAuthenticatedRoute(definition.route, request, authenticated, now, deps);
  } catch {
    logSafely(deps.log, "api_internal_error");
    return internalServerError();
  }
}
