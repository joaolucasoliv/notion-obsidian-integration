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

function stripHeadingFragment(target: string): string {
  const fragmentIndex = target.indexOf("#");
  return fragmentIndex === -1 ? target : target.slice(0, fragmentIndex);
}

function isExternalTarget(target: string): boolean {
  return (
    target.startsWith("/") ||
    target.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)
  );
}

function localMarkdownTarget(target: string): string | null {
  if (isExternalTarget(target)) return null;
  const path = stripHeadingFragment(target);
  if (path.length === 0 || /\.md$/iu.test(path)) return path;
  return null;
}

function localWikiTarget(target: string): string | null {
  if (isExternalTarget(target)) return null;
  const path = stripHeadingFragment(target);
  return path.includes("?") ? null : path;
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
  const add = (link: GraphLink): void => {
    links.set(`${link.kind}\0${link.target}`, link);
  };
  const visit = (node: Nodes, insideMarkdownLink: boolean): void => {
    if (node.type === "link") {
      const target = localMarkdownTarget(node.url);
      if (target !== null) add({ kind: "markdown-link", target });
    }
    if (node.type === "text" && !insideMarkdownLink) {
      const source = sourceRange(document.source, node);
      if (source !== null) {
        const scan = scanObsidianText(source);
        for (const construct of scan.constructs) {
          if (construct.kind !== "wikilink") continue;
          const target = localWikiTarget(construct.target);
          if (target !== null) add({ kind: "wikilink", target });
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
