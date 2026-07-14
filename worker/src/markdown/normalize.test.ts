import { describe, expect, it } from "vitest";
import { normalizeLocal, semanticHash } from "./normalize.js";
import { parseMarkdown } from "./parse.js";

describe("normalizeLocal", () => {
  it("canonicalizes syntactic equivalents while preserving valid Obsidian syntax", () => {
    const semantic = normalizeLocal(
      parseMarkdown("* alpha\r\n* beta\r\n\r\n[[Research/Paired Note.md|alias]]\r\n"),
      ["zeta", "alpha", "zeta"],
    );

    expect(semantic).toEqual({
      bodyMarkdown: "- alpha\n- beta\n\n[[Research/Paired Note.md|alias]]\n",
      tags: ["alpha", "zeta"],
    });
  });

  it("produces canonical JSON semantics for the asynchronous hash", async () => {
    const first = await semanticHash({ bodyMarkdown: "Body\r\n", tags: ["zeta", "alpha", "zeta"] });
    const second = await semanticHash({ bodyMarkdown: "Body\n", tags: ["alpha", "zeta"] });

    expect(first).toBe("5f93a4fb896d53f2ea3f16ee01a3808ecf930d778c1a90a0b26de2d165a13c49");
    expect(second).toBe(first);
  });

  it("is deterministic when normalization is repeated", () => {
    const first = normalizeLocal(parseMarkdown("## Title\n\nText\n"), ["β", "alpha", "β"]);
    const second = normalizeLocal(parseMarkdown(first.bodyMarkdown), first.tags);

    expect(second).toEqual(first);
  });

  it("sorts unique tags by Unicode code point rather than UTF-16 code unit", () => {
    const semantic = normalizeLocal(parseMarkdown("Body\n"), ["😀", "\uE000", "alpha", "😀"]);

    expect(semantic.tags).toEqual(["alpha", "\uE000", "😀"]);
  });

  it("chooses internal wiki tokens against entity-decoded Markdown", () => {
    const semantic = normalizeLocal(
      parseMarkdown("GRANDBOXWIKI&#84;OKEN0X0END and [[Safe]]\n"),
    );

    expect(semantic.bodyMarkdown).toBe("GRANDBOXWIKITOKEN0X0END and [[Safe]]\n");
  });
});
