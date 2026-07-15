import type { Nodes } from "mdast";
import { parseLocalNote } from "../markdown/frontmatter.js";
import { parseMarkdown, scanObsidianText } from "../markdown/parse.js";

export interface GraphLink {
  readonly kind: "wikilink" | "markdown-link";
  readonly target: string;
}

function bodyWithoutFrontmatter(markdown: string): string {
  try {
    return parseLocalNote("graph.md", markdown).body;
  } catch {
    if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
      return markdown;
    }
    const lines = markdown.split(/\r?\n/u);
    const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
    return closingIndex === -1 ? "" : lines.slice(closingIndex + 1).join("\n");
  }
}

function rawPathBeforeStructure(target: string): string {
  const fragmentIndex = target.indexOf("#");
  const queryIndex = target.indexOf("?");
  const end = Math.min(
    fragmentIndex === -1 ? target.length : fragmentIndex,
    queryIndex === -1 ? target.length : queryIndex,
  );
  return target.slice(0, end);
}

function isExternalTarget(target: string): boolean {
  return (
    target.startsWith("/") ||
    target.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)
  );
}

function decodedLocalTarget(target: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (
    /%(?:2e|2f|5c)/iu.test(target) ||
    isExternalTarget(decoded) ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    /[\r\n]/u.test(decoded)
  ) {
    return null;
  }
  return decoded;
}

function localMarkdownTarget(target: string): string | null {
  const decoded = decodedLocalTarget(rawPathBeforeStructure(target));
  if (decoded === null) return null;
  if (decoded.length === 0 || /\.md$/iu.test(decoded)) return decoded;
  return null;
}

function localWikiTarget(target: string): string | null {
  const decoded = decodedLocalTarget(rawPathBeforeStructure(target));
  if (decoded === null) return null;
  return decoded;
}

interface CommentMask {
  readonly source: string;
  readonly inComment: boolean;
}

function maskObsidianComments(markdown: string, initiallyInComment: boolean): CommentMask {
  let output = "";
  let inComment = initiallyInComment;
  for (let index = 0; index < markdown.length;) {
    if (markdown.startsWith("%%", index)) {
      output += "  ";
      inComment = !inComment;
      index += 2;
      continue;
    }
    const character = markdown[index] as string;
    output += inComment && character !== "\r" && character !== "\n" ? " " : character;
    index += 1;
  }
  return { source: output, inComment };
}

function sourceRange(documentSource: string, node: Nodes): string | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end < start) return null;
  return documentSource.slice(start, end);
}

function compareLinks(left: GraphLink, right: GraphLink): number {
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.target !== right.target) return left.target < right.target ? -1 : 1;
  return 0;
}

/**
 * Extracts only local note references. Markdown parsing supplies the code and
 * inline-code exclusion; the pre-existing frontmatter parser keeps YAML out.
 */
export function extractGraphLinks(markdown: string): GraphLink[] {
  if (typeof markdown !== "string") {
    throw new Error("Graph markdown must be a string");
  }

  const document = parseMarkdown(bodyWithoutFrontmatter(markdown));
  const links = new Map<string, GraphLink>();
  let inObsidianComment = false;
  const add = (link: GraphLink): void => {
    links.set(`${link.kind}\0${link.target}`, link);
  };
  const visit = (node: Nodes, insideMarkdownLink: boolean): void => {
    if (node.type === "link" && !inObsidianComment) {
      const target = localMarkdownTarget(node.url);
      if (target !== null) add({ kind: "markdown-link", target });
    }
    if (node.type === "text") {
      const source = sourceRange(document.source, node);
      if (source !== null) {
        const masked = maskObsidianComments(source, inObsidianComment);
        inObsidianComment = masked.inComment;
        if (!insideMarkdownLink) {
          const scan = scanObsidianText(masked.source);
          for (const construct of scan.constructs) {
            if (construct.kind !== "wikilink") continue;
            const target = localWikiTarget(construct.target);
            if (target !== null) add({ kind: "wikilink", target });
          }
        }
      }
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children as Nodes[]) {
        visit(child, insideMarkdownLink || node.type === "link");
      }
    }
  };

  visit(document.root, false);
  return [...links.values()].sort(compareLinks);
}
