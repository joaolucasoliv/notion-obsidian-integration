import type { GraphEnvelopeV1 } from "@grandbox-bridge/shared";
import type { GraphSnapshotSink } from "../graph/publisher.js";
import type { RelayClientPort } from "./client.js";

/** Keeps the publisher unaware of HTTP authorization and relay URL handling. */
export class RelaySnapshotSink implements GraphSnapshotSink {
  public constructor(private readonly client: RelayClientPort) {}

  public upload(envelope: GraphEnvelopeV1): Promise<void> {
    return this.client.uploadSnapshot(envelope);
  }
}
