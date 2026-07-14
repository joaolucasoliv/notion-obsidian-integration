import { describe, expect, it } from "vitest";
import {
  MarkdownParseError,
  maskObsidianSyntax,
  parseMarkdown,
  scanObsidianText,
} from "./parse.js";

describe("parseMarkdown", () => {
  it("normalizes CRLF and returns a bounded mdast wrapper", () => {
    const parsed = parseMarkdown("# Heading\r\n\r\nBody\r\n");

    expect(parsed.source).toBe("# Heading\n\nBody\n");
    expect(parsed.root.type).toBe("root");
    expect(parsed.unsupportedKinds).toEqual([]);
  });

  it("classifies raw HTML, comments, and malformed wiki syntax without dropping source", () => {
    const markdown = "<div>kept</div>\n\n<!-- kept comment -->\n\nBroken [[outer [[inner]]";
    const parsed = parseMarkdown(markdown);

    expect(parsed.source).toBe(markdown);
    expect(parsed.unsupportedKinds).toEqual([
      "html-comment",
      "malformed-wikilink",
      "raw-html",
    ]);
  });

  it("does not interpret escaped brackets or code as wiki syntax", () => {
    const parsed = parseMarkdown("Escaped \\[[literal]] and `[[inline]]`.\n\n```md\n[[fenced]]\n```\n");

    expect(parsed.unsupportedKinds).toEqual([]);
  });

  it("fails closed when the UTF-8 input budget is exceeded", () => {
    expect(() => parseMarkdown("x".repeat(1_048_577))).toThrow(MarkdownParseError);
  });

  it("preserves a very long leading slash run with occupied private-use input", () => {
    const slashCount = 65_537;
    const source = "\\".repeat(slashCount) + "![[x]]\uE000&#xE001;&#xE001;\n";
    const parsed = parseMarkdown(source);
    const paragraph = parsed.root.children[0];
    const expectedSlashes = "\\".repeat(Math.floor(slashCount / 2));
    const expectedSuffix = "![[x]]\uE000\uE001\uE001";

    if (paragraph?.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    const child = paragraph.children[0];
    if (child?.type !== "text") {
      throw new Error("expected a text child");
    }
    expect(child.value.startsWith(expectedSlashes)).toBe(true);
    expect(child.value.endsWith(expectedSuffix)).toBe(true);
    expect(child.value).toHaveLength(expectedSlashes.length + expectedSuffix.length);
    expect(parsed.source).toBe(source);
    expect(parsed.unsupportedKinds).toEqual([]);
  });

  it("bounds the number of custom wiki constructs masked for normalization", () => {
    const parsed = parseMarkdown("[[x]] ".repeat(4_097));

    expect(() => maskObsidianSyntax(parsed)).toThrow(MarkdownParseError);
  });

  it("scans near-limit repeated unmatched openings with bounded suffix work", () => {
    const source = "[[".repeat(524_000);
    const originalIndexOf = String.prototype.indexOf;
    let requestedSuffixBytes = 0;

    String.prototype.indexOf = function boundedIndexOf(
      this: string,
      searchString: string,
      position?: number,
    ): number {
      if (String(this) === source && searchString === "]]") {
        requestedSuffixBytes += this.length - (position ?? 0);
        if (requestedSuffixBytes > source.length * 2) {
          throw new Error("unbounded malformed wiki suffix scans");
        }
      }
      return originalIndexOf.call(this, searchString, position);
    };

    try {
      const scan = scanObsidianText(source);

      expect(scan).toEqual({ constructs: [], malformed: true });
      expect(requestedSuffixBytes).toBeLessThanOrEqual(source.length * 2);
    } finally {
      String.prototype.indexOf = originalIndexOf;
    }
  });

  it("masks 4,096 custom constructs without repeatedly slicing masked output", () => {
    const source = "[[x]]".repeat(4_096);
    const parsed = parseMarkdown(source);
    const originalIndexOf = String.prototype.indexOf;
    const originalSlice = String.prototype.slice;
    const originalStartsWith = String.prototype.startsWith;
    let maskedSliceBytes = 0;

    String.prototype.slice = function boundedSlice(
      this: string,
      start?: number,
      end?: number,
    ): string {
      const result = originalSlice.call(this, start, end);
      if (
        originalStartsWith.call(this, "[[x]]") &&
        originalIndexOf.call(this, "GRANDBOXWIKITOKEN") !== -1
      ) {
        maskedSliceBytes += result.length;
        if (maskedSliceBytes > source.length * 4) {
          throw new Error("unbounded forward mask slicing");
        }
      }
      return result;
    };

    try {
      const masked = maskObsidianSyntax(parsed);

      expect(masked.replacements.size).toBe(4_096);
      expect(maskedSliceBytes).toBeLessThanOrEqual(source.length * 4);
    } finally {
      String.prototype.slice = originalSlice;
    }
  });
});
