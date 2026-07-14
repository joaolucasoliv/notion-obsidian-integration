import { expect, it } from "vitest";
import { sha256Hex } from "./hash";

it("hashes UTF-8 input deterministically without a Node-only import", async () => {
  expect(await sha256Hex("Grandbox Bridge")).toBe(
    "727315411367e16793c5140eedbe2371b9619a47ce90e2b3e3b3704e2e725adc",
  );
  expect(await sha256Hex("Olá, Grandbox 🌉")).toBe(
    "0ec7d3f7121263e9b3fbcd5f47e00d55ba051ab1e66f1ee3c1fff815c6d4f417",
  );
});
