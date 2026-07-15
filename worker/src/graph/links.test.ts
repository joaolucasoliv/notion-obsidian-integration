import { describe, expect, it } from "vitest";
import {
  graphVaultFixture,
  obsidianCommentFixtureMarkdown,
  percentEncodedLinkFixture,
} from "../../../tests/fixtures/graph/graph-vault.js";
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

  it("rejects encoded schemes and encoded path structure while preserving a decoded local filename", () => {
    const home = percentEncodedLinkFixture().find((note) => note.path === "Nested/Home.md");
    if (home === undefined) throw new Error("missing synthetic encoded-link fixture");

    expect(extractGraphLinks(home.markdown)).toEqual([
      { kind: "wikilink", target: "Safe Note" },
    ]);
  });

  it("does not read wiki syntax inside Obsidian comments", () => {
    expect(extractGraphLinks(obsidianCommentFixtureMarkdown())).toEqual([
      { kind: "wikilink", target: "Visible" },
    ]);
  });
});
