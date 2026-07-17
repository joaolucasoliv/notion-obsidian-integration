import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeLocal } from "./normalize.js";
import {
  fromNotionMarkdown,
  type LinkMapping,
  MarkdownMappingError,
  toNotionMarkdown,
} from "./notion-mapping.js";
import { parseMarkdown } from "./parse.js";

const BRIDGE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BRIDGE_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAGE_URL = "https://www.notion.so/Paired-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
const APP_PAGE_URL = "https://app.notion.com/aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
const OTHER_PAGE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_PAGE_URL = "https://www.notion.so/Other-bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb";

const FIXTURE_LINKS: LinkMapping = {
  byLocalTarget: new Map([
    ["Research/Paired Note.md", { bridgeId: BRIDGE_ID, notionPageUrl: PAGE_URL }],
  ]),
  byNotionPageId: new Map([
    [PAGE_ID, { bridgeId: BRIDGE_ID, localTarget: "Research/Paired Note.md" }],
  ]),
};

async function fixture(name: string): Promise<string> {
  return readFile(
    fileURLToPath(new URL(`../../../tests/fixtures/markdown/${name}`, import.meta.url)),
    "utf8",
  );
}

async function jsonFixture<T>(name: string): Promise<T> {
  return JSON.parse(await fixture(name)) as T;
}

describe("Notion Markdown mapping", () => {
  it.each([
    "paragraphs",
    "lists",
    "tasks",
    "quotes",
    "code",
    "tables",
    "paired-links",
    "unpaired-links",
    "embeds",
    "literal-escapes",
    "unicode",
    "empty",
  ])("round-trips %s deterministically", async (name) => {
    const local = await fixture(`${name}.local.md`);
    const expectedNotion = await fixture(`${name}.notion.md`);
    const normalized = normalizeLocal(parseMarkdown(local), ["zeta", "alpha", "zeta"]);

    const first = toNotionMarkdown(normalized, FIXTURE_LINKS);
    const second = toNotionMarkdown(normalized, FIXTURE_LINKS);

    expect(first.markdown).toBe(expectedNotion);
    expect(second).toEqual(first);
    expect(first.unsupportedKinds).toEqual([]);
    expect(fromNotionMarkdown(first.markdown, FIXTURE_LINKS, normalized.tags).semantic).toEqual(
      first.semantic,
    );
  });

  it("restores separate plain-text blocks from Notion's single-newline markdown response", () => {
    const local = normalizeLocal(parseMarkdown("# Title\n\nFirst paragraph.\n\nSecond paragraph.\n"), ["alpha"]);

    const decoded = fromNotionMarkdown("# Title\nFirst paragraph.\nSecond paragraph.", FIXTURE_LINKS, ["alpha"]);

    expect(decoded.semantic).toEqual(local);
  });

  it("drops Notion's synthetic empty block only when it precedes a leading H1", () => {
    const local = normalizeLocal(parseMarkdown("# Title\n\nBody\n"));

    const decoded = fromNotionMarkdown("<empty-block/>\n# Title\nBody", FIXTURE_LINKS);

    expect(decoded.semantic).toEqual(local);
    expect(decoded.unsupportedKinds).toEqual([]);
  });

  it("keeps a non-sentinel empty block as unsupported raw HTML", () => {
    const decoded = fromNotionMarkdown("<empty-block/>\nPlain body", FIXTURE_LINKS);

    expect(decoded.unsupportedKinds).toEqual(["raw-html"]);
  });

  it("restores a plain Notion block boundary before escaping a wiki-looking literal", () => {
    const decoded = fromNotionMarkdown("First paragraph.\nSecond [[literal]]", FIXTURE_LINKS);

    expect(decoded.markdown).toBe("First paragraph.\n\nSecond \\[\\[literal\\]\\]\n");
    expect(toNotionMarkdown(decoded.semantic, FIXTURE_LINKS).unsupportedKinds).toEqual([]);
  });

  it("restores a plain Notion block boundary before reversing a paired link", () => {
    const decoded = fromNotionMarkdown(`First paragraph.\n[paired](${PAGE_URL})`, FIXTURE_LINKS);

    expect(decoded.markdown).toBe("First paragraph.\n\n[[Research/Paired Note.md|paired]]\n");
    expect(toNotionMarkdown(decoded.semantic, FIXTURE_LINKS).unsupportedKinds).toEqual([]);
  });

  it("fails closed for a local soft wrap whose Markdown-special source is ambiguous to Notion", () => {
    const mapped = toNotionMarkdown({ bodyMarkdown: "Line one\n$literal\n", tags: [] }, FIXTURE_LINKS);

    expect(mapped.unsupportedKinds).toEqual(["ambiguous-soft-break"]);
  });

  it.each([
    ["formatted content", "First\n**bold**\n"],
    ["an external link", "First\n[external](https://example.com)\n"],
    ["a paired Markdown link", "First\n[paired](<Research/Paired Note.md>)\n"],
    ["inline code", "First\n`literal`\n"],
  ])("fails closed for a local soft wrap before %s", (_kind, source) => {
    const mapped = toNotionMarkdown({ bodyMarkdown: source, tags: [] }, FIXTURE_LINKS);

    expect(mapped.unsupportedKinds).toEqual(["ambiguous-soft-break"]);
  });

  it("maps a conservative local Markdown link only on an exact normalized target", () => {
    const exact = normalizeLocal(
      parseMarkdown("[paired](<Research/Paired Note.md>) and [readable](Missing.md)\n"),
    );

    const mapped = toNotionMarkdown(exact, FIXTURE_LINKS);

    expect(mapped.markdown).toBe(
      `[paired](${PAGE_URL} "grandbox-bridge:local-link:v1") and [readable](Missing.md)\n`,
    );
    expect(fromNotionMarkdown(mapped.markdown, FIXTURE_LINKS).semantic).toEqual(exact);
  });

  it("accepts canonical app.notion.com page URLs returned by the current page API", () => {
    const links: LinkMapping = {
      byLocalTarget: new Map([
        ["Research/Paired Note.md", { bridgeId: BRIDGE_ID, notionPageUrl: APP_PAGE_URL }],
      ]),
      byNotionPageId: FIXTURE_LINKS.byNotionPageId,
    };
    const exact = normalizeLocal(parseMarkdown("[[Research/Paired Note.md]]\n"));

    expect(toNotionMarkdown(exact, links).markdown).toBe(
      `[Research/Paired Note.md](${APP_PAGE_URL})\n`,
    );
  });

  it("preserves malformed wiki syntax as escaped literal source and reports it", async () => {
    const local = await fixture("malformed-wiki.local.md");
    const expected = await fixture("malformed-wiki.notion.md");
    const result = toNotionMarkdown(normalizeLocal(parseMarkdown(local)), FIXTURE_LINKS);

    expect(result.markdown).toBe(expected);
    expect(result.unsupportedKinds).toEqual(["malformed-wikilink"]);
  });

  it("fails closed instead of creating a nested link from wiki syntax in a link label", () => {
    const semantic = normalizeLocal(
      parseMarkdown(
        "[outer [[Research/Paired Note.md|alias]]](https://example.com/resource)\n",
      ),
    );
    const mapped = toNotionMarkdown(semantic, FIXTURE_LINKS);

    expect(mapped.unsupportedKinds).toEqual(["nested-custom-link"]);
    expect(mapped.markdown).toBe(
      "[outer \\[\\[Research/Paired Note.md\\|alias\\]\\]](https://example.com/resource)\n",
    );
    expect(mapped.markdown).not.toContain(PAGE_URL);
  });

  it.each([
    ["emphasis", "*[[Research/Paired Note.md|alias]]*"],
    ["strong", "**[[Research/Paired Note.md|alias]]**"],
    ["delete", "~~[[Research/Paired Note.md|alias]]~~"],
  ])("fails closed for a custom link inside %s below a Markdown link", (_format, formatted) => {
    const semantic = normalizeLocal(
      parseMarkdown(`[outer ${formatted}](https://example.com/resource)\n`),
    );
    const mapped = toNotionMarkdown(semantic, FIXTURE_LINKS);

    expect(mapped.unsupportedKinds).toEqual(["nested-custom-link"]);
    expect(mapped.markdown).not.toContain(PAGE_URL);
    expect(mapped.markdown).toContain("\\[\\[Research/Paired Note.md\\|alias\\]\\]");
    expect(parseMarkdown(mapped.markdown).unsupportedKinds).toEqual([]);
  });

  it("maps an even-backslash embed with an embed marker and preserves its local semantic", () => {
    const source = "\\\\![[Research/Paired Note.md|alias]]\n";
    const semantic = normalizeLocal(parseMarkdown(source));
    const mapped = toNotionMarkdown(semantic, FIXTURE_LINKS);

    expect(semantic.bodyMarkdown).toBe(source);
    expect(mapped.markdown).toBe(
      `\\\\[Embed: \\[\\[Research/Paired Note.md\\|alias\\]\\]](${PAGE_URL} "grandbox-bridge:embed:v1")\n`,
    );
    expect(mapped.unsupportedKinds).toEqual([]);
    expect(fromNotionMarkdown(mapped.markdown, FIXTURE_LINKS).semantic).toEqual(semantic);
  });

  it.each(["wiki", "embed"] as const)(
    "stabilizes repeated normalize/map/reverse cycles for zero through eight slashes before a %s",
    (kind) => {
      for (let slashCount = 0; slashCount <= 8; slashCount += 1) {
        const source = "\\".repeat(slashCount) + (
          kind === "wiki"
            ? "[[Research/Paired Note.md|alias]]\n"
            : "![[Research/Paired Note.md|alias]]\n"
        );
        const first = normalizeLocal(parseMarkdown(source));
        const mapped = toNotionMarkdown(first, FIXTURE_LINKS);
        const once = fromNotionMarkdown(mapped.markdown, FIXTURE_LINKS).semantic;
        const twice = fromNotionMarkdown(
          toNotionMarkdown(once, FIXTURE_LINKS).markdown,
          FIXTURE_LINKS,
        ).semantic;

        expect(normalizeLocal(parseMarkdown(once.bodyMarkdown))).toEqual(once);
        expect(twice).toEqual(once);
        if (slashCount % 2 === 0) {
          expect(once).toEqual(first);
        }
        if (kind === "embed") {
          expect(mapped.markdown.includes('"grandbox-bridge:embed:v1"')).toBe(slashCount % 2 === 0);
        }
      }
    },
  );

  it("fails closed for a forward paired alias that cannot be safely emitted locally", () => {
    const semantic = normalizeLocal(
      parseMarkdown("[[Research/Paired Note.md|\\*alias\\*]]\n"),
    );
    const mapped = toNotionMarkdown(semantic, FIXTURE_LINKS);

    expect(mapped.unsupportedKinds).toEqual(["unsupported-paired-link-label"]);
    expect(mapped.markdown).toContain("Research/Paired Note.md");
    expect(mapped.markdown).not.toContain(PAGE_URL);
  });

  it("round-trips a forward paired alias that is safe to emit locally", () => {
    const semantic = normalizeLocal(
      parseMarkdown("[[Research/Paired Note.md|alias]]\n"),
    );
    const mapped = toNotionMarkdown(semantic, FIXTURE_LINKS);

    expect(mapped.unsupportedKinds).toEqual([]);
    expect(fromNotionMarkdown(mapped.markdown, FIXTURE_LINKS).semantic).toEqual(semantic);
  });

  it("escapes raw HTML and reports unsupported unknown Notion tags", async () => {
    const local = await fixture("raw-html.local.md");
    const expected = await fixture("raw-html.notion.md");
    const mapped = toNotionMarkdown(normalizeLocal(parseMarkdown(local)), FIXTURE_LINKS);

    expect(mapped.markdown).toBe(expected);
    expect(mapped.unsupportedKinds).toEqual(["html-comment", "raw-html"]);

    const unknownSource = await fixture("unknown-tag.notion.md");
    const unknownExpected = await fixture("unknown-tag.local.md");
    const unknown = fromNotionMarkdown(unknownSource, FIXTURE_LINKS);
    expect(unknown.unsupportedKinds).toEqual(["notion-unknown-tag"]);
    expect(unknown.markdown).toBe(unknownExpected);
  });

  it("classifies unsafe URL schemes and preserves a readable literal", async () => {
    const local = await fixture("unsafe-links.local.md");
    const expected = await fixture("unsafe-links.notion.md");
    const result = toNotionMarkdown(normalizeLocal(parseMarkdown(local)), FIXTURE_LINKS);

    expect(result.unsupportedKinds).toEqual(["unsafe-link-scheme"]);
    expect(result.markdown).toBe(expected);
  });

  it.each([
    "[click](< javascript:fixture-danger>)\n",
    "[click](JaVaScRiPt:fixture-danger)\n",
    "[click](java&#x73;cript:fixture-danger)\n",
  ])("rejects an obfuscated unsafe destination: %s", (markdown) => {
    const result = toNotionMarkdown(normalizeLocal(parseMarkdown(markdown)), FIXTURE_LINKS);

    expect(result.unsupportedKinds).toEqual(["unsafe-link-scheme"]);
    expect(result.markdown).toContain("fixture-danger");
  });

  it("does not turn an ordinary Embed-prefixed link into a transclusion", () => {
    const reversed = fromNotionMarkdown(`[Embed: ordinary label](${PAGE_URL})\n`, FIXTURE_LINKS);

    expect(reversed.markdown).toBe("[[Research/Paired Note.md|Embed: ordinary label]]\n");
    expect(reversed.markdown).not.toContain("![[");
  });

  it("requires the bridge embed marker even for an exact-looking ordinary Embed link", () => {
    const ordinary = `[Embed: \\[\\[Research/Paired Note.md\\|diagram\\]\\]](${PAGE_URL})\n`;
    const reversed = fromNotionMarkdown(ordinary, FIXTURE_LINKS);

    expect(reversed.markdown).not.toContain("![[");
    expect(reversed.unsupportedKinds).toEqual(["unsupported-paired-link-label"]);
  });

  it.each([
    ["escaped bang", `\\![paired](${PAGE_URL})\n`],
    ["entity bang", `&#33;[paired](${PAGE_URL})\n`],
  ])("keeps an ordinary paired link after an %s from becoming an embed", (_case, source) => {
    const reversed = fromNotionMarkdown(source, FIXTURE_LINKS);

    expect(reversed.markdown).toBe(
      "\\![[Research/Paired Note.md|paired]]\n",
    );
    expect(reversed.unsupportedKinds).toEqual([]);
  });

  it.each([
    ["Markdown delimiter", "\\*alias\\*", "\\*alias\\*"],
    ["HTML delimiter", "\\<tag\\>", "\\<tag>"],
  ])("preserves a paired alias containing an escaped %s", (_case, label, expectedLabel) => {
    const source = `[${label}](${PAGE_URL})\n`;
    const reversed = fromNotionMarkdown(source, FIXTURE_LINKS);

    expect(reversed.markdown).toBe(`[${expectedLabel}](${PAGE_URL})\n`);
    expect(reversed.markdown).not.toContain("[[");
    expect(reversed.unsupportedKinds).toEqual(["unsupported-paired-link-label"]);
    expect(parseMarkdown(reversed.markdown).unsupportedKinds).toEqual([]);
  });

  it("does not infer bridge syntax from unescaped wiki-looking Notion text", () => {
    const reversed = fromNotionMarkdown("Ordinary [[Missing|alias]] text.\n", FIXTURE_LINKS);

    expect(reversed.markdown).toBe("Ordinary \\[\\[Missing\\|alias\\]\\] text.\n");
    expect(reversed.unsupportedKinds).toEqual([]);
  });

  it.each([
    [
      "wiki",
      "Ordinary [[Injected]] and \\[\\[Missing\\|safe\\]\\].\n",
      "Ordinary \\[\\[Injected\\]\\] and [[Missing|safe]].\n",
    ],
    [
      "embed",
      "Ordinary ![[Injected]] and !\\[\\[Missing Embed\\|safe\\]\\].\n",
      "Ordinary !\\[\\[Injected\\]\\] and ![[Missing Embed|safe]].\n",
    ],
  ])("authorizes each escaped %s construct by its exact source range", (_kind, source, expected) => {
    const reversed = fromNotionMarkdown(source, FIXTURE_LINKS);

    expect(reversed.markdown).toBe(expected);
    expect(reversed.unsupportedKinds).toEqual([]);
  });

  it.each([
    [
      "wiki after an entity",
      "Prefix &amp; \\[\\[Authorized\\]\\].\n",
      "Prefix & [[Authorized]].\n",
    ],
    [
      "embed after an entity",
      "Prefix &amp; !\\[\\[Authorized\\]\\].\n",
      "Prefix & ![[Authorized]].\n",
    ],
    ["wiki containing an entity", "\\[\\[A&amp;B\\]\\]\n", "[[A&B]]\n"],
    ["embed containing an entity", "!\\[\\[A&amp;B\\]\\]\n", "![[A&B]]\n"],
  ])("aligns CommonMark character references for an escaped %s", (_case, source, expected) => {
    const reversed = fromNotionMarkdown(source, FIXTURE_LINKS);

    expect(reversed.markdown).toBe(expected);
    expect(reversed.unsupportedKinds).toEqual([]);
  });

  it("escapes a near-limit many-special-character note with bounded token operations", () => {
    const prefixCollisions = [0, 1, 2, 3]
      .map((index) => `GRANDBOXLITERAL${index}X`)
      .join(" ");
    const specialCount = 900_000;
    const source = `${prefixCollisions}\n${"$".repeat(specialCount)}`;
    const originalIncludes = String.prototype.includes;
    const originalReplaceAll = String.prototype.replaceAll;
    let literalPrefixChecks = 0;
    let literalTokenRestorations = 0;

    String.prototype.includes = function boundedIncludes(
      this: string,
      searchString: string,
      position?: number,
    ): boolean {
      if (searchString.startsWith("GRANDBOXLITERAL")) {
        literalPrefixChecks += 1;
        if (literalPrefixChecks > 8) {
          throw new Error("unbounded literal prefix checks");
        }
      }
      return originalIncludes.call(this, searchString, position);
    };
    String.prototype.replaceAll = function boundedReplaceAll(
      this: string,
      searchValue: string | RegExp,
      replaceValue: string | ((substring: string, ...args: unknown[]) => string),
    ): string {
      if (typeof searchValue === "string" && searchValue.startsWith("GRANDBOXLITERAL")) {
        literalTokenRestorations += 1;
        if (literalTokenRestorations > 1) {
          throw new Error("multiple literal token restoration passes");
        }
      }
      return Reflect.apply(originalReplaceAll, this, [searchValue, replaceValue]) as string;
    };

    try {
      const mapped = toNotionMarkdown({ bodyMarkdown: source, tags: [] }, FIXTURE_LINKS);

      expect(mapped.markdown).toBe(`${prefixCollisions}\n${"\\$".repeat(specialCount)}\n`);
      expect(literalPrefixChecks).toBeLessThanOrEqual(8);
      expect(literalTokenRestorations).toBeLessThanOrEqual(1);
    } finally {
      String.prototype.includes = originalIncludes;
      String.prototype.replaceAll = originalReplaceAll;
    }
  });

  it("resolves 4,096 forward custom tokens with bounded lookup operations", () => {
    const constructCount = 4_096;
    const source = "[[x]]".repeat(constructCount);
    const originalIndexOf = String.prototype.indexOf;
    let tokenLookups = 0;

    String.prototype.indexOf = function boundedIndexOf(
      this: string,
      searchString: string,
      position?: number,
    ): number {
      if (searchString.startsWith("GRANDBOXWIKITOKEN")) {
        tokenLookups += 1;
        if (tokenLookups > constructCount) {
          throw new Error("unbounded forward token lookups");
        }
      }
      return originalIndexOf.call(this, searchString, position);
    };

    try {
      const mapped = toNotionMarkdown({ bodyMarkdown: source, tags: [] }, FIXTURE_LINKS);

      expect(mapped.markdown).toBe(`${"\\[\\[x\\]\\]".repeat(constructCount)}\n`);
      expect(mapped.unsupportedKinds).toEqual([]);
      expect(tokenLookups).toBeLessThanOrEqual(constructCount);
    } finally {
      String.prototype.indexOf = originalIndexOf;
    }
  });

  it("does not replace user text that resembles an internal local token", () => {
    const reversed = fromNotionMarkdown(
      `GRANDBOXLOCALTOKEN0END and [paired](${PAGE_URL})\n`,
      FIXTURE_LINKS,
    );

    expect(reversed.markdown).toBe(
      "GRANDBOXLOCALTOKEN0END and [[Research/Paired Note.md|paired]]\n",
    );
  });

  it("chooses reverse tokens against entity-decoded Markdown", () => {
    const reversed = fromNotionMarkdown(
      `GRANDBOXLOCAL&#84;OKEN0X0END and [paired](${PAGE_URL})\n`,
      FIXTURE_LINKS,
    );

    expect(reversed.markdown).toBe(
      "GRANDBOXLOCALTOKEN0X0END and [[Research/Paired Note.md|paired]]\n",
    );
    expect(reversed.unsupportedKinds).toEqual([]);
  });

  it.each([
    [
      "wiki",
      "Ordinary [[Injected]] and \\[\\[Authorized\\]\\] then [[unclosed.\n",
      "Ordinary \\[\\[Injected\\]\\] and [[Authorized]] then \\[\\[unclosed.\n",
    ],
    [
      "embed",
      "Ordinary ![[Injected]] and !\\[\\[Authorized\\]\\] then ![[unclosed.\n",
      "Ordinary !\\[\\[Injected\\]\\] and ![[Authorized]] then !\\[\\[unclosed.\n",
    ],
  ])(
    "fails closed per source range when a later %s construct is malformed",
    (_kind, source, expected) => {
      const reversed = fromNotionMarkdown(source, FIXTURE_LINKS);

      expect(reversed.markdown).toBe(expected);
      expect(reversed.unsupportedKinds).toEqual(["malformed-wikilink"]);
    },
  );

  it("restores 4,097 reverse constructs with one bounded token pass", () => {
    const prefixCollisions = [0, 1, 2, 3]
      .map((index) => `GRANDBOXLOCALTOKEN${index}X`)
      .join(" ");
    const constructCount = 4_097;
    const source = `${prefixCollisions}\n${"\\[\\[x\\]\\]".repeat(constructCount)}\n`;
    const originalIncludes = String.prototype.includes;
    const originalReplace = String.prototype.replace;
    const originalReplaceAll = String.prototype.replaceAll;
    let prefixChecks = 0;
    let restorationPasses = 0;

    String.prototype.includes = function boundedIncludes(
      this: string,
      searchString: string,
      position?: number,
    ): boolean {
      if (searchString.startsWith("GRANDBOXLOCALTOKEN")) {
        prefixChecks += 1;
        if (prefixChecks > 8) {
          throw new Error("unbounded reverse token prefix checks");
        }
      }
      return originalIncludes.call(this, searchString, position);
    };
    String.prototype.replace = function boundedReplace(
      this: string,
      searchValue: string | RegExp,
      replaceValue: string | ((substring: string, ...args: unknown[]) => string),
    ): string {
      if (
        searchValue instanceof RegExp &&
        originalIncludes.call(searchValue.source, "GRANDBOXLOCALTOKEN")
      ) {
        restorationPasses += 1;
        if (restorationPasses > 1) {
          throw new Error("multiple reverse token restoration passes");
        }
      }
      return Reflect.apply(originalReplace, this, [searchValue, replaceValue]) as string;
    };
    String.prototype.replaceAll = function boundedReplaceAll(
      this: string,
      searchValue: string | RegExp,
      replaceValue: string | ((substring: string, ...args: unknown[]) => string),
    ): string {
      if (typeof searchValue === "string" && searchValue.startsWith("GRANDBOXLOCALTOKEN")) {
        restorationPasses += 1;
        if (restorationPasses > 1) {
          throw new Error("multiple reverse token restoration passes");
        }
      }
      return Reflect.apply(originalReplaceAll, this, [searchValue, replaceValue]) as string;
    };

    try {
      const reversed = fromNotionMarkdown(source, FIXTURE_LINKS);

      expect(reversed.markdown).toBe(
        `${prefixCollisions}\n\n${"[[x]]".repeat(constructCount)}\n`,
      );
      expect(prefixChecks).toBeLessThanOrEqual(8);
      expect(restorationPasses).toBe(1);
    } finally {
      String.prototype.includes = originalIncludes;
      String.prototype.replace = originalReplace;
      String.prototype.replaceAll = originalReplaceAll;
    }
  });

  it("preserves a paired Markdown link whose decoded label ends in a backslash", () => {
    const source = `[alias\\\\](${PAGE_URL})\n`;
    const reversed = fromNotionMarkdown(source, FIXTURE_LINKS);

    expect(reversed.markdown).toBe(source);
    expect(reversed.markdown).not.toContain("[[");
    expect(reversed.unsupportedKinds).toEqual(["unsupported-paired-link-label"]);
    expect(parseMarkdown(reversed.markdown).unsupportedKinds).not.toContain("malformed-wikilink");
  });

  it("fails closed for duplicate or ambiguous reverse page mappings", async () => {
    const fixtureData = await jsonFixture<{ secondLocalTarget: string }>(
      "duplicate-page-mapping.fixture.json",
    );
    const duplicate: LinkMapping = {
      byLocalTarget: new Map([
        ["Research/Paired Note.md", { bridgeId: BRIDGE_ID, notionPageUrl: PAGE_URL }],
        [fixtureData.secondLocalTarget, { bridgeId: BRIDGE_ID, notionPageUrl: PAGE_URL }],
      ]),
      byNotionPageId: FIXTURE_LINKS.byNotionPageId,
    };

    expect(() => toNotionMarkdown({ bodyMarkdown: "Body\n", tags: [] }, duplicate)).toThrow(
      MarkdownMappingError,
    );
  });

  it("rejects duplicate bridge identities even when page IDs differ", () => {
    const duplicateBridge: LinkMapping = {
      byLocalTarget: new Map([
        ["Research/Paired Note.md", { bridgeId: BRIDGE_ID, notionPageUrl: PAGE_URL }],
        ["Research/Other.md", { bridgeId: BRIDGE_ID, notionPageUrl: OTHER_PAGE_URL }],
      ]),
      byNotionPageId: new Map([
        [PAGE_ID, { bridgeId: BRIDGE_ID, localTarget: "Research/Paired Note.md" }],
        [OTHER_PAGE_ID, { bridgeId: BRIDGE_ID, localTarget: "Research/Other.md" }],
      ]),
    };

    expect(() => toNotionMarkdown({ bodyMarkdown: "Body\n", tags: [] }, duplicateBridge)).toThrow(
      MarkdownMappingError,
    );
  });

  it("rejects a page-shaped URL on an untrusted host", () => {
    const untrustedUrl = "https://example.com/Paired-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
    const untrusted: LinkMapping = {
      byLocalTarget: new Map([
        ["Research/Paired Note.md", { bridgeId: OTHER_BRIDGE_ID, notionPageUrl: untrustedUrl }],
      ]),
      byNotionPageId: new Map([
        [PAGE_ID, { bridgeId: OTHER_BRIDGE_ID, localTarget: "Research/Paired Note.md" }],
      ]),
    };

    expect(() => toNotionMarkdown({ bodyMarkdown: "Body\n", tags: [] }, untrusted)).toThrow(
      MarkdownMappingError,
    );
  });

  it("rejects a noncanonical bridge identity", () => {
    const invalidIdentity: LinkMapping = {
      byLocalTarget: new Map([
        [
          "Research/Paired Note.md",
          {
            bridgeId: "00000000-0000-0000-0000-000000000000",
            notionPageUrl: PAGE_URL,
          },
        ],
      ]),
      byNotionPageId: new Map([
        [
          PAGE_ID,
          {
            bridgeId: "00000000-0000-0000-0000-000000000000",
            localTarget: "Research/Paired Note.md",
          },
        ],
      ]),
    };

    expect(() => toNotionMarkdown({ bodyMarkdown: "Body\n", tags: [] }, invalidIdentity)).toThrow(
      MarkdownMappingError,
    );
  });

  it("handles a CRLF fixture by canonicalizing it before mapping", async () => {
    const source = (await fixture("crlf.local.md")).replaceAll("\n", "\r\n");
    const expected = await fixture("crlf.notion.md");

    expect(toNotionMarkdown(normalizeLocal(parseMarkdown(source)), FIXTURE_LINKS).markdown).toBe(
      expected,
    );
  });
});
