import {
  decryptGraph,
  fromBase64url,
  parseGraphEnvelope,
  type GraphDocumentV1,
} from "@grandbox-bridge/shared";
import type { SafeGraphErrorCode } from "../app/state.ts";
import type { PairingCandidate } from "../pairing/controller.ts";
import type { PairingStore, StoredPairing } from "../storage/pairing-store.ts";
import { GRAPH_LIMITS, InvalidGraphDocumentError, type GraphLimits, validateGraphDocument } from "./validate.ts";

export { GRAPH_LIMITS, type GraphLimits } from "./validate.ts";

export class GraphAcceptanceError extends Error {
  public readonly safeCode: SafeGraphErrorCode;
  public readonly rotated: boolean;

  public constructor(safeCode: SafeGraphErrorCode, options: { readonly rotated?: boolean } = {}) {
    super(safeCode);
    this.safeCode = safeCode;
    this.rotated = options.rotated ?? false;
  }
}

function isPairingMaterial(value: PairingCandidate | StoredPairing): boolean {
  return value.keyBytes instanceof Uint8Array && value.keyBytes.byteLength === 32;
}

function isStoredPairing(value: PairingCandidate | StoredPairing): value is StoredPairing {
  return "highestAcceptedSequence" in value;
}

function pairingRecord(graphId: string, pairing: PairingCandidate | StoredPairing, sequence: number): StoredPairing {
  return {
    graphId,
    keyId: pairing.keyId,
    keyBytes: new Uint8Array(pairing.keyBytes),
    highestAcceptedSequence: sequence,
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * The route graph ID scopes the relay request and the local pairing record.
 * GraphEnvelopeV1 authenticates the snapshot's installation identity; v1 does
 * not duplicate the opaque relay graph ID inside the ciphertext envelope.
 */
export async function decryptAndValidateGraph(input: {
  readonly envelopeInput: unknown;
  readonly pairing: PairingCandidate | StoredPairing;
  readonly expectedGraphId: string;
  readonly limits: GraphLimits;
  readonly store: PairingStore;
}): Promise<{ readonly graph: GraphDocumentV1; readonly sequence: number }> {
  if (input.expectedGraphId.length === 0 || input.pairing.graphId !== input.expectedGraphId || !isPairingMaterial(input.pairing)) {
    throw new GraphAcceptanceError("invalid-pairing");
  }

  let envelope;
  try {
    envelope = parseGraphEnvelope(input.envelopeInput);
    if (fromBase64url(envelope.ciphertext).byteLength > input.limits.ciphertextBytes) {
      throw new GraphAcceptanceError("invalid-envelope");
    }
  } catch (error) {
    if (error instanceof GraphAcceptanceError) throw error;
    throw new GraphAcceptanceError("invalid-envelope");
  }

  const stored = await input.store.get(input.expectedGraphId);
  if (envelope.keyId !== input.pairing.keyId) {
    throw new GraphAcceptanceError("decryption-failed", { rotated: stored !== null });
  }
  if (stored !== null && stored.keyId !== input.pairing.keyId && isStoredPairing(input.pairing)) {
    throw new GraphAcceptanceError("decryption-failed", { rotated: true });
  }
  if (stored !== null && stored.keyId === input.pairing.keyId && envelope.sequence < stored.highestAcceptedSequence) {
    throw new GraphAcceptanceError("rollback-rejected");
  }

  let graph: GraphDocumentV1;
  try {
    graph = validateGraphDocument(await decryptGraph(envelope, input.pairing.keyBytes), input.limits);
  } catch (error) {
    if (error instanceof InvalidGraphDocumentError) throw new GraphAcceptanceError("invalid-graph");
    throw new GraphAcceptanceError("decryption-failed");
  }

  if (stored === null || stored.keyId !== input.pairing.keyId) {
    await input.store.commitVerifiedPairing(pairingRecord(input.expectedGraphId, input.pairing, envelope.sequence));
  } else {
    const result = await input.store.acceptSequence(input.expectedGraphId, input.pairing.keyId, envelope.sequence);
    if (result === "rollback") throw new GraphAcceptanceError("rollback-rejected");
    if (result === "rotated") throw new GraphAcceptanceError("decryption-failed", { rotated: true });
  }

  return { graph, sequence: envelope.sequence };
}
