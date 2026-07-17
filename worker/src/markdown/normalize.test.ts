import { describe, expect, it } from "vitest";
import { normalizeLocal, semanticHash } from "./normalize.js";
import { MAX_MARKDOWN_BYTES, parseMarkdown, scanObsidianText } from "./parse.js";

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

  it("canonicalizes an unformatted top-level soft wrap to one Notion-safe line", () => {
    const semantic = normalizeLocal(parseMarkdown("First soft line\nSecond soft line.\n"));

    expect(semantic.bodyMarkdown).toBe("First soft line Second soft line.\n");
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

  it.each([
    [
      "one backslash before a wiki",
      "\\[[Research/Paired Note.md]]\n",
      "\\[\\[Research/Paired Note.md]]\n",
      null,
    ],
    [
      "two backslashes before a wiki",
      "\\\\[[Research/Paired Note.md]]\n",
      "\\\\[[Research/Paired Note.md]]\n",
      "wikilink",
    ],
    [
      "one backslash before an embed",
      "\\![[Research/Paired Note.md]]\n",
      "\\![[Research/Paired Note.md]]\n",
      "wikilink",
    ],
    [
      "two backslashes before an embed",
      "\\\\![[Research/Paired Note.md]]\n",
      "\\\\![[Research/Paired Note.md]]\n",
      "embed",
    ],
  ] as const)(
    "preserves CommonMark escape parity for %s",
    (_case, source, expected, expectedKind) => {
      const normalized = normalizeLocal(parseMarkdown(source));
      const scan = scanObsidianText(normalized.bodyMarkdown);

      expect(normalized.bodyMarkdown).toBe(expected);
      expect(scan.constructs.map((construct) => construct.kind)).toEqual(
        expectedKind === null ? [] : [expectedKind],
      );
    },
  );

  it.each(["wiki", "embed"] as const)(
    "keeps zero through eight backslashes idempotent around %s syntax",
    (kind) => {
      for (let slashCount = 0; slashCount <= 8; slashCount += 1) {
        const source = "\\".repeat(slashCount) + (
          kind === "wiki" ? "[[Research/Paired Note.md]]\n" : "![[Research/Paired Note.md]]\n"
        );
        const first = normalizeLocal(parseMarkdown(source));
        const second = normalizeLocal(parseMarkdown(first.bodyMarkdown));
        const expectedKind =
          slashCount % 2 === 0 ? (kind === "wiki" ? "wikilink" : "embed") : kind === "wiki" ? null : "wikilink";

        expect(second).toEqual(first);
        expect(scanObsidianText(first.bodyMarkdown).constructs.map((construct) => construct.kind)).toEqual(
          expectedKind === null ? [] : [expectedKind],
        );
        if (slashCount % 2 === 0) {
          expect(first.bodyMarkdown).toBe(source);
        }
      }
    },
  );

  it("restores a near-limit even slash run in one bounded pass", () => {
    const suffix = "[[x]]\n";
    const source = "\\".repeat(MAX_MARKDOWN_BYTES - suffix.length - 64) + suffix;
    const parsed = parseMarkdown(source);
    let restorationPasses = 0;

    const normalized = normalizeLocal(parsed, [], {
      onMaskRestorationPass: () => {
        restorationPasses += 1;
        if (restorationPasses > 1) {
          throw new Error("multiple near-limit slash restoration passes");
        }
      },
    });

    expect(normalized.bodyMarkdown).toBe(source);
    expect(restorationPasses).toBe(1);
  });

  it("restores 4,096 normalized constructs with one token pass", () => {
    const source = "[[x]]".repeat(4_096);
    const parsed = parseMarkdown(source);
    let restorationPasses = 0;

    const semantic = normalizeLocal(parsed, [], {
      onMaskRestorationPass: () => {
        restorationPasses += 1;
        if (restorationPasses > 1) {
          throw new Error("multiple normalized token restoration passes");
        }
      },
    });

    expect(semantic.bodyMarkdown).toBe(`${source}\n`);
    expect(restorationPasses).toBe(1);
  });
});
