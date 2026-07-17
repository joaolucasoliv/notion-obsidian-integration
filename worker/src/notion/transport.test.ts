import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  FetchNotionTransport,
  NOTION_REQUEST_MAX_BYTES,
  NotionTransportError,
} from "./transport.js";

const TEST_CREDENTIALS = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/safe/notion-credentials.json", import.meta.url), "utf8"),
) as Readonly<{
  token: string;
  authorization: string;
  sessionCookie: string;
  invalidJson: string;
  providerSaid: string;
}>;
const TOKEN = TEST_CREDENTIALS.token;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function request(overrides: Partial<Parameters<FetchNotionTransport["request"]>[0]> = {}) {
  return {
    method: "POST" as const,
    path: "/v1/pages",
    headers: { Authorization: TEST_CREDENTIALS.authorization, Accept: "application/json" },
    body: { title: "Alpha" },
    timeoutMs: 100,
    maxBytes: 1_024,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = JSON_HEADERS): Response {
  return new Response(JSON.stringify(value), { status, headers });
}

function expectSafeError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(NotionTransportError);
  expect((error as NotionTransportError).code).toBe(code);
  const rendered = `${String(error)} ${JSON.stringify(error)} ${Object.values(error as object).join(" ")}`;
  expect(rendered).not.toContain(TOKEN);
  expect(rendered).not.toContain("Bearer");
}

describe("FetchNotionTransport", () => {
  it("uses the fixed API base, error redirect policy, and JSON request encoding", async () => {
    const fetch = vi.fn(async () => jsonResponse({ object: "page" }));
    const transport = new FetchNotionTransport({ fetch });

    await expect(transport.request(request())).resolves.toEqual({
      status: 200,
      headers: expect.any(Object),
      data: { object: "page" },
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.notion.com/v1/pages");
    expect(init).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify({ title: "Alpha" }) });
    expect(new Headers(init.headers).get("authorization")).toBe(TEST_CREDENTIALS.authorization);
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("encodes allowlisted block-children query values through the fixed API base", async () => {
    const fetch = vi.fn(async () => jsonResponse({ object: "list", results: [] }));
    const transport = new FetchNotionTransport({ fetch });

    await transport.request({
      ...request({ method: "GET", path: "/v1/blocks/33333333-3333-4333-8333-333333333333/children", body: undefined }),
      query: { page_size: "100", start_cursor: "cursor /?&" },
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.notion.com/v1/blocks/33333333-3333-4333-8333-333333333333/children?page_size=100&start_cursor=cursor+%2F%3F%26",
    );
  });

  it("accepts an application/json response with an optional charset", async () => {
    const transport = new FetchNotionTransport({ fetch: async () => jsonResponse({ ok: true }) });

    await expect(transport.request(request())).resolves.toMatchObject({ data: { ok: true } });
  });

  it("returns only normalized safe retry metadata from a successful upstream response", async () => {
    const transport = new FetchNotionTransport({
      fetch: async () => jsonResponse(
        { ok: true },
        200,
        {
          ...JSON_HEADERS,
          "rEtRy-AfTeR": "2",
          Authorization: TEST_CREDENTIALS.authorization,
          "x-reflected-token": TOKEN,
          "set-cookie": TEST_CREDENTIALS.sessionCookie,
        },
      ),
    });

    const result = await transport.request(request());

    expect(result).toEqual({ status: 200, headers: { "retry-after": "2" }, data: { ok: true } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("Authorization");
  });

  it.each([
    "https://api.notion.com/v1/users/me",
    "//api.notion.com/v1/users/me",
    "/v1/users/me?token=x",
    "/v1/users/me#fragment",
    "/v1/users/me&cursor=forged",
    "/v1/users/../me",
    "/v2/users/me",
  ])("rejects unsafe raw path %s before calling fetch", async (path) => {
    const fetch = vi.fn();
    const transport = new FetchNotionTransport({ fetch });

    const error = await transport.request(request({ method: "GET", path, body: undefined })).catch((caught) => caught);

    expectSafeError(error, "invalid-response");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects structured query keys outside paginated block children before calling fetch", async () => {
    const fetch = vi.fn();
    const transport = new FetchNotionTransport({ fetch });

    const unexpectedKey = await transport.request({
      ...request({ method: "GET", path: "/v1/blocks/33333333-3333-4333-8333-333333333333/children", body: undefined }),
      query: { access_token: "forged" },
    }).catch((caught) => caught);
    const wrongRoute = await transport.request({
      ...request({ method: "GET", path: "/v1/users/me", body: undefined }),
      query: { page_size: "100" },
    }).catch((caught) => caught);
    const wrongMethod = await transport.request({
      ...request({ method: "POST", path: "/v1/blocks/33333333-3333-4333-8333-333333333333/children" }),
      query: { page_size: "100" },
    }).catch((caught) => caught);

    expectSafeError(unexpectedKey, "invalid-response");
    expectSafeError(wrongRoute, "invalid-response");
    expectSafeError(wrongMethod, "invalid-response");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-finite timeouts and response caps before calling fetch", async () => {
    const fetch = vi.fn();
    const transport = new FetchNotionTransport({ fetch });

    const timeoutError = await transport.request(request({ timeoutMs: Number.NaN })).catch((caught) => caught);
    const capError = await transport.request(request({ maxBytes: Number.POSITIVE_INFINITY })).catch((caught) => caught);

    expectSafeError(timeoutError, "invalid-response");
    expectSafeError(capError, "invalid-response");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized UTF-8 JSON request before sending headers or body", async () => {
    const fetch = vi.fn();
    const transport = new FetchNotionTransport({ fetch });
    const error = await transport
      .request(request({ body: { markdown: "x".repeat(NOTION_REQUEST_MAX_BYTES) } }))
      .catch((caught) => caught);

    expectSafeError(error, "request-too-large");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects redirects, non-JSON bodies, invalid JSON, and oversized responses without exposing response data", async () => {
    const redirect = jsonResponse({ provider_message: TOKEN }, 302);
    Object.defineProperty(redirect, "redirected", { value: true });
    const cases: readonly [string, Response, string][] = [
      ["redirect", redirect, "invalid-response"],
      ["non-json", new Response(TOKEN, { headers: { "content-type": "text/plain" } }), "invalid-response"],
      ["invalid JSON", new Response(TEST_CREDENTIALS.invalidJson, { headers: JSON_HEADERS }), "invalid-response"],
      [
        "response cap",
        new Response(JSON.stringify({ provider_message: "x".repeat(2_048) }), { headers: JSON_HEADERS }),
        "response-too-large",
      ],
    ];

    for (const [_label, response, code] of cases) {
      const transport = new FetchNotionTransport({ fetch: async () => response });
      const error = await transport.request(request({ maxBytes: 64 })).catch((caught) => caught);
      expectSafeError(error, code);
    }
  });

  it("maps an aborted fetch to a fixed timeout error and a network failure to a fixed network error", async () => {
    const timeoutTransport = new FetchNotionTransport({
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("provider body", "AbortError")));
        }),
    });
    const timeoutError = await timeoutTransport.request(request({ timeoutMs: 1 })).catch((caught) => caught);

    const networkTransport = new FetchNotionTransport({
      fetch: async () => { throw new Error(TEST_CREDENTIALS.providerSaid); },
    });
    const networkError = await networkTransport.request(request()).catch((caught) => caught);

    expectSafeError(timeoutError, "timeout");
    expectSafeError(networkError, "network-failed");
  });

  it("keeps the timeout active while a JSON response stream is still being read", async () => {
    const transport = new FetchNotionTransport({
      fetch: async (_url, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("provider body", "AbortError")));
        },
      }), { headers: JSON_HEADERS }),
    });
    const error = await Promise.race([
      transport.request(request({ timeoutMs: 1 })).catch((caught) => caught),
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("transport did not timeout")), 50)),
    ]);

    expectSafeError(error, "timeout");
  });

  it("times out and cancels a non-cooperative never-resolving response stream", async () => {
    let cancellations = 0;
    const reader = {
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
      cancel: () => {
        cancellations += 1;
        return Promise.resolve();
      },
      releaseLock: () => undefined,
    };
    const response = {
      redirected: false,
      type: "default",
      status: 200,
      headers: new Headers(JSON_HEADERS),
      body: { getReader: () => reader },
    } as unknown as Response;
    const transport = new FetchNotionTransport({ fetch: async () => response });
    const error = await Promise.race([
      transport.request(request({ timeoutMs: 1 })).catch((caught) => caught),
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("transport did not timeout")), 50)),
    ]);

    expectSafeError(error, "timeout");
    expect(cancellations).toBe(1);
  });
});
