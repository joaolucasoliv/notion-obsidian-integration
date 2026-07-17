import { parseGraphEnvelope, type GraphEnvelopeV1 } from "@grandbox-bridge/shared";

const MAX_CIPHERTEXT_RESPONSE_BYTES = 8_388_608;
const canonicalGraphId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SnapshotSource {
  getLatest(graphId: string, signal: AbortSignal): Promise<GraphEnvelopeV1>;
}

export class SnapshotSourceError extends Error {
  public readonly safeCode: "unavailable" | "invalid-envelope";

  public constructor(safeCode: "unavailable" | "invalid-envelope") {
    super(safeCode);
    this.safeCode = safeCode;
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new SnapshotSourceError("invalid-envelope");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      length += value.byteLength;
      if (length > MAX_CIPHERTEXT_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SnapshotSourceError("invalid-envelope");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class HttpSnapshotSource implements SnapshotSource {
  readonly #fetch: typeof fetch;

  public constructor(fetchImplementation: typeof fetch = globalThis.fetch) {
    // Browser fetch is a Web API method: retaining it as a class member and
    // invoking it through that member can give it the wrong receiver. Bind it
    // once so the same client works with both the native browser function and
    // injected test transports.
    this.#fetch = fetchImplementation.bind(globalThis);
  }

  public async getLatest(graphId: string, signal: AbortSignal): Promise<GraphEnvelopeV1> {
    if (!canonicalGraphId.test(graphId)) throw new SnapshotSourceError("invalid-envelope");

    let response: Response;
    try {
      response = await this.#fetch(`/api/graph/${graphId}`, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal,
      });
    } catch {
      throw new SnapshotSourceError("unavailable");
    }

    if (response.redirected || response.status !== 200) throw new SnapshotSourceError("unavailable");
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) throw new SnapshotSourceError("invalid-envelope");

    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(response));
      return parseGraphEnvelope(JSON.parse(text));
    } catch (error) {
      if (error instanceof SnapshotSourceError) throw error;
      throw new SnapshotSourceError("invalid-envelope");
    }
  }
}
