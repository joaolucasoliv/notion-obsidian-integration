import { describe, expect, it } from "vitest";
import { base64url, fromBase64url } from "./base64url";

describe("base64url", () => {
  it("encodes bytes with an unpadded URL-safe alphabet and decodes them exactly", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);

    const encoded = base64url(bytes);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(fromBase64url(encoded)).toEqual(bytes);
  });

  it.each(["a", "abc=", "abc+", "abc/", "not whitespace "])('rejects malformed input %j', (value) => {
    expect(() => fromBase64url(value)).toThrow(/base64url/i);
  });
});
