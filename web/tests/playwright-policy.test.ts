import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("browser release policy", () => {
  it("keeps the only live browser check inside its @live describe block", async () => {
    const source = await readFile(new URL("../playwright/live-smoke.spec.ts", import.meta.url), "utf8");
    expect(source).toContain('test.describe("@live deployed locked smoke"');
    expect(source.split("\n").filter((line) => /^test\(/u.test(line))).toEqual([]);
  });
});
