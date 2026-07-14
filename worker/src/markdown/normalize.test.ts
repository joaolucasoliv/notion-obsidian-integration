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

  it("preserves an escaped bang before a wikilink instead of creating an embed", () => {
    const source = "\\![[Research/Paired Note.md]]\n";

    expect(normalizeLocal(parseMarkdown(source)).bodyMarkdown).toBe(source);
  });

  it("restores 4,096 normalized constructs with one token pass", () => {
    const source = "[[x]]".repeat(4_096);
    const parsed = parseMarkdown(source);
    const originalIncludes = String.prototype.includes;
    const originalReplace = String.prototype.replace;
    const originalReplaceAll = String.prototype.replaceAll;
    let restorationPasses = 0;

    String.prototype.replace = function boundedReplace(
      this: string,
      searchValue: string | RegExp,
      replaceValue: string | ((substring: string, ...args: unknown[]) => string),
    ): string {
      if (
        searchValue instanceof RegExp &&
        originalIncludes.call(searchValue.source, "GRANDBOXWIKITOKEN")
      ) {
        restorationPasses += 1;
        if (restorationPasses > 1) {
          throw new Error("multiple normalized token restoration passes");
        }
      }
      return Reflect.apply(originalReplace, this, [searchValue, replaceValue]) as string;
    };
    String.prototype.replaceAll = function boundedReplaceAll(
      this: string,
      searchValue: string | RegExp,
      replaceValue: string | ((substring: string, ...args: unknown[]) => string),
    ): string {
      if (typeof searchValue === "string" && searchValue.startsWith("GRANDBOXWIKITOKEN")) {
        restorationPasses += 1;
        if (restorationPasses > 1) {
          throw new Error("multiple normalized token restoration passes");
        }
      }
      return Reflect.apply(originalReplaceAll, this, [searchValue, replaceValue]) as string;
    };

    try {
      const semantic = normalizeLocal(parsed);

      expect(semantic.bodyMarkdown).toBe(`${source}\n`);
      expect(restorationPasses).toBe(1);
    } finally {
      String.prototype.replace = originalReplace;
      String.prototype.replaceAll = originalReplaceAll;
    }
  });
});
