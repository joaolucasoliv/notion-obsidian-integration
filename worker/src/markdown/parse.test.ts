import { describe, expect, it } from "vitest";
import { MarkdownParseError, maskObsidianSyntax, parseMarkdown } from "./parse.js";

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

  it("bounds the number of custom wiki constructs masked for normalization", () => {
    const parsed = parseMarkdown("[[x]] ".repeat(4_097));

    expect(() => maskObsidianSyntax(parsed)).toThrow(MarkdownParseError);
  });
});
