import { fromBase64url, parseGraphEnvelope, type GraphEnvelopeV1 } from "@grandbox-bridge/shared";

const MAX_SNAPSHOT_BYTES = 8_388_608;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface GraphSnapshotInput {
  readonly graphId: string;
  readonly envelope: unknown;
}

export interface GraphSnapshotRecord {
  readonly installationId: string;
  readonly sequence: number;
  readonly graphId: string;
  readonly keyId: string;
  readonly envelope: GraphEnvelopeV1;
  readonly byteLength: number;
  readonly createdAt: string;
}

/** The store performs the graph lookup and rate increment in one transaction. */
export interface GraphPublicRead {
  readonly allowed: boolean;
  readonly windowStartedAt: string;
  readonly snapshot: GraphSnapshotRecord | null;
}

/** A service-role adapter owns the actual database transaction/CAS primitive. */
export interface SnapshotRepositoryStore {
  /** Legacy exact CAS for callers that require a contiguous sequence. */
  compareAndSetSnapshot(input: {
    readonly installationId: string;
    readonly expectedSequence: number;
    readonly next: GraphSnapshotRecord;
  }): Promise<boolean>;
  /**
   * Atomically writes only when the installation's persisted sequence is
   * strictly lower than `next.sequence`. Implementations must bind
   * `next.graphId` to the same installation inside that same transaction.
   */
  storeSnapshotIfNewer(input: {
    readonly installationId: string;
    readonly next: GraphSnapshotRecord;
  }): Promise<boolean>;
  readSnapshot(installationId: string): Promise<GraphSnapshotRecord | null>;
  /** Atomically rate-limits a graph read before returning its latest envelope. */
  readPublicSnapshot(input: {
    readonly graphId: string;
    readonly now: Date;
    readonly limit: number;
    readonly windowSeconds: number;
  }): Promise<GraphPublicRead>;
}

/** Minimal service-role RPC surface; it intentionally has no browser credentials. */
export interface SnapshotRpcClient {
  rpc(functionName: string, args: Record<string, unknown>): Promise<{ readonly data: unknown; readonly error: unknown }>;
}

export function isCanonicalGraphId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function assertText(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${name}`);
  }
}

function validateExpectedSequence(expectedSequence: number): void {
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0 || expectedSequence >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid expected snapshot sequence");
  }
}

function deriveSnapshotRecord(
  installationId: string,
  input: GraphSnapshotInput,
): GraphSnapshotRecord {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid snapshot input");
  }
  if (!isCanonicalGraphId(input.graphId)) {
    throw new Error("Invalid graph ID");
  }
  let envelope: GraphEnvelopeV1;
  try {
    envelope = parseGraphEnvelope(input.envelope);
  } catch {
    throw new Error("Invalid graph snapshot envelope");
  }
  if (envelope.installationId !== installationId) {
    throw new Error("Graph snapshot envelope installation does not match the request");
  }
  let ciphertextByteLength: number;
  try {
    ciphertextByteLength = fromBase64url(envelope.ciphertext).byteLength;
  } catch {
    throw new Error("Invalid graph snapshot ciphertext");
  }
  if (ciphertextByteLength < 1 || ciphertextByteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("Invalid snapshot byte length");
  }
  return {
    installationId,
    sequence: envelope.sequence,
    graphId: input.graphId,
    keyId: envelope.keyId,
    envelope,
    byteLength: ciphertextByteLength,
    createdAt: envelope.createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asSafeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function asTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) return null;
  return value;
}

function rpcRows(value: unknown): readonly Record<string, unknown>[] | null {
  return Array.isArray(value) && value.every(isRecord) ? value : null;
}

function rpcError(result: { readonly data: unknown; readonly error: unknown }): void {
  if (result.error !== null && result.error !== undefined) {
    throw new Error("Snapshot database request failed");
  }
}

function snapshotRpcArguments(next: GraphSnapshotRecord, expectedSequence: number | null): Record<string, unknown> {
  return {
    p_installation_id: next.installationId,
    p_graph_id: next.graphId,
    p_sequence: next.sequence,
    p_key_id: next.keyId,
    p_envelope: next.envelope,
    p_byte_length: next.byteLength,
    p_created_at: next.createdAt,
    p_expected_sequence: expectedSequence,
  };
}

function recordFromStoredRow(row: Record<string, unknown>, expectedInstallationId?: string): GraphSnapshotRecord | null {
  const installationId = typeof row.installation_id === "string" ? row.installation_id : null;
  const graphId = typeof row.graph_id === "string" ? row.graph_id : null;
  const sequence = asSafeInteger(row.sequence);
  const keyId = typeof row.key_id === "string" ? row.key_id : null;
  const byteLength = asSafeInteger(row.byte_length);
  const createdAt = asTimestamp(row.created_at);
  if (
    installationId === null ||
    graphId === null ||
    sequence === null ||
    keyId === null ||
    byteLength === null ||
    createdAt === null ||
    !isCanonicalGraphId(installationId) ||
    !isCanonicalGraphId(graphId) ||
    (expectedInstallationId !== undefined && installationId !== expectedInstallationId)
  ) {
    return null;
  }
  let record: GraphSnapshotRecord;
  try {
    record = deriveSnapshotRecord(installationId, { graphId, envelope: row.envelope });
  } catch {
    return null;
  }
  return (
    record.sequence === sequence &&
    record.keyId === keyId &&
    record.byteLength === byteLength &&
    new Date(record.createdAt).getTime() === new Date(createdAt).getTime()
  )
    ? record
    : null;
}

/**
 * Binds the repository contract to the locally defined service-role RPC
 * functions. Each mutating RPC checks graph ownership and sequence state in
 * PostgreSQL, not after a client-side read.
 */
export class SupabaseSnapshotRepositoryStore implements SnapshotRepositoryStore {
  constructor(private readonly client: SnapshotRpcClient) {}

  private async store(next: GraphSnapshotRecord, expectedSequence: number | null): Promise<boolean> {
    const result = await this.client.rpc("bridge_store_graph_snapshot_if_newer", snapshotRpcArguments(next, expectedSequence));
    rpcError(result);
    if (typeof result.data !== "boolean") throw new Error("Invalid snapshot database response");
    return result.data;
  }

  compareAndSetSnapshot(input: {
    readonly installationId: string;
    readonly expectedSequence: number;
    readonly next: GraphSnapshotRecord;
  }): Promise<boolean> {
    if (input.next.installationId !== input.installationId) throw new Error("Snapshot installation mismatch");
    return this.store(input.next, input.expectedSequence);
  }

  storeSnapshotIfNewer(input: { readonly installationId: string; readonly next: GraphSnapshotRecord }): Promise<boolean> {
    if (input.next.installationId !== input.installationId) throw new Error("Snapshot installation mismatch");
    return this.store(input.next, null);
  }

  async readSnapshot(installationId: string): Promise<GraphSnapshotRecord | null> {
    const result = await this.client.rpc("bridge_read_installation_snapshot", { p_installation_id: installationId });
    rpcError(result);
    const rows = rpcRows(result.data);
    if (rows === null || rows.length > 1) throw new Error("Invalid snapshot database response");
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row === undefined) throw new Error("Invalid snapshot database response");
    const record = recordFromStoredRow(row, installationId);
    if (record === null) throw new Error("Invalid snapshot database response");
    return record;
  }

  async readPublicSnapshot(input: {
    readonly graphId: string;
    readonly now: Date;
    readonly limit: number;
    readonly windowSeconds: number;
  }): Promise<GraphPublicRead> {
    const result = await this.client.rpc("bridge_read_graph_snapshot", {
      p_graph_id: input.graphId,
      p_limit: input.limit,
      p_window_seconds: input.windowSeconds,
    });
    rpcError(result);
    const rows = rpcRows(result.data);
    if (rows === null || rows.length !== 1) throw new Error("Invalid snapshot database response");
    const row = rows[0];
    if (row === undefined) throw new Error("Invalid snapshot database response");
    const allowed = row.allowed;
    const windowStartedAt = asTimestamp(row.window_started_at);
    if (typeof allowed !== "boolean" || windowStartedAt === null) throw new Error("Invalid snapshot database response");
    if (row.envelope === null) return { allowed, windowStartedAt, snapshot: null };
    let snapshot: GraphSnapshotRecord;
    try {
      const envelope = parseGraphEnvelope(row.envelope);
      snapshot = deriveSnapshotRecord(envelope.installationId, { graphId: input.graphId, envelope });
    } catch {
      throw new Error("Invalid snapshot database response");
    }
    return { allowed, windowStartedAt, snapshot };
  }
}

export class SnapshotRepository {
  constructor(private readonly store: SnapshotRepositoryStore) {}

  async compareAndSet(
    installationId: string,
    expectedSequence: number,
    snapshot: GraphSnapshotInput,
  ): Promise<GraphSnapshotRecord | null> {
    assertText(installationId, "installation ID");
    validateExpectedSequence(expectedSequence);
    const next = deriveSnapshotRecord(installationId, snapshot);
    if (next.sequence !== expectedSequence + 1) {
      throw new Error("Graph snapshot envelope sequence does not match the compare-and-set request");
    }
    return (await this.store.compareAndSetSnapshot({ installationId, expectedSequence, next })) ? next : null;
  }

  /** Persists a valid envelope only when it advances the stored sequence. */
  async storeIfNewer(installationId: string, snapshot: GraphSnapshotInput): Promise<GraphSnapshotRecord | null> {
    const next = deriveSnapshotRecord(installationId, snapshot);
    if (next.sequence < 1) {
      throw new Error("Graph snapshot envelope sequence must be positive");
    }
    return (await this.store.storeSnapshotIfNewer({ installationId, next })) ? next : null;
  }

  current(installationId: string): Promise<GraphSnapshotRecord | null> {
    assertText(installationId, "installation ID");
    return this.store.readSnapshot(installationId);
  }

  async readPublic(graphId: string, now: Date, limit = 60, windowSeconds = 60): Promise<GraphPublicRead> {
    if (!isCanonicalGraphId(graphId)) {
      throw new Error("Invalid graph ID");
    }
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Invalid graph read timestamp");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
      throw new Error("Invalid graph read rate limit");
    }
    return this.store.readPublicSnapshot({ graphId, now, limit, windowSeconds });
  }
}
