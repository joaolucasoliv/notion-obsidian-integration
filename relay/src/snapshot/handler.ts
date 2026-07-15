import { parseGraphEnvelope, type GraphEnvelopeV1 } from "@grandbox-bridge/shared";
import { boundedRetryAfterSeconds, isJsonContentType, readBodyAtMost } from "../auth/limits.js";
import {
  badRequest,
  conflict,
  internalServerError,
  methodNotAllowed,
  notFound,
  payloadTooLarge,
  tooManyRequests,
  unsupportedMediaType,
} from "../http/response.js";
import { isCanonicalGraphId, SnapshotRepository } from "./repository.js";

const MAX_SNAPSHOT_REQUEST_BYTES = 8 * 1024 * 1024;
const GRAPH_READ_LIMIT = 60;
const GRAPH_READ_WINDOW_SECONDS = 60;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type SafeSnapshotLogCode = "snapshot_malformed" | "snapshot_rate_limited" | "snapshot_state_conflict" | "snapshot_internal_error";

export interface SnapshotClock {
  now(): Date;
}

export interface SafeSnapshotLogger {
  write(code: SafeSnapshotLogCode): void;
}

export interface SnapshotApiDependencies {
  readonly snapshots: SnapshotRepository;
  readonly clock: SnapshotClock;
  readonly log: SafeSnapshotLogger;
}

export interface AuthenticatedSnapshotInstallation {
  readonly installationId: string;
  readonly graphId: string;
}

function logSafely(log: SafeSnapshotLogger, code: SafeSnapshotLogCode): void {
  try {
    log.write(code);
  } catch {
    // Log sinks must never affect an encrypted snapshot response.
  }
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
    if (value[index] === '"') return index + 1;
    if (value[index] === "\\") {
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
    } else if (character === "{") {
      stack.push("}");
    } else if (character === "[") {
      stack.push("]");
    } else if (character === "}" || character === "]") {
      if (stack.pop() !== character) return -1;
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

/** Reject duplicate top-level envelope keys before JSON.parse can overwrite them. */
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

function hasUtf8Bom(raw: Uint8Array): boolean {
  return raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
}

function parseEnvelope(raw: Uint8Array): GraphEnvelopeV1 | null {
  if (hasUtf8Bom(raw)) return null;
  let parsed: unknown;
  let text: string;
  try {
    text = decoder.decode(raw);
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !hasUniqueTopLevelKeys(text)) return null;
  try {
    return parseGraphEnvelope(parsed);
  } catch {
    return null;
  }
}

function validAuthenticatedInstallation(value: AuthenticatedSnapshotInstallation): boolean {
  return isCanonicalGraphId(value.installationId) && isCanonicalGraphId(value.graphId);
}

function encryptedEnvelopeResponse(envelope: GraphEnvelopeV1): Response {
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function publicNoStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

export function publicGraphNotFound(): Response {
  return publicNoStore(notFound());
}

/** Receives a bounded, authenticated envelope without accepting a caller-selected graph ID. */
export async function handleAuthenticatedSnapshotUpload(
  request: Request,
  authenticated: AuthenticatedSnapshotInstallation,
  deps: SnapshotApiDependencies,
): Promise<Response> {
  try {
    if (request.method !== "PUT") return methodNotAllowed("PUT");
    if (!isJsonContentType(request.headers.get("content-type"))) return unsupportedMediaType();
    if (!validAuthenticatedInstallation(authenticated)) throw new Error("Invalid authenticated installation");

    const raw = await readBodyAtMost(request, MAX_SNAPSHOT_REQUEST_BYTES);
    if (raw === null) {
      logSafely(deps.log, "snapshot_malformed");
      return payloadTooLarge();
    }
    const envelope = parseEnvelope(raw);
    if (envelope === null || envelope.installationId !== authenticated.installationId) {
      logSafely(deps.log, "snapshot_malformed");
      return badRequest();
    }
    const stored = await deps.snapshots.storeIfNewer(authenticated.installationId, {
      graphId: authenticated.graphId,
      envelope,
    });
    if (stored === null) {
      logSafely(deps.log, "snapshot_state_conflict");
      return conflict();
    }
    return new Response(null, { status: 201 });
  } catch {
    logSafely(deps.log, "snapshot_internal_error");
    return internalServerError();
  }
}

/** Returns exactly one stored envelope, after the graph's atomic public-read limit. */
export async function handlePublicGraphRead(request: Request, graphId: string, deps: SnapshotApiDependencies): Promise<Response> {
  try {
    if (request.method !== "GET") return publicNoStore(methodNotAllowed("GET"));
    if (!isCanonicalGraphId(graphId)) return publicGraphNotFound();
    const now = deps.clock.now();
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid injected clock");

    const read = await deps.snapshots.readPublic(graphId, now, GRAPH_READ_LIMIT, GRAPH_READ_WINDOW_SECONDS);
    if (!read.allowed) {
      logSafely(deps.log, "snapshot_rate_limited");
      return publicNoStore(tooManyRequests(boundedRetryAfterSeconds(read.windowStartedAt, now, GRAPH_READ_WINDOW_SECONDS)));
    }
    const snapshot = read.snapshot;
    if (snapshot === null) return publicNoStore(notFound());
    if (snapshot.graphId !== graphId) throw new Error("Graph snapshot store returned a cross-graph record");

    let envelope: GraphEnvelopeV1;
    try {
      envelope = parseGraphEnvelope(snapshot.envelope);
    } catch {
      throw new Error("Graph snapshot store returned an invalid envelope");
    }
    if (
      envelope.installationId !== snapshot.installationId ||
      envelope.sequence !== snapshot.sequence ||
      envelope.keyId !== snapshot.keyId ||
      envelope.createdAt !== snapshot.createdAt
    ) {
      throw new Error("Graph snapshot store returned inconsistent envelope metadata");
    }
    return encryptedEnvelopeResponse(envelope);
  } catch {
    logSafely(deps.log, "snapshot_internal_error");
    return publicNoStore(internalServerError());
  }
}
