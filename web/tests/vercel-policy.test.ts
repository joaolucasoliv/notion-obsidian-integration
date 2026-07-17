import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface Header {
  readonly key: string;
  readonly value: string;
}

interface HeaderRule {
  readonly source: string;
  readonly headers: readonly Header[];
}

describe("Vercel embed policy", () => {
  it("allows the approved Notion framing boundary without weakening the browser policy", async () => {
    const config = JSON.parse(await readFile(new URL("../../vercel.json", import.meta.url), "utf8")) as { headers: HeaderRule[] };
    const html = config.headers.find((rule) => rule.source === "/");
    expect(html).toBeDefined();
    const byKey = new Map(html?.headers.map((header) => [header.key.toLowerCase(), header.value]));
    const csp = byKey.get("content-security-policy") ?? "";
    expect(csp.startsWith("default-src 'none'")).toBe(true);
    expect(csp).toContain("frame-ancestors https://www.notion.so https://notion.so https://*.notion.site");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(byKey.get("referrer-policy")).toBe("no-referrer");
    expect(byKey.get("x-content-type-options")).toBe("nosniff");
    expect(byKey.has("x-frame-options")).toBe(false);
  });
});
