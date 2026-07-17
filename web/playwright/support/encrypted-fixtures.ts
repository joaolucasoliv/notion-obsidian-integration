import { base64url, encryptGraph, formatPairingCode, type GraphEnvelopeV1 } from "@grandbox-bridge/shared";
import { GRAPH_FIXTURE } from "../../tests/fixtures.ts";

export const GRAPH_ID = "844d93be-86f1-47ea-a98c-9c56ee81e027";
export const FIXTURE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

export async function encryptedBrowserFixture(options: {
  readonly key?: Uint8Array;
  readonly keyId?: string;
  readonly sequence?: number;
} = {}): Promise<{ readonly envelope: GraphEnvelopeV1; readonly pairingCode: string }> {
  const key = options.key ?? FIXTURE_KEY;
  const keyId = options.keyId ?? "fixture-key";
  const sequence = options.sequence ?? GRAPH_FIXTURE.sequence;
  const envelope = await encryptGraph({
    projection: {
      schemaVersion: GRAPH_FIXTURE.schemaVersion,
      installationId: GRAPH_FIXTURE.installationId,
      nodes: GRAPH_FIXTURE.nodes,
      edges: GRAPH_FIXTURE.edges,
      conflicts: GRAPH_FIXTURE.conflicts,
    },
    key,
    installationId: GRAPH_FIXTURE.installationId,
    keyId,
    sequence,
    createdAt: GRAPH_FIXTURE.generatedAt,
    nonce: Uint8Array.from({ length: 12 }, (_, index) => (index + sequence) % 256),
  });
  return {
    envelope,
    pairingCode: formatPairingCode({ version: 1, graphId: GRAPH_ID, keyId, key: base64url(key) }),
  };
}
