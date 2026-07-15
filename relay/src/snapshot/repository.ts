import { fromBase64url, parseGraphEnvelope, type GraphEnvelopeV1 } from "@grandbox-bridge/shared";

const MAX_SNAPSHOT_BYTES = 8_388_608;

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

/** A service-role adapter owns the actual database transaction/CAS primitive. */
export interface SnapshotRepositoryStore {
  compareAndSetSnapshot(input: {
    readonly installationId: string;
    readonly expectedSequence: number;
    readonly next: GraphSnapshotRecord;
  }): Promise<boolean>;
  readSnapshot(installationId: string): Promise<GraphSnapshotRecord | null>;
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
  expectedSequence: number,
  input: GraphSnapshotInput,
): GraphSnapshotRecord {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid snapshot input");
  }
  assertText(input.graphId, "graph ID");
  let envelope: GraphEnvelopeV1;
  try {
    envelope = parseGraphEnvelope(input.envelope);
  } catch {
    throw new Error("Invalid graph snapshot envelope");
  }
  if (envelope.installationId !== installationId) {
    throw new Error("Graph snapshot envelope installation does not match the request");
  }
  if (envelope.sequence !== expectedSequence + 1) {
    throw new Error("Graph snapshot envelope sequence does not match the compare-and-set request");
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

export class SnapshotRepository {
  constructor(private readonly store: SnapshotRepositoryStore) {}

  async compareAndSet(
    installationId: string,
    expectedSequence: number,
    snapshot: GraphSnapshotInput,
  ): Promise<GraphSnapshotRecord | null> {
    assertText(installationId, "installation ID");
    validateExpectedSequence(expectedSequence);
    const next = deriveSnapshotRecord(installationId, expectedSequence, snapshot);
    return (await this.store.compareAndSetSnapshot({ installationId, expectedSequence, next })) ? next : null;
  }

  current(installationId: string): Promise<GraphSnapshotRecord | null> {
    assertText(installationId, "installation ID");
    return this.store.readSnapshot(installationId);
  }
}
