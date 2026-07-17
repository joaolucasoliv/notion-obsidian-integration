import { base64url, formatPairingCode } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import { PairingController, type PairingView } from "../src/pairing/controller.ts";
import type { QrScanner } from "../src/pairing/qr-scanner.ts";

const GRAPH_ID_A = "844d93be-86f1-47ea-a98c-9c56ee81e027";
const GRAPH_ID_B = "2b8f2b33-80d2-4dab-9d7e-8ac97f2d9b64";
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

function pairingCode(graphId: string): string {
  return formatPairingCode({ version: 1, graphId, keyId: "fixture-key", key: base64url(KEY) });
}

function pairingHarness(input: { readonly scanner?: QrScanner } = {}): {
  readonly controller: PairingController;
  readonly view: { safeError: string | null; cameraActive: boolean };
  readonly candidates: Array<{ graphId: string; keyId: string; keyBytes: Uint8Array }>;
  readonly snapshotRequests: string[];
  readonly storageWrites: string[];
} {
  const view = { safeError: null as string | null, cameraActive: false };
  const candidateRecords: Array<{ graphId: string; keyId: string; keyBytes: Uint8Array }> = [];
  const snapshotRequests: string[] = [];
  const storageWrites: string[] = [];
  const pairingView: PairingView = {
    setSafeError(value) {
      view.safeError = value;
    },
    setCameraActive(value) {
      view.cameraActive = value;
    },
  };
  const controller = new PairingController({
    routeGraphId: GRAPH_ID_A,
    view: pairingView,
    ...(input.scanner === undefined ? {} : { scanner: input.scanner }),
    accept(candidate) {
      candidateRecords.push(candidate);
      snapshotRequests.push(candidate.graphId);
      storageWrites.push(candidate.keyId);
    },
  });

  return { controller, view, candidates: candidateRecords, snapshotRequests, storageWrites };
}

describe("PairingController", () => {
  it("rejects a valid code for a different route before any network or storage call", async () => {
    const h = pairingHarness();

    await h.controller.submit(pairingCode(GRAPH_ID_B));

    expect(h.snapshotRequests).toEqual([]);
    expect(h.storageWrites).toEqual([]);
    expect(h.candidates).toEqual([]);
    expect(h.view.safeError).toBe("This pairing code belongs to another graph.");
  });

  it("keeps valid key material in memory until the caller accepts a route-matching code", async () => {
    const h = pairingHarness();

    await h.controller.submit(pairingCode(GRAPH_ID_A));

    expect(h.candidates).toEqual([{ graphId: GRAPH_ID_A, keyId: "fixture-key", keyBytes: KEY }]);
    expect(h.view.safeError).toBeNull();
  });

  it("stops every camera track on success, cancellation, failure, and disposal", async () => {
    const scanners = [
      scannerThatResolves(pairingCode(GRAPH_ID_A)),
      scannerThatRejects(),
      scannerThatWaitsForAbort(),
      scannerThatWaitsForAbort(),
    ] as const;

    const success = pairingHarness({ scanner: scanners[0] });
    await success.controller.scan({} as HTMLVideoElement);

    const failure = pairingHarness({ scanner: scanners[1] });
    await failure.controller.scan({} as HTMLVideoElement);

    const cancellation = pairingHarness({ scanner: scanners[2] });
    const cancelled = cancellation.controller.scan({} as HTMLVideoElement);
    await cancellation.controller.cancelCamera();
    await cancelled;

    const disposal = pairingHarness({ scanner: scanners[3] });
    const disposed = disposal.controller.scan({} as HTMLVideoElement);
    await disposal.controller.dispose();
    await disposed;

    expect(scanners.every((scanner) => scanner.stopCalls === 1)).toBe(true);
  });
});

interface CountingScanner extends QrScanner {
  readonly stopCalls: number;
}

function scannerThatResolves(code: string): CountingScanner {
  let stopCalls = 0;
  return {
    get stopCalls() {
      return stopCalls;
    },
    async start() {
      return code;
    },
    async stop() {
      stopCalls += 1;
    },
  };
}

function scannerThatRejects(): CountingScanner {
  let stopCalls = 0;
  return {
    get stopCalls() {
      return stopCalls;
    },
    async start() {
      throw new Error("camera unavailable");
    },
    async stop() {
      stopCalls += 1;
    },
  };
}

function scannerThatWaitsForAbort(): CountingScanner {
  let stopCalls = 0;
  return {
    get stopCalls() {
      return stopCalls;
    },
    start(_video, signal) {
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
    async stop() {
      stopCalls += 1;
    },
  };
}
