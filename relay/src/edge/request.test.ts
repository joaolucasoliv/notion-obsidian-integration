import { describe, expect, it } from "vitest";
import { normalizeBridgeApiRequest } from "./request.js";

describe("normalizeBridgeApiRequest", () => {
  it("removes only the local Edge gateway prefix while preserving method, body, and query", async () => {
    const request = new Request("http://127.0.0.1:54321/functions/v1/bridge-api/v1/events/claim?trace=fixture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"workerId":"edge-worker","limit":1}',
    });

    const normalized = normalizeBridgeApiRequest(request);

    expect(new URL(normalized.url).pathname).toBe("/v1/events/claim");
    expect(new URL(normalized.url).search).toBe("?trace=fixture");
    expect(normalized.method).toBe("POST");
    await expect(normalized.text()).resolves.toBe('{"workerId":"edge-worker","limit":1}');
  });

  it("leaves a canonical handler path untouched", () => {
    const request = new Request("http://edge.local/v1/graph/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    expect(normalizeBridgeApiRequest(request).url).toBe(request.url);
  });

  it("also removes the function-name prefix when the Edge Runtime already removed /functions/v1", () => {
    const request = new Request("http://edge.local/bridge-api/v1/events/claim");

    expect(new URL(normalizeBridgeApiRequest(request).url).pathname).toBe("/v1/events/claim");
  });
});
