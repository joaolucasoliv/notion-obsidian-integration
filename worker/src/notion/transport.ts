import type { SafeErrorCode } from "@grandbox-bridge/shared";

export const NOTION_API_BASE = "https://api.notion.com";
export const NOTION_REQUEST_MAX_BYTES = 512_000;
export const NOTION_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

const MAX_TIMEOUT_MS = 300_000;
const RELATIVE_NOTION_PATH = /^\/v1(?:\/[A-Za-z0-9_-]+)+$/u;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*[^;\s]+)?\s*$/iu;

export interface NotionTransportResponse<T> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: T;
}

export interface NotionTransport {
  request<T>(input: {
    readonly method: "GET" | "POST" | "PATCH";
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  }): Promise<NotionTransportResponse<T>>;
}

type TransportFailureCode = Extract<
  SafeErrorCode,
  "invalid-response" | "network-failed" | "timeout" | "request-too-large" | "response-too-large"
>;

export class NotionTransportError extends Error {
  public readonly retryable: boolean;

  public constructor(public readonly code: TransportFailureCode) {
    super(`Notion transport ${code}`);
    this.name = "NotionTransportError";
    this.retryable = code === "network-failed" || code === "timeout";
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FetchNotionTransportOptions {
  readonly fetch?: FetchLike;
}

function transportFailure(code: TransportFailureCode): NotionTransportError {
  return new NotionTransportError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeHeaders(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([name, headerValue]) =>
    name.length > 0 &&
    !/[\r\n\u0000]/u.test(name) &&
    typeof headerValue === "string" &&
    !/[\r\n\u0000]/u.test(headerValue),
  );
}

function isAllowedPath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 2_048 && RELATIVE_NOTION_PATH.test(path);
}

function isBoundedPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isRequestInput(value: unknown): value is Parameters<NotionTransport["request"]>[0] {
  if (!isRecord(value)) return false;
  return (
    (value.method === "GET" || value.method === "POST" || value.method === "PATCH") &&
    isAllowedPath(value.path) &&
    isSafeHeaders(value.headers) &&
    isBoundedPositiveInteger(value.timeoutMs, MAX_TIMEOUT_MS) &&
    isBoundedPositiveInteger(value.maxBytes, NOTION_RESPONSE_MAX_BYTES)
  );
}

function jsonBody(input: Parameters<NotionTransport["request"]>[0]): string | undefined {
  if (input.body === undefined) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input.body);
  } catch {
    throw transportFailure("invalid-response");
  }
  if (serialized === undefined) throw transportFailure("invalid-response");
  if (Buffer.byteLength(serialized, "utf8") > NOTION_REQUEST_MAX_BYTES) {
    throw transportFailure("request-too-large");
  }
  return serialized;
}

function requestUrl(path: string): string {
  try {
    const url = new URL(path, NOTION_API_BASE);
    if (
      url.origin !== NOTION_API_BASE ||
      url.pathname !== path ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw transportFailure("invalid-response");
    }
    return url.toString();
  } catch (caught) {
    if (caught instanceof NotionTransportError) throw caught;
    throw transportFailure("invalid-response");
  }
}

function requestHeaders(input: Parameters<NotionTransport["request"]>[0], body: string | undefined): Headers {
  try {
    const headers = new Headers(input.headers);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    return headers;
  } catch {
    throw transportFailure("invalid-response");
  }
}

function responseContentType(response: Response): string | null {
  try {
    return response.headers.get("content-type");
  } catch {
    throw transportFailure("invalid-response");
  }
}

function responseHeaders(response: Response): Readonly<Record<string, string>> {
  try {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { headers[name] = value; });
    return Object.freeze(headers);
  } catch {
    throw transportFailure("invalid-response");
  }
}

function declaredResponseLength(response: Response): number | null {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null) return null;
  if (!/^\d+$/u.test(contentLength)) throw transportFailure("invalid-response");
  const parsed = Number(contentLength);
  if (!Number.isSafeInteger(parsed)) throw transportFailure("response-too-large");
  return parsed;
}

async function boundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  try {
    const declaredLength = declaredResponseLength(response);
    if (declaredLength !== null && declaredLength > maxBytes) throw transportFailure("response-too-large");
    if (response.body === null) return new Uint8Array();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw transportFailure("invalid-response");
        size += next.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw transportFailure("response-too-large");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (caught) {
    if (caught instanceof NotionTransportError) throw caught;
    throw transportFailure("network-failed");
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw transportFailure("invalid-response");
  }
}

export class FetchNotionTransport implements NotionTransport {
  private readonly fetchImpl: FetchLike;

  public constructor(options: FetchNotionTransportOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async request<T>(input: Parameters<NotionTransport["request"]>[0]): Promise<NotionTransportResponse<T>> {
    if (!isRequestInput(input)) throw transportFailure("invalid-response");
    const body = jsonBody(input);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, input.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(requestUrl(input.path), {
          method: input.method,
          headers: requestHeaders(input, body),
          ...(body === undefined ? {} : { body }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        if (timedOut || controller.signal.aborted) throw transportFailure("timeout");
        throw transportFailure("network-failed");
      }

      try {
        if (
          response.redirected ||
          response.type === "opaqueredirect" ||
          !Number.isInteger(response.status) ||
          response.status < 100 ||
          response.status > 599 ||
          (response.status >= 300 && response.status < 400)
        ) {
          throw transportFailure("invalid-response");
        }
        const contentType = responseContentType(response);
        if (contentType === null || !JSON_CONTENT_TYPE.test(contentType)) throw transportFailure("invalid-response");
        const data = parseJson(await boundedResponseBytes(response, input.maxBytes)) as T;
        return Object.freeze({ status: response.status, headers: responseHeaders(response), data });
      } catch (caught) {
        if (timedOut || controller.signal.aborted) throw transportFailure("timeout");
        if (caught instanceof NotionTransportError) throw caught;
        throw transportFailure("invalid-response");
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
