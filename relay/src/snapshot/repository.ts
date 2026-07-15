const MAX_SNAPSHOT_BYTES = 8_388_608;

export interface GraphSnapshotInput {
  readonly graphId: string;
  readonly keyId: string;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly byteLength: number;
  readonly createdAt: string;
}

export interface GraphSnapshotRecord extends GraphSnapshotInput {
  readonly installationId: string;
  readonly sequence: number;
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

function assertSnapshot(input: GraphSnapshotInput): void {
  assertText(input.graphId, "graph ID");
  assertText(input.keyId, "key ID");
  assertText(input.createdAt, "snapshot timestamp");
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("Invalid snapshot byte length");
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
    assertSnapshot(snapshot);
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
      throw new Error("Invalid expected snapshot sequence");
    }
    const next: GraphSnapshotRecord = {
      installationId,
      sequence: expectedSequence + 1,
      graphId: snapshot.graphId,
      keyId: snapshot.keyId,
      envelope: snapshot.envelope,
      byteLength: snapshot.byteLength,
      createdAt: snapshot.createdAt,
    };
    return (await this.store.compareAndSetSnapshot({ installationId, expectedSequence, next })) ? next : null;
  }

  current(installationId: string): Promise<GraphSnapshotRecord | null> {
    assertText(installationId, "installation ID");
    return this.store.readSnapshot(installationId);
  }
}
