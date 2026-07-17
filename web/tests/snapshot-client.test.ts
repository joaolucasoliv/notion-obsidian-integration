import type { GraphEnvelopeV1 } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import { HttpSnapshotSource, SnapshotSourceError } from "../src/api/snapshot-client.ts";

const GRAPH_ID = "844d93be-86f1-47ea-a98c-9c56ee81e027";
const ENVELOPE: GraphEnvelopeV1 = {
  version: 1,
  algorithm: "A256GCM",
  installationId: "5c343dbe-23b1-4e13-af1e-ffed61ecb290",
  keyId: "fixture-key",
  sequence: 42,
  createdAt: "2026-07-15T12:00:00.000Z",
  nonce: "AAECAwQFBgcICQoL",
  ciphertext: "AAECAwQFBgcICQoLDA0ODw",
};

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

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

describe("HttpSnapshotSource", () => {
  it("fetches only the same-origin ciphertext route with privacy-safe options", async () => {
    const h = recordingFetch(jsonResponse(ENVELOPE));

    await expect(new HttpSnapshotSource(h.fetch).getLatest(GRAPH_ID, AbortSignal.timeout(5_000))).resolves.toEqual(ENVELOPE);
    expect(h.calls).toEqual([
      {
        url: `/api/graph/${GRAPH_ID}`,
        init: {
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: expect.any(AbortSignal),
        },
      },
    ]);
  });

  it.each([
    [404, "unavailable"],
    [413, "unavailable"],
    [429, "unavailable"],
  ] as const)("maps relay status %s to a bounded safe error", async (status, safeCode) => {
    await expect(new HttpSnapshotSource(recordingFetch(jsonResponse({}, status)).fetch).getLatest(GRAPH_ID, new AbortController().signal))
      .rejects.toMatchObject({ safeCode } satisfies Partial<SnapshotSourceError>);
  });

  it("rejects a wrong response type or malformed envelope without exposing the body", async () => {
    const text = new Response("provider details that must not reach the UI", { headers: { "content-type": "text/plain" } });
    await expect(new HttpSnapshotSource(recordingFetch(text).fetch).getLatest(GRAPH_ID, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: "invalid-envelope" } satisfies Partial<SnapshotSourceError>);

    await expect(new HttpSnapshotSource(recordingFetch(jsonResponse({ invalid: true })).fetch).getLatest(GRAPH_ID, new AbortController().signal))
      .rejects.toMatchObject({ safeCode: "invalid-envelope" } satisfies Partial<SnapshotSourceError>);
  });
});
