import { sha256Hex } from "@grandbox-bridge/shared";
import { fromNotionMarkdown, toNotionMarkdown, type LinkMapping } from "../markdown/notion-mapping.js";
import { NOTION_AMBIGUOUS_SOFT_WRAP_SPECIALS } from "../markdown/normalize.js";
import { parseMarkdown, scanObsidianText } from "../markdown/parse.js";

const EMPTY_CORTEX_LINKS: LinkMapping = Object.freeze({
  byLocalTarget: new Map(),
  byNotionPageId: new Map(),
});

/**
 * The provider ambiguity is limited to plain top-level paragraph boundaries.
 * This check intentionally excludes all rich or Obsidian-specific syntax
 * before the mapper can mask or rewrite it.
 */
function hasProvenPlainBlockAmbiguity(markdown: string): boolean {
  const document = parseMarkdown(markdown);
  const obsidian = scanObsidianText(markdown);
  if (
    document.unsupportedKinds.length !== 0 ||
    document.root.children.length === 0 ||
    obsidian.malformed ||
    obsidian.constructs.length !== 0
  ) {
    return false;
  }

  let hasPotentialBoundary = document.root.children.length > 1;
  for (const node of document.root.children) {
    const child = node.type === "paragraph" && node.children.length === 1 ? node.children[0] : null;
    if (child?.type !== "text" || NOTION_AMBIGUOUS_SOFT_WRAP_SPECIALS.test(child.value)) {
      return false;
    }
    if (child.value.includes("\n")) {
      hasPotentialBoundary = true;
    }
  }
  return hasPotentialBoundary;
}

/**
 * Notion's Markdown endpoint does not preserve the raw spacing between plain
 * blocks.  Normalize only when both directions of the existing mapper accept
 * the body without ambiguity; otherwise retain the raw hash as a safe
 * fallback.  The outbound preflight is necessary because the inbound decoder
 * alone cannot tell a formatted soft wrap from a separate Notion block.
 */
export async function cortexSemanticHash(markdown: string): Promise<string> {
  try {
    if (!hasProvenPlainBlockAmbiguity(markdown)) return await sha256Hex(markdown);

    const outbound = toNotionMarkdown({ bodyMarkdown: markdown, tags: [] }, EMPTY_CORTEX_LINKS);
    if (outbound.unsupportedKinds.length !== 0) return await sha256Hex(markdown);

    const decoded = fromNotionMarkdown(markdown, EMPTY_CORTEX_LINKS);
    if (decoded.unsupportedKinds.length === 0) {
      return await sha256Hex(decoded.semantic.bodyMarkdown);
    }
  } catch {
    // Unsupported or oversized Markdown remains byte-sensitive rather than
    // being silently normalized through a partial representation.
  }
  return await sha256Hex(markdown);
}
