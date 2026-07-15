import { expect, it } from "vitest";
import { base64url } from "./base64url";
import { MAX_PAIRING_CODE_CHARACTERS, formatPairingCode, parsePairingCode } from "./pairing";

const GRAPH_ID = "fixture-graph";
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

it("formats a self-contained pairing payload without a URL and parses it exactly", () => {
  const code = formatPairingCode({ version: 1, graphId: GRAPH_ID, keyId: "key-2", key: base64url(KEY) });

  expect(code.startsWith("gbp1.")).toBe(true);
  expect(code).not.toMatch(/https?:|\?/i);
  expect(parsePairingCode(code)).toEqual({ version: 1, graphId: GRAPH_ID, keyId: "key-2", key: base64url(KEY) });
});

it("rejects malformed codes and key material that is not exactly 32 bytes", () => {
  expect(() => parsePairingCode("gbp1.bad")).toThrow();
  expect(() => parsePairingCode("https://example.test/gbp1.bad")).toThrow();
  expect(() => formatPairingCode({ version: 1, graphId: GRAPH_ID, keyId: "key-2", key: base64url(KEY.slice(1)) })).toThrow(
    /32.*key|key.*32/i,
  );
});

it("rejects an oversized pasted pairing code before decoding it", () => {
  expect(() => parsePairingCode(`gbp1.${"A".repeat(MAX_PAIRING_CODE_CHARACTERS)}`)).toThrow(/length|size|large/i);
});
