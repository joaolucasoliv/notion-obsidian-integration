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

  it("does not infer bridge syntax from unescaped wiki-looking Notion text", () => {
    const reversed = fromNotionMarkdown("Ordinary [[Missing|alias]] text.\n", FIXTURE_LINKS);

    expect(reversed.markdown).toBe("Ordinary \\[\\[Missing\\|alias\\]\\] text.\n");
    expect(reversed.unsupportedKinds).toEqual([]);
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
