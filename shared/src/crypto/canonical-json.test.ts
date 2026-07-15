import { expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";

it("sorts object keys recursively without reordering array entries", () => {
  expect(
    canonicalJson({
      z: [{ beta: 2, alpha: 1 }, "second"],
      alpha: { delta: true, charlie: null },
    }),
  ).toBe('{"alpha":{"charlie":null,"delta":true},"z":[{"alpha":1,"beta":2},"second"]}');
});

it("sorts numeric-looking object keys lexically instead of JavaScript property order", () => {
  expect(canonicalJson({ 2: "two", 10: "ten" })).toBe('{"10":"ten","2":"two"}');
});

it("rejects values that JSON would silently coerce or omit", () => {
  expect(() => canonicalJson({ value: Number.NaN })).toThrow(/finite|canonical/i);
  expect(() => canonicalJson({ value: undefined })).toThrow(/canonical|unsupported/i);
  expect(() => canonicalJson([undefined])).toThrow(/canonical|unsupported/i);
  expect(() => canonicalJson(new Array(1))).toThrow(/canonical|sparse|unsupported/i);
});
