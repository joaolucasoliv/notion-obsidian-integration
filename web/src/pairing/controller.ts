import { fromBase64url, parsePairingCode } from "@grandbox-bridge/shared";
import type { QrScanner } from "./qr-scanner.ts";

const MAX_PAIRING_CODE_BYTES = 2_048;
const MAX_KEY_ID_BYTES = 128;
const safeKeyIdPattern = /^[A-Za-z0-9._-]+$/u;

export interface PairingCandidate {
  readonly graphId: string;
  readonly keyId: string;
  readonly keyBytes: Uint8Array;
}

export interface PairingView {
  setSafeError(value: string | null): void;
  setCameraActive(value: boolean): void;
}

export interface PairingControllerOptions {
  readonly routeGraphId: string;
  readonly view: PairingView;
  readonly scanner?: QrScanner;
  readonly accept: (candidate: PairingCandidate) => void | Promise<void>;
}

interface CameraSession {
  readonly abortController: AbortController;
  closed: boolean;
}

function safeInvalidCode(view: PairingView): void {
  view.setSafeError("This pairing code could not be verified.");
}

function parseCandidate(code: string, routeGraphId: string): PairingCandidate | "wrong-graph" | null {
  if (
    code.length === 0 ||
    new TextEncoder().encode(code).byteLength > MAX_PAIRING_CODE_BYTES ||
    /[\s=]/u.test(code)
  ) {
    return null;
  }

  try {
    const payload = parsePairingCode(code);
    if (payload.graphId !== routeGraphId) return "wrong-graph";
    if (!safeKeyIdPattern.test(payload.keyId) || new TextEncoder().encode(payload.keyId).byteLength > MAX_KEY_ID_BYTES) {
      return null;
    }

    const keyBytes = fromBase64url(payload.key);
    if (keyBytes.byteLength !== 32) return null;
    return { graphId: payload.graphId, keyId: payload.keyId, keyBytes };
  } catch {
    return null;
  }
}

/** Holds pairing material in memory only; persistence begins after graph verification. */
export class PairingController {
  readonly #routeGraphId: string;
  readonly #view: PairingView;
  readonly #scanner: QrScanner | undefined;
  readonly #accept: (candidate: PairingCandidate) => void | Promise<void>;
  #cameraSession: CameraSession | null = null;

  public constructor(options: PairingControllerOptions) {
    this.#routeGraphId = options.routeGraphId;
    this.#view = options.view;
    this.#scanner = options.scanner;
    this.#accept = options.accept;
  }

  public async submit(code: string): Promise<void> {
    const candidate = parseCandidate(code, this.#routeGraphId);
    if (candidate === "wrong-graph") {
      this.#view.setSafeError("This pairing code belongs to another graph.");
      return;
    }
    if (candidate === null) {
      safeInvalidCode(this.#view);
      return;
    }

    this.#view.setSafeError(null);
    await this.#accept(candidate);
  }

  public async scan(video: HTMLVideoElement): Promise<void> {
    if (this.#scanner === undefined) {
      this.#view.setSafeError("Camera scanning is unavailable on this device.");
      return;
    }

    if (this.#cameraSession !== null) await this.cancelCamera();
    const session: CameraSession = { abortController: new AbortController(), closed: false };
    this.#cameraSession = session;
    this.#view.setCameraActive(true);

    try {
      const code = await this.#scanner.start(video, session.abortController.signal);
      if (!session.abortController.signal.aborted) await this.submit(code);
    } catch {
      if (!session.abortController.signal.aborted) {
        this.#view.setSafeError("Camera scanning is unavailable on this device.");
      }
    } finally {
      await this.#closeSession(session);
    }
  }

  public async cancelCamera(): Promise<void> {
    if (this.#cameraSession !== null) await this.#closeSession(this.#cameraSession);
  }

  public async dispose(): Promise<void> {
    await this.cancelCamera();
  }

  async #closeSession(session: CameraSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    session.abortController.abort();
    try {
      await this.#scanner?.stop();
    } finally {
      if (this.#cameraSession === session) this.#cameraSession = null;
      this.#view.setCameraActive(false);
    }
  }
}
