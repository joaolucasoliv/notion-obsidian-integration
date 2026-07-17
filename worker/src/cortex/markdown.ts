const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PARENT_MARKER = "<!-- grandbox-cortex:parent -->";
const CHILD_MARKER_PREFIX = "<!-- grandbox-cortex:child-page:";
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

export class CortexMarkdownError extends Error {
  public constructor() {
    super("Invalid Cortex Markdown");
    this.name = "CortexMarkdownError";
  }
}

export interface RenderCortexMarkdownInput {
  readonly bodyMarkdown: string;
  /** Null only for the immutable root page. */
  readonly parentWikiLink: string | null;
  readonly directChildPageIds: readonly string[];
}

export interface StripCortexManagedMarkdownInput {
  readonly markdown: string;
  readonly expectedParentWikiLink: string | null;
  readonly expectedChildPageIds: readonly string[];
}

function invalidMarkdown(): CortexMarkdownError {
  return new CortexMarkdownError();
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function assertMarkdown(value: unknown): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_MARKDOWN_BYTES) throw invalidMarkdown();
}

function assertWikiLink(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > 1_024 ||
    /[\r\n\u0000-\u001f\u007f]/u.test(value) ||
    value.includes("[[") ||
    value.includes("]]")
  ) {
    throw invalidMarkdown();
  }
}

function childMarker(pageId: string): string {
  if (!isCanonicalUuid(pageId)) throw invalidMarkdown();
  return `${CHILD_MARKER_PREFIX}${pageId} -->`;
}

function markersFor(pageIds: readonly string[]): string {
  if (!Array.isArray(pageIds) || pageIds.length > 5_000) throw invalidMarkdown();
  const seen = new Set<string>();
  let markers = "";
  for (const pageId of pageIds) {
    if (seen.has(pageId)) throw invalidMarkdown();
    seen.add(pageId);
    markers += childMarker(pageId);
  }
  return markers;
}

/** The only visible local hierarchy presentation owned by the Bridge. */
export function renderCortexParentBreadcrumb(parentWikiLink: string): string {
  assertWikiLink(parentWikiLink);
  const wikiLink = parentWikiLink.endsWith(".md") ? parentWikiLink.slice(0, -3) : parentWikiLink;
  assertWikiLink(wikiLink);
  return `${PARENT_MARKER}\n> [!info]- Cortex parent\n> [[${wikiLink}]]`;
}

/**
 * Adds Bridge-owned hierarchy controls around an otherwise raw Notion body.
 * Markers are appended without a separator so removing them restores remote
 * Markdown byte-for-byte.
 */
export function renderCortexMarkdown(input: Readonly<RenderCortexMarkdownInput>): string {
  if (typeof input !== "object" || input === null) throw invalidMarkdown();
  assertMarkdown(input.bodyMarkdown);
  if (input.bodyMarkdown.includes(PARENT_MARKER) || input.bodyMarkdown.includes(CHILD_MARKER_PREFIX)) {
    throw invalidMarkdown();
  }
  const markers = markersFor(input.directChildPageIds);
  if (input.parentWikiLink === null) return `${input.bodyMarkdown}${markers}`;
  return `${renderCortexParentBreadcrumb(input.parentWikiLink)}\n\n${input.bodyMarkdown}${markers}`;
}

/**
 * Validates the exact Bridge-owned controls against the current hierarchy and
 * returns only the raw body that may be sent back to Notion.
 */
export function stripCortexManagedMarkdown(input: Readonly<StripCortexManagedMarkdownInput>): string {
  if (typeof input !== "object" || input === null) throw invalidMarkdown();
  assertMarkdown(input.markdown);
  const markers = markersFor(input.expectedChildPageIds);
  let body = input.markdown;

  if (input.expectedParentWikiLink === null) {
    if (body.includes(PARENT_MARKER)) throw invalidMarkdown();
  } else {
    const breadcrumb = renderCortexParentBreadcrumb(input.expectedParentWikiLink);
    const prefix = `${breadcrumb}\n\n`;
    if (!body.startsWith(prefix)) throw invalidMarkdown();
    body = body.slice(prefix.length);
    if (body.includes(PARENT_MARKER)) throw invalidMarkdown();
  }

  if (!body.endsWith(markers)) throw invalidMarkdown();
  body = body.slice(0, body.length - markers.length);
  if (body.includes(CHILD_MARKER_PREFIX)) throw invalidMarkdown();
  return body;
}
