import { describe, expect, it } from "vitest";
import { DOMAIN_RULES } from "../../../tests/fixtures/graph/graph-vault.js";
import { classifyDomain } from "./classify.js";

describe("classifyDomain", () => {
  it("uses strict most-specific configured prefixes while preserving built-in domains", () => {
    expect(classifyDomain("Repositories/generated.md", DOMAIN_RULES)).toBe("github");
    expect(classifyDomain("Academics/Thesis.md", DOMAIN_RULES)).toBe("academic");
    expect(classifyDomain("Research/Deep/Study.md", DOMAIN_RULES)).toBe("research");
    expect(classifyDomain("Projects/Bridge.md", DOMAIN_RULES)).toBe("project");
    expect(classifyDomain("Personal/Journal.md", DOMAIN_RULES)).toBe("personal");
    expect(classifyDomain("Elsewhere/Loose.md", DOMAIN_RULES)).toBe("other");
    expect(
      classifyDomain("Research/Deep/Study.md", [
        { pathPrefix: "Research", domain: "research" },
        { pathPrefix: "Research/Deep", domain: "project" },
      ]),
    ).toBe("project");
  });

  it("rejects equally specific overlapping rules instead of choosing by configuration order", () => {
    expect(() =>
      classifyDomain("Research/Index.md", [
        { pathPrefix: "Research", domain: "research" },
        { pathPrefix: "Research/", domain: "project" },
      ]),
    ).toThrow(/equal-specificity/i);
  });
});
