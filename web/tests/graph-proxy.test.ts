import { describe, expect, it } from "vitest";
import { RelayGraphProxy } from "../src/api/graph-proxy.ts";

const GRAPH_ID = "844d93be-86f1-47ea-a98c-9c56ee81e027";

function recordingFetch(response: Response): {
  readonly fetch: typeof fetch;
  readonly calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return response;
    },
  };
}

describe("RelayGraphProxy", () => {
  it("proxies one bounded ciphertext response without cookies or upstream error bodies", async () => {
    const h = recordingFetch(new Response('{"ciphertext":"opaque"}', { headers: { "content-type": "application/json" } }));
    const proxy = new RelayGraphProxy({ baseUrl: "https://relay.example.test", fetchImplementation: h.fetch });

    const response = await proxy.get(GRAPH_ID, AbortSignal.timeout(5_000));

    expect(h.calls).toEqual([
      {
        url: `https://relay.example.test/v1/graph/${GRAPH_ID}`,
        init: {
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: expect.any(AbortSignal),
        },
      },
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe('{"ciphertext":"opaque"}');
  });

  it("rejects unsafe configuration and suppresses an upstream failure body", async () => {
    expect(() => new RelayGraphProxy({ baseUrl: "https://relay.example.test/?leak=1" })).toThrow(/configuration/i);
    const proxy = new RelayGraphProxy({
      baseUrl: "https://relay.example.test",
      fetchImplementation: recordingFetch(new Response("provider detail", { status: 500 })).fetch,
    });

    const response = await proxy.get(GRAPH_ID, AbortSignal.timeout(5_000));
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
  });
});
