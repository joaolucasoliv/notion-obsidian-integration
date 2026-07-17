const MAX_UPSTREAM_BYTES = 8_388_608;
const canonicalGraphId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class RelayGraphProxyConfigurationError extends Error {
  public constructor() {
    super("Invalid relay graph proxy configuration");
  }
}

function safeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayGraphProxyConfigurationError();
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new RelayGraphProxyConfigurationError();
  }
  return url;
}

function headers(extra: HeadersInit = {}): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
    ...extra,
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_UPSTREAM_BYTES)) {
    throw new Error("response too large");
  }
  if (response.body === null) throw new Error("missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      length += value.byteLength;
      if (length > MAX_UPSTREAM_BYTES) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function relayStatus(response: Response): Response | null {
  if (response.status === 404 || response.status === 413) return new Response(null, { status: response.status, headers: headers() });
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const retrySeconds = retryAfter !== null && /^\d{1,2}$/u.test(retryAfter) ? Number(retryAfter) : null;
    return new Response(null, {
      status: 429,
      headers: headers(retrySeconds !== null && retrySeconds <= 60 ? { "retry-after": String(retrySeconds) } : {}),
    });
  }
  return null;
}

/** Server-side only proxy. It forwards ciphertext but no credentials, cookies, or upstream body errors. */
export class RelayGraphProxy {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;

  public constructor(input: { readonly baseUrl: string; readonly fetchImplementation?: typeof fetch }) {
    this.#baseUrl = safeBaseUrl(input.baseUrl);
    this.#fetch = input.fetchImplementation ?? globalThis.fetch;
  }

  public async get(graphId: string, signal: AbortSignal): Promise<Response> {
    if (!canonicalGraphId.test(graphId)) return new Response(null, { status: 404, headers: headers() });
    const upstreamUrl = new URL(`/v1/graph/${graphId}`, this.#baseUrl);
    let response: Response;
    try {
      response = await this.#fetch(upstreamUrl, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal,
      });
    } catch {
      return new Response(null, { status: 502, headers: headers() });
    }

    if (response.redirected) return new Response(null, { status: 502, headers: headers() });
    const knownStatus = relayStatus(response);
    if (knownStatus !== null) return knownStatus;
    if (response.status !== 200 || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return new Response(null, { status: 502, headers: headers() });
    }
    try {
      return new Response(toArrayBuffer(await boundedBody(response)), { status: 200, headers: headers() });
    } catch {
      return new Response(null, { status: 502, headers: headers() });
    }
  }
}
