export interface QrScanner {
  start(video: HTMLVideoElement, signal: AbortSignal): Promise<string>;
  stop(): Promise<void>;
}

interface ScannerControls {
  stop(): void;
}

function abortError(): DOMException {
  return new DOMException("The camera scan was cancelled.", "AbortError");
}

function stopAttachedTracks(video: HTMLVideoElement | null): void {
  if (video === null) return;
  const source = video.srcObject;
  if (typeof MediaStream !== "undefined" && source instanceof MediaStream) {
    for (const track of source.getTracks()) track.stop();
  }
  video.srcObject = null;
}

/** This module is inert until a user explicitly chooses Scan QR. */
export class BrowserQrScanner implements QrScanner {
  #controls: ScannerControls | null = null;
  #video: HTMLVideoElement | null = null;

  public async start(video: HTMLVideoElement, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw abortError();

    const { BrowserQRCodeReader } = await import("@zxing/browser");
    if (signal.aborted) throw abortError();

    this.#video = video;
    const reader = new BrowserQRCodeReader();
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (callback: (value: string | DOMException) => void, value: string | DOMException): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback(value);
      };
      const onAbort = (): void => {
        void this.stop().finally(() => settle((reason) => reject(reason), abortError()));
      };

      signal.addEventListener("abort", onAbort, { once: true });
      void reader
        .decodeFromConstraints({ audio: false, video: { facingMode: { ideal: "environment" } } }, video, (result, _error, controls) => {
          this.#controls = controls;
          if (result === undefined) return;
          const code = result.getText();
          void this.stop().finally(() => settle((value) => resolve(String(value)), code));
        })
        .then((controls) => {
          this.#controls = controls;
          if (signal.aborted) onAbort();
        })
        .catch(() => settle((reason) => reject(reason), new DOMException("The camera is unavailable.", "NotAllowedError")));
    });
  }

  public async stop(): Promise<void> {
    const controls = this.#controls;
    this.#controls = null;
    try {
      controls?.stop();
    } finally {
      stopAttachedTracks(this.#video);
      this.#video = null;
    }
  }
}
