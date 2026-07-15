import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DYNAMIC_CREDENTIAL_ASSEMBLY = [
  /\[\s*["'][^"'\n]+["']\s*,\s*["'][^"'\n]+["']\s*\]\.join\(/u,
  /`[^`]*\$\{(?:TOKEN|timestampCanary)\}[^`]*`/u,
] as const;

const TARGET_TESTS = [
  new URL("../worker/src/notion/client.test.ts", import.meta.url),
  new URL("../worker/src/notion/transport.test.ts", import.meta.url),
  new URL("../worker/src/runtime/safe-log.test.ts", import.meta.url),
] as const;

describe("credential fixture hygiene", () => {
  it("loads credential-bearing test values from safe fixtures without dynamic assembly", () => {
    for (const testFile of TARGET_TESTS) {
      const source = readFileSync(testFile, "utf8");

      expect(source).toContain("tests/fixtures/safe/");
      expect(source).toContain("readFileSync(");
      for (const pattern of DYNAMIC_CREDENTIAL_ASSEMBLY) {
        expect(source).not.toMatch(pattern);
      }
    }
  });
});
