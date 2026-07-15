import {
  fromBase64url,
  type Clock,
  type CredentialStore,
  type GraphEnvelopeV1,
} from "@grandbox-bridge/shared";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_EVENT_RESPONSE_BYTES = 64 * 1024;
const MAX_SNAPSHOT_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 300_000;
const MAX_BACKOFF_MS = 30_000;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*[^;\s]+)?\s*$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_TYPE = /^[a-z][a-z0-9._-]{0,127}$/u;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RelayRetryJitter {
  delayMs(attempt: number): number;
}

export interface RelayEvent {
  readonly id: string;
  readonly type: string;
  readonly entityId: string;
  readonly eventAt: string;
}

export interface RelayClaim {
  readonly events: readonly RelayEvent[];
  readonly leaseSeconds: number;
}

export interface RelayClientPort {
  claimEvents(workerId: string, limit: number): Promise<RelayClaim>;
  acknowledgeEvents(workerId: string, eventIds: readonly string[]): Promise<void>;
  registerPage(pageId: string, bridgeId: string): Promise<void>;
  unregisterPage(pageId: string, bridgeId: string): Promise<void>;
  uploadSnapshot(envelope: GraphEnvelopeV1): Promise<void>;
}

export interface RelayClientFactory {
  create(token: string): RelayClient;
}

export class RelayClientError extends Error {
  public constructor(
    public readonly code: "authentication" | "authorization" | "state-conflict" | "rate-limited" | "network" | "timeout" | "invalid-response" | "response-too-large" | "request-too-large",
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super(`Relay client ${code}`);
    this.name = "RelayClientError";
  }
}

class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }

  public async sleep(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}

class ExponentialJitter implements RelayRetryJitter {
  public delayMs(attempt: number): number {
    const exponential = Math.min(MAX_BACKOFF_MS, 250 * (2 ** (attempt - 1)));
    return exponential + Math.floor(Math.random() * 100);
  }
}

function clientError(
  code: RelayClientError["code"],
  retryable = false,
  status: number | null = null,
): RelayClientError {
  return new RelayClientError(code, retryable, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validToken(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 43 || /[\r\n\0]/u.test(value)) return false;
  try {
    return fromBase64url(value).byteLength === 32;
  } catch {
    return false;
  }
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function validWorkerId(value: unknown): value is string {
  return typeof value === "string" && WORKER_ID.test(value);
}

function validEventType(value: unknown): value is string {
  return typeof value === "string" && EVENT_TYPE.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(new Date(value).getTime());
}

function jsonBytes(value: unknown, maximum: number): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw clientError("invalid-response");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maximum) {
    throw clientError("request-too-large");
  }
  return serialized;
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d+$/u.test(raw)) throw clientError("invalid-response");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw clientError("response-too-large");
  return parsed;
}

async function boundedBytes(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = contentLength(response);
  if (declared !== null && declared > maximum) throw clientError("response-too-large");
  if (signal.aborted) throw clientError("timeout", true);
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancelReader = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) throw clientError("timeout", true);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw clientError("invalid-response");
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => undefined);
        throw clientError("response-too-large");
      }
      chunks.push(next.value);
    }
  } catch (caught) {
    if (caught instanceof RelayClientError) throw caught;
    if (signal.aborted) throw clientError("timeout", true);
    throw clientError("network", true);
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw clientError("invalid-response");
  }
}

function retryAfterMilliseconds(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  if (!/^\d+$/u.test(value)) return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return MAX_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, seconds * 1_000);
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function statusError(status: number): RelayClientError {
  if (status === 401) return clientError("authentication", false, status);
  if (status === 403) return clientError("authorization", false, status);
  if (status === 409) return clientError("state-conflict", false, status);
  if (status === 429) return clientError("rate-limited", true, status);
  if (status >= 500 && status <= 599) return clientError("network", true, status);
  return clientError("invalid-response", false, status);
}

function parseClaim(value: unknown): RelayClaim {
  if (!isRecord(value) || !exactKeys(value, ["events", "leaseSeconds"]) || !Array.isArray(value.events)) {
    throw clientError("invalid-response");
  }
  if (!Number.isSafeInteger(value.leaseSeconds) || typeof value.leaseSeconds !== "number" || value.leaseSeconds < 1 || value.leaseSeconds > 3_600 || value.events.length > 50) {
    throw clientError("invalid-response");
  }
  const seen = new Set<string>();
  const events: RelayEvent[] = [];
  for (const event of value.events) {
    if (!isRecord(event) || !exactKeys(event, ["id", "type", "entityId", "eventAt"]) || !validUuid(event.id) || !validEventType(event.type) || !validUuid(event.entityId) || !validTimestamp(event.eventAt) || seen.has(event.id)) {
      throw clientError("invalid-response");
    }
    seen.add(event.id);
    events.push(Object.freeze({ id: event.id, type: event.type, entityId: event.entityId, eventAt: event.eventAt }));
  }
  return Object.freeze({ events: Object.freeze(events), leaseSeconds: value.leaseSeconds });
}

function parseBaseUrl(value: string): URL {
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    const bareOrigin =
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === "";
    if (
      (parsed.protocol !== "https:" && (parsed.protocol !== "http:" || !loopback)) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      /[\r\n\0]/u.test(value) ||
      (value !== parsed.href && !(bareOrigin && value === parsed.origin))
    ) {
      throw new Error("unsafe");
    }
    return parsed;
  } catch {
    throw clientError("invalid-response");
  }
}

export class RelayClient implements RelayClientPort {
  private readonly baseUrl: URL;
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly jitter: RelayRetryJitter;

  public constructor(input: {
    readonly baseUrl: string;
    readonly token: string;
    readonly fetch?: FetchLike;
    readonly clock?: Clock;
    readonly jitter?: RelayRetryJitter;
  }) {
    if (!validToken(input.token)) throw clientError("authentication");
    this.baseUrl = parseBaseUrl(input.baseUrl);
    this.token = input.token;
    this.fetchImpl = input.fetch ?? globalThis.fetch;
    this.clock = input.clock ?? new SystemClock();
    this.jitter = input.jitter ?? new ExponentialJitter();
  }

  private readonly token: string;

  public async claimEvents(workerId: string, limit: number): Promise<RelayClaim> {
    if (!validWorkerId(workerId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw clientError("invalid-response");
    const response = await this.requestJson("POST", "v1/events/claim", { workerId, limit }, MAX_EVENT_RESPONSE_BYTES, [200]);
    return parseClaim(response);
  }

  public async acknowledgeEvents(workerId: string, eventIds: readonly string[]): Promise<void> {
    if (!validWorkerId(workerId) || !Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > 50 || new Set(eventIds).size !== eventIds.length || !eventIds.every(validUuid)) {
      throw clientError("invalid-response");
    }
    await this.requestEmpty("POST", "v1/events/ack", { workerId, eventIds }, [204]);
  }

  public async registerPage(pageId: string, bridgeId: string): Promise<void> {
    await this.pageMutation("v1/pages/register", pageId, bridgeId);
  }

  public async unregisterPage(pageId: string, bridgeId: string): Promise<void> {
    await this.pageMutation("v1/pages/unregister", pageId, bridgeId);
  }

  public async uploadSnapshot(envelope: GraphEnvelopeV1): Promise<void> {
    await this.requestEmpty("PUT", "v1/snapshot", envelope, [201], MAX_SNAPSHOT_REQUEST_BYTES);
  }

  public async prepareRelayTokenRotation(newToken: string): Promise<"prepared" | "conflict"> {
    if (!validToken(newToken)) throw clientError("invalid-response");
    const status = await this.requestStatus("POST", "v1/auth/rotate/prepare", { newToken }, [204, 409]);
    return status === 204 ? "prepared" : "conflict";
  }

  public async commitRelayTokenRotation(): Promise<"committed" | "conflict"> {
    const status = await this.requestStatus("POST", "v1/auth/rotate/commit", {}, [204, 409]);
    return status === 204 ? "committed" : "conflict";
  }

  public async cancelRelayTokenRotation(pendingToken: string): Promise<"cancelled" | "conflict"> {
    if (!validToken(pendingToken)) throw clientError("invalid-response");
    const status = await this.requestStatus("POST", "v1/auth/rotate/cancel", { pendingToken }, [204, 409]);
    return status === 204 ? "cancelled" : "conflict";
  }

  private async pageMutation(path: string, pageId: string, bridgeId: string): Promise<void> {
    if (!validUuid(pageId) || !validUuid(bridgeId)) throw clientError("invalid-response");
    await this.requestEmpty("POST", path, { pageId, bridgeId }, [204]);
  }

  private endpoint(path: string): string {
    if (!/^v1\/[A-Za-z0-9._/-]+$/u.test(path) || path.includes("..")) throw clientError("invalid-response");
    const base = this.baseUrl.href.endsWith("/") ? this.baseUrl.href : `${this.baseUrl.href}/`;
    const endpoint = new URL(path, base);
    if (
      endpoint.origin !== this.baseUrl.origin ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.search !== "" ||
      endpoint.hash !== ""
    ) {
      throw clientError("invalid-response");
    }
    return endpoint.toString();
  }

  private async requestJson(
    method: "POST" | "PUT",
    path: string,
    body: unknown,
    maxResponseBytes: number,
    acceptedStatuses: readonly number[],
  ): Promise<unknown> {
    return this.request(method, path, body, acceptedStatuses, MAX_EVENT_RESPONSE_BYTES, async (response, signal) => {
      if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) throw clientError("invalid-response");
      return parseJson(await boundedBytes(response, maxResponseBytes, signal));
    });
  }

  private async requestEmpty(
    method: "POST" | "PUT",
    path: string,
    body: unknown,
    acceptedStatuses: readonly number[],
    maxRequestBytes = MAX_EVENT_RESPONSE_BYTES,
  ): Promise<void> {
    await this.request(method, path, body, acceptedStatuses, maxRequestBytes, async (response, signal) => {
      const length = contentLength(response);
      if (length !== null && length !== 0) throw clientError("invalid-response");
      if (response.body !== null) {
        const bytes = await boundedBytes(response, 1, signal);
        if (bytes.byteLength !== 0) throw clientError("invalid-response");
      }
    });
  }

  private async requestStatus(
    method: "POST",
    path: string,
    body: unknown,
    acceptedStatuses: readonly number[],
  ): Promise<number> {
    return this.request(method, path, body, acceptedStatuses, MAX_EVENT_RESPONSE_BYTES, async (response, signal) => {
      const length = contentLength(response);
      if (length !== null && length !== 0) throw clientError("invalid-response");
      if (response.body !== null) {
        const bytes = await boundedBytes(response, 1, signal);
        if (bytes.byteLength !== 0) throw clientError("invalid-response");
      }
      return response.status;
    });
  }

  private async request<T>(
    method: "POST" | "PUT",
    path: string,
    body: unknown,
    acceptedStatuses: readonly number[],
    maxRequestBytes: number,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const serialized = jsonBytes(body, maxRequestBytes);
    const controller = new AbortController();
    let rejectDeadline: (reason: unknown) => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      rejectDeadline(clientError("timeout", true));
    }, REQUEST_TIMEOUT_MS);
    try {
      for (let attempt = 0;; attempt += 1) {
        let failure = clientError("network", true);
        let retryAfter: number | null = null;
        try {
          const response = await Promise.race([
            this.fetchImpl(this.endpoint(path), {
              method,
              headers: Object.freeze({
                authorization: `Bearer ${this.token}`,
                accept: "application/json",
                "content-type": "application/json",
              }),
              body: serialized,
              redirect: "error",
              signal: controller.signal,
            }),
            deadline,
          ]);
          if (
            response.redirected ||
            response.type === "opaqueredirect" ||
            !Number.isInteger(response.status) ||
            response.status < 100 ||
            response.status > 599 ||
            (response.status >= 300 && response.status < 400)
          ) {
            throw clientError("invalid-response");
          }
          if (acceptedStatuses.includes(response.status)) {
            return await Promise.race([consume(response, controller.signal), deadline]);
          }
          retryAfter = retryAfterMilliseconds(response);
          failure = statusError(response.status);
          void response.body?.cancel().catch(() => undefined);
        } catch (caught) {
          failure = caught instanceof RelayClientError
            ? caught
            : controller.signal.aborted
              ? clientError("timeout", true)
              : clientError("network", true);
        }
        if (controller.signal.aborted) throw clientError("timeout", true);
        if (!failure.retryable || attempt >= MAX_RETRY_ATTEMPTS) throw failure;
        await Promise.race([this.delay(attempt + 1, retryAfter), deadline]);
      }
    } catch (caught) {
      if (caught instanceof RelayClientError) throw caught;
      if (controller.signal.aborted) throw clientError("timeout", true);
      throw clientError("network", true);
    } finally {
      clearTimeout(timer);
    }
  }

  private async delay(attempt: number, retryAfter: number | null): Promise<void> {
    let delay = retryAfter;
    if (delay === null) {
      try {
        delay = this.jitter.delayMs(attempt);
      } catch {
        throw clientError("invalid-response");
      }
      if (!Number.isSafeInteger(delay) || delay < 0 || delay > MAX_BACKOFF_MS) throw clientError("invalid-response");
    }
    try {
      await this.clock.sleep(delay);
    } catch {
      throw clientError("network", true);
    }
  }
}

function requireCredentialToken(value: string | null): string {
  if (!validToken(value)) throw clientError("authentication");
  return value;
}

async function finalizeRotation(credentials: CredentialStore, nextToken: string): Promise<void> {
  await credentials.set("relay-token", nextToken);
  await credentials.delete("relay-token-pending");
}

function unauthorized(caught: unknown): boolean {
  return caught instanceof RelayClientError && (caught.status === 401 || caught.status === 403);
}

/** Writes pending first, then commits remote rotation before replacing active local credential. */
export async function rotateRelayToken(input: {
  readonly credentials: CredentialStore;
  readonly clients: RelayClientFactory;
  readonly nextToken: string;
}): Promise<void> {
  const active = requireCredentialToken(await input.credentials.get("relay-token"));
  if (!validToken(input.nextToken) || input.nextToken === active) throw clientError("invalid-response");
  await input.credentials.set("relay-token-pending", input.nextToken);
  const prepared = await input.clients.create(active).prepareRelayTokenRotation(input.nextToken);
  if (prepared !== "prepared") throw clientError("state-conflict");
  const committed = await input.clients.create(input.nextToken).commitRelayTokenRotation();
  if (committed !== "committed") throw clientError("state-conflict");
  await finalizeRotation(input.credentials, input.nextToken);
}

/**
 * Recovers only deterministic rotation states. Pending authentication is tried
 * first; an ambiguous server state deliberately leaves both local slots intact.
 */
export async function recoverPendingRelayTokenRotation(input: {
  readonly credentials: CredentialStore;
  readonly clients: RelayClientFactory;
}): Promise<"clean" | "recovered" | "cancelled" | "recovery-required"> {
  const pendingRaw = await input.credentials.get("relay-token-pending");
  if (pendingRaw === null) return "clean";
  if (!validToken(pendingRaw)) return "recovery-required";
  const pending = pendingRaw;

  try {
    const committed = await input.clients.create(pending).commitRelayTokenRotation();
    if (committed === "committed") {
      await finalizeRotation(input.credentials, pending);
      return "recovered";
    }
  } catch (caught) {
    if (!unauthorized(caught)) return "recovery-required";
    try {
      // A committed pending token is now active. Prepare deterministically
      // returns conflict when asked to rotate active to itself.
      const status = await input.clients.create(pending).prepareRelayTokenRotation(pending);
      if (status === "conflict") {
        await finalizeRotation(input.credentials, pending);
        return "recovered";
      }
      return "recovery-required";
    } catch (pendingProbe) {
      if (!unauthorized(pendingProbe)) return "recovery-required";
    }
  }

  let active: string;
  try {
    active = requireCredentialToken(await input.credentials.get("relay-token"));
  } catch {
    return "recovery-required";
  }
  if (active === pending) {
    await finalizeRotation(input.credentials, pending);
    return "recovered";
  }
  try {
    const activeClient = input.clients.create(active);
    const prepared = await activeClient.prepareRelayTokenRotation(pending);
    if (prepared === "prepared") {
      const committed = await input.clients.create(pending).commitRelayTokenRotation();
      if (committed !== "committed") return "recovery-required";
      await finalizeRotation(input.credentials, pending);
      return "recovered";
    }
    const cancelled = await activeClient.cancelRelayTokenRotation(pending);
    if (cancelled !== "cancelled") return "recovery-required";
    await input.credentials.delete("relay-token-pending");
    return "cancelled";
  } catch {
    return "recovery-required";
  }
}
