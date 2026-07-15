import { describe, expect, it } from "vitest";
import { constantTimeEqual, signNotionBody, utf8, verifyNotionBody } from "./hmac.js";

const FIXTURE_VERIFICATION_TOKEN = "fixture-notion-verification-value";

describe("Notion HMAC verification", () => {
  it("signs and verifies the exact raw bytes without normalizing JSON", async () => {
    const raw = utf8('{"id":"fixture-event","title":"fixture-sensitive-title"}');
    const reserialized = utf8('{"title":"fixture-sensitive-title","id":"fixture-event"}');
    const signature = await signNotionBody(raw, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto);

    await expect(verifyNotionBody(raw, signature, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto)).resolves.toBe(true);
    await expect(verifyNotionBody(reserialized, signature, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto)).resolves.toBe(false);
  });

  it("compares same-length and different-length candidates without accepting either mismatch", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });
});
