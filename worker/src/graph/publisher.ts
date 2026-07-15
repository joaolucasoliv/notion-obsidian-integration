import {
  base64url,
  canonicalGraphHash,
  encryptGraph,
  type GraphEnvelopeV1,
  type GraphProjectionV1,
  type GraphPublishStateV1,
} from "@grandbox-bridge/shared";

export interface GraphNonceSource {
  next(): Uint8Array;
}

export interface GraphSnapshotSink {
  upload(envelope: GraphEnvelopeV1): Promise<void>;
}

export interface GraphPublishResult {
  readonly uploaded: boolean;
  readonly state: GraphPublishStateV1;
}

class SystemNonceSource implements GraphNonceSource {
  public next(): Uint8Array {
    const nonce = new Uint8Array(12);
    globalThis.crypto.getRandomValues(nonce);
    return nonce;
  }
}

function cloneState(state: GraphPublishStateV1): GraphPublishStateV1 {
  return {
    projectionHash: state.projectionHash,
    graphId: state.graphId,
    keyId: state.keyId,
    sequence: state.sequence,
    lastPublishedAt: state.lastPublishedAt,
  };
}

function validTimestamp(value: string): boolean {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(new Date(value).getTime());
}

function validStoredState(state: GraphPublishStateV1): boolean {
  return (
    (state.projectionHash === null || /^[0-9a-f]{64}$/u.test(state.projectionHash)) &&
    Number.isSafeInteger(state.sequence) &&
    state.sequence >= 0 &&
    state.sequence < Number.MAX_SAFE_INTEGER &&
    typeof state.graphId === "string" &&
    state.graphId.length > 0 &&
    Buffer.byteLength(state.graphId, "utf8") <= 256 &&
    typeof state.keyId === "string" &&
    state.keyId.length > 0 &&
    Buffer.byteLength(state.keyId, "utf8") <= 256 &&
    (state.lastPublishedAt === null || validTimestamp(state.lastPublishedAt))
  );
}

/**
 * Encrypts and sends a graph only after its canonical projection has changed.
 * Persistence deliberately remains outside this class so a failed HTTP write
 * cannot advance durable graph state.
 */
export class GraphPublisher {
  private readonly nonceSource: GraphNonceSource;
  private readonly issuedNonces = new Set<string>();

  public constructor(input: { readonly sink: GraphSnapshotSink; readonly nonceSource?: GraphNonceSource }) {
    this.sink = input.sink;
    this.nonceSource = input.nonceSource ?? new SystemNonceSource();
  }

  private readonly sink: GraphSnapshotSink;

  public async publishIfChanged(input: {
    readonly projection: GraphProjectionV1;
    readonly state: GraphPublishStateV1;
    readonly key: Uint8Array;
    readonly now: string;
  }): Promise<GraphPublishResult> {
    const projectionHash = await canonicalGraphHash(input.projection);
    if (!validStoredState(input.state)) {
      throw new Error("Invalid graph publish state");
    }
    if (input.state.projectionHash === projectionHash) {
      return Object.freeze({ uploaded: false, state: cloneState(input.state) });
    }
    if (!validTimestamp(input.now)) {
      throw new Error("Invalid graph publish state");
    }

    const nonce = this.nonceSource.next();
    if (!(nonce instanceof Uint8Array) || nonce.byteLength !== 12) {
      throw new Error("Invalid graph nonce source");
    }
    const nonceId = base64url(nonce);
    if (this.issuedNonces.has(nonceId)) {
      throw new Error("Graph nonce source repeated a nonce");
    }
    this.issuedNonces.add(nonceId);

    const sequence = input.state.sequence + 1;
    const envelope = await encryptGraph({
      projection: input.projection,
      key: input.key,
      installationId: input.projection.installationId,
      keyId: input.state.keyId,
      sequence,
      createdAt: input.now,
      nonce,
    });
    await this.sink.upload(envelope);
    return Object.freeze({
      uploaded: true,
      state: Object.freeze({
        projectionHash,
        graphId: input.state.graphId,
        keyId: input.state.keyId,
        sequence,
        lastPublishedAt: input.now,
      }),
    });
  }
}
