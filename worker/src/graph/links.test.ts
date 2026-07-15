import { describe, expect, it } from "vitest";
import { graphVaultFixture } from "../../../tests/fixtures/graph/graph-vault.js";
import { extractGraphLinks } from "./links.js";

describe("extractGraphLinks", () => {
  it("ignores frontmatter, code, and external or non-Markdown targets", () => {
    const home = graphVaultFixture().find((note) => note.path === "Home.md");
    if (home === undefined) throw new Error("missing synthetic Home fixture");

    expect(extractGraphLinks(home.markdown)).toEqual([
      { kind: "markdown-link", target: "Research/Index.md" },
      { kind: "wikilink", target: "Plan" },
      { kind: "wikilink", target: "Research/Index" },
    ]);
  });
});
