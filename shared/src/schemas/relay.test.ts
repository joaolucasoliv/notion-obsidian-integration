import { expect, it } from "vitest";
import { base64url } from "../crypto/base64url";
import { parsePairingPayload } from "./relay";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

it("requires the exact versioned pairing payload with a 32-byte base64url key", () => {
  const payload = { version: 1, graphId: "fixture-graph", keyId: "key-2", key: base64url(KEY) };

  expect(parsePairingPayload(payload)).toEqual(payload);
  expect(() => parsePairingPayload({ ...payload, extra: true })).toThrow(/unrecognized/i);
  expect(() => parsePairingPayload({ ...payload, key: base64url(KEY.slice(1)) })).toThrow(/32.*key|key.*32/i);
});
