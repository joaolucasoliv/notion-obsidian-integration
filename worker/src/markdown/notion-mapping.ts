import type { SemanticNote } from "@grandbox-bridge/shared";
import type { Link, Nodes, Parent, Root, Text } from "mdast";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify, { type Options as RemarkStringifyOptions } from "remark-stringify";
import {
  normalizeLocal,
  normalizeTags,
  REMARK_STRINGIFY_OPTIONS,
  stringifyMarkdown,
} from "./normalize.js";
import {
  maskObsidianSyntax,
  parseMarkdown,
  scanObsidianText,
  type MarkdownMask,
  type ObsidianConstruct,
  type ParsedMarkdownDocument,
} from "./parse.js";

const MAX_LINK_MAPPINGS = 4_096;
const MAX_LINK_TARGET_BYTES = 1_024;
const MAX_URL_BYTES = 2_048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const URI_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/u;
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);
const NOTION_LITERAL_SPECIALS = /[\\*~`$\[\]<>{}|^]/gu;
const EMBED_LINK_TITLE = "grandbox-bridge:embed:v1";
const LOCAL_LINK_TITLE = "grandbox-bridge:local-link:v1";

const SUPPORTED_NODE_TYPES = new Set([
  "root",
  "paragraph",
  "text",
  "break",
  "heading",
  "list",
  "listItem",
  "blockquote",
  "code",
  "inlineCode",
  "table",
  "tableRow",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "link",
]);

export interface LinkMapping {
  readonly byLocalTarget: ReadonlyMap<
    string,
    { readonly bridgeId: string; readonly notionPageUrl: string }
  >;
  readonly byNotionPageId: ReadonlyMap<
    string,
    { readonly bridgeId: string; readonly localTarget: string }
  >;
}

export interface MappingResult {
  readonly semantic: SemanticNote;
  readonly markdown: string;
  readonly unsupportedKinds: string[];
}

interface LinkRecord {
  readonly bridgeId: string;
  readonly localTarget: string;
  readonly notionPageId: string;
  readonly notionPageUrl: string;
}

interface LinkIndex {
  readonly byTarget: ReadonlyMap<string, LinkRecord>;
  readonly byUrl: ReadonlyMap<string, LinkRecord>;
}

type MaskReplacement = MarkdownMask["replacements"] extends ReadonlyMap<string, infer Value>
  ? Value
  : never;
type TextHandle = NonNullable<NonNullable<RemarkStringifyOptions["handlers"]>["text"]>;

export class MarkdownMappingError extends Error {
  public constructor() {
    super("Invalid Markdown mapping");
    this.name = "MarkdownMappingError";
  }
}

function invalidMapping(): MarkdownMappingError {
  return new MarkdownMappingError();
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function isCanonicalLocalTarget(value: string): boolean {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    utf8Length(value) > MAX_LINK_TARGET_BYTES ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[A-Za-z]:/u.test(value) ||
    /[\\|\[\]\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function canonicalPageId(value: string): string | null {
  const compact = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(compact)) {
    return null;
  }
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function notionPageIdFromUrl(value: string): string | null {
  if (utf8Length(value) > MAX_URL_BYTES) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      !(
        parsed.hostname === "notion.so" ||
        parsed.hostname.endsWith(".notion.so") ||
        parsed.hostname === "notion.site" ||
        parsed.hostname.endsWith(".notion.site")
      ) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.toString() !== value
    ) {
      return null;
    }
    const match = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(
      parsed.pathname,
    );
    return match === null ? null : canonicalPageId(match[1] as string);
  } catch {
    return null;
  }
}

function validateLinkMapping(links: LinkMapping): LinkIndex {
  try {
    if (
      links === null ||
      typeof links !== "object" ||
      links.byLocalTarget.size > MAX_LINK_MAPPINGS ||
      links.byNotionPageId.size > MAX_LINK_MAPPINGS
    ) {
      throw invalidMapping();
    }

    const notionEntries = new Map<string, { readonly bridgeId: string; readonly localTarget: string }>();
    const notionBridgeIds = new Set<string>();
    for (const [pageId, value] of links.byNotionPageId) {
      if (
        canonicalPageId(pageId) !== pageId ||
        !UUID_PATTERN.test(value.bridgeId) ||
        !isCanonicalLocalTarget(value.localTarget) ||
        notionEntries.has(pageId) ||
        notionBridgeIds.has(value.bridgeId)
      ) {
        throw invalidMapping();
      }
      notionEntries.set(pageId, value);
      notionBridgeIds.add(value.bridgeId);
    }

    const byTarget = new Map<string, LinkRecord>();
    const byUrl = new Map<string, LinkRecord>();
    const seenPageIds = new Set<string>();
    for (const [localTarget, value] of links.byLocalTarget) {
      const pageId = notionPageIdFromUrl(value.notionPageUrl);
      const reverse = pageId === null ? undefined : notionEntries.get(pageId);
      if (
        !isCanonicalLocalTarget(localTarget) ||
        !UUID_PATTERN.test(value.bridgeId) ||
        pageId === null ||
        reverse === undefined ||
        reverse.bridgeId !== value.bridgeId ||
        reverse.localTarget !== localTarget ||
        seenPageIds.has(pageId) ||
        byUrl.has(value.notionPageUrl)
      ) {
        throw invalidMapping();
      }
      const record = {
        bridgeId: value.bridgeId,
        localTarget,
        notionPageId: pageId,
        notionPageUrl: value.notionPageUrl,
      };
      byTarget.set(localTarget, record);
      byUrl.set(value.notionPageUrl, record);
      seenPageIds.add(pageId);
    }

    if (seenPageIds.size !== notionEntries.size) {
      throw invalidMapping();
    }
    return { byTarget, byUrl };
  } catch (caught) {
    if (caught instanceof MarkdownMappingError) {
      throw caught;
    }
    throw invalidMapping();
  }
}

function safeLinkUrl(value: string): boolean {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    utf8Length(value) > MAX_URL_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return false;
  }
  const scheme = URI_SCHEME_PATTERN.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    return true;
  }
  return SAFE_SCHEMES.has(scheme);
}

function nodeSource(source: string, node: Nodes): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== "number" || typeof end !== "number") {
    throw invalidMapping();
  }
  return source.slice(start, end);
}

function restoreMaskTokens(raw: string, replacements: ReadonlyMap<string, MaskReplacement>): string {
  let restored = raw;
  for (const [token, replacement] of replacements) {
    restored = restored.replaceAll(token, replacement.raw);
  }
  return restored;
}

function text(value: string): Text {
  return { type: "text", value };
}

function link(url: string, label: string, title: string | null = null): Link {
  return { type: "link", title, url, children: [text(label)] };
}

function asLiteralForParent(value: string, parent: Parent): Nodes {
  if (["root", "blockquote", "listItem"].includes(parent.type)) {
    return { type: "paragraph", children: [text(value)] };
  }
  return text(value);
}

function nextToken(
  value: string,
  replacements: ReadonlyMap<string, MaskReplacement>,
  start: number,
): { readonly token: string; readonly index: number } | null {
  let found: { readonly token: string; readonly index: number } | null = null;
  for (const token of replacements.keys()) {
    const index = value.indexOf(token, start);
    if (index !== -1 && (found === null || index < found.index)) {
      found = { token, index };
    }
  }
  return found;
}

function splitMaskedText(
  value: string,
  replacements: ReadonlyMap<string, MaskReplacement>,
  convert: (replacement: MaskReplacement) => Nodes,
): Nodes[] {
  const nodes: Nodes[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const found = nextToken(value, replacements, cursor);
    if (found === null) {
      nodes.push(text(value.slice(cursor)));
      break;
    }
    if (found.index > cursor) {
      nodes.push(text(value.slice(cursor, found.index)));
    }
    const replacement = replacements.get(found.token);
    if (replacement === undefined) {
      throw invalidMapping();
    }
    nodes.push(convert(replacement));
    cursor = found.index + found.token.length;
  }
  return nodes.length === 0 ? [text("")] : nodes;
}

function isSupportedNode(node: Nodes): boolean {
  return SUPPORTED_NODE_TYPES.has(node.type);
}

function transformToNotion(
  parent: Parent,
  source: string,
  replacements: ReadonlyMap<string, MaskReplacement>,
  links: LinkIndex,
  unsupported: Set<string>,
): void {
  const transformed: Nodes[] = [];
  for (const original of parent.children as Nodes[]) {
    if (original.type === "text") {
      transformed.push(
        ...splitMaskedText(original.value, replacements, (replacement) => {
          if (replacement.kind === "malformed") {
            unsupported.add("malformed-wikilink");
            return text(replacement.raw);
          }
          if (parent.type === "link") {
            unsupported.add("nested-custom-link");
            return text(replacement.raw);
          }
          const record = links.byTarget.get(replacement.target);
          if (record === undefined) {
            return text(replacement.raw);
          }
          if (replacement.kind === "embed") {
            const localWiki = replacement.raw.slice(1);
            return link(record.notionPageUrl, `Embed: ${localWiki}`, EMBED_LINK_TITLE);
          }
          return link(record.notionPageUrl, replacement.alias ?? replacement.target);
        }),
      );
      continue;
    }

    if (original.type === "html") {
      transformed.push(asLiteralForParent(original.value, parent));
      continue;
    }

    if (!isSupportedNode(original)) {
      const raw = restoreMaskTokens(nodeSource(source, original), replacements);
      transformed.push(asLiteralForParent(raw, parent));
      continue;
    }

    if (original.type === "link") {
      if (!safeLinkUrl(original.url)) {
        unsupported.add("unsafe-link-scheme");
        const raw = restoreMaskTokens(nodeSource(source, original), replacements);
        transformed.push(asLiteralForParent(raw, parent));
        continue;
      }
      const paired = links.byTarget.get(original.url);
      if (paired !== undefined && original.title === null) {
        original.url = paired.notionPageUrl;
        original.title = LOCAL_LINK_TITLE;
      }
    }

    if ("children" in original && Array.isArray(original.children)) {
      transformToNotion(original as Parent, source, replacements, links, unsupported);
    }
    transformed.push(original);
  }
  parent.children = transformed as Parent["children"];
}

function literalTokenPrefix(value: string): string {
  const usedSuffixes = new Set<number>();
  const pattern = /GRANDBOXLITERAL([0-9]{1,7})X/gu;
  for (const match of value.matchAll(pattern)) {
    usedSuffixes.add(Number(match[1]));
  }
  let suffix = 0;
  while (usedSuffixes.has(suffix)) {
    suffix += 1;
  }
  return `GRANDBOXLITERAL${suffix}X`;
}

function notionTextHandler(): TextHandle {
  return (node, _parent, state, info) => {
    const value = (node as Text).value;
    const prefix = literalTokenPrefix(value);
    const masked = value.replace(
      NOTION_LITERAL_SPECIALS,
      (character) => `${prefix}${character.codePointAt(0)?.toString(16).toUpperCase()}END`,
    );
    const safe = state.safe(masked, info);
    const tokenPattern = new RegExp(`${prefix}([0-9A-F]{1,6})END`, "gu");
    return safe.replace(tokenPattern, (_token, encoded: string) => {
      const codePoint = Number.parseInt(encoded, 16);
      return `\\${String.fromCodePoint(codePoint)}`;
    });
  };
}

function stringifyNotion(root: Root): string {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkStringify, {
      ...REMARK_STRINGIFY_OPTIONS,
      handlers: { text: notionTextHandler() },
    })
    .stringify(root);
}

function escapeLiteral(value: string): string {
  return value.replace(NOTION_LITERAL_SPECIALS, "\\$&");
}

class LocalTokenRegistry {
  readonly #replacements = new Map<string, string>();
  readonly #prefix: string;
  #index = 0;

  public constructor(source: string) {
    let suffix = 0;
    while (source.includes(`GRANDBOXLOCALTOKEN${suffix}X`)) {
      suffix += 1;
    }
    this.#prefix = `GRANDBOXLOCALTOKEN${suffix}X`;
  }

  public token(value: string): Text {
    const token = `${this.#prefix}${this.#index}END`;
    this.#index += 1;
    this.#replacements.set(token, value);
    return text(token);
  }

  public restore(markdown: string): string {
    let restored = markdown;
    for (const [token, value] of this.#replacements) {
      restored = restored.replaceAll(token, value);
    }
    return restored;
  }
}

function plainLinkLabel(node: Link): string | null {
  let label = "";
  for (const child of node.children) {
    if (child.type !== "text") {
      return null;
    }
    label += child.value;
  }
  return label;
}

function validAlias(value: string): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    utf8Length(value) <= MAX_LINK_TARGET_BYTES &&
    !/[|\[\]\r\n\u0000-\u001f\u007f]/u.test(value)
  );
}

function pairedEmbed(label: string, expectedTarget: string): ObsidianConstruct | null {
  if (!label.startsWith("Embed: ")) {
    return null;
  }
  const encoded = label.slice("Embed: ".length);
  const scan = scanObsidianText(encoded);
  const construct = scan.constructs[0];
  if (
    scan.malformed ||
    scan.constructs.length !== 1 ||
    construct === undefined ||
    construct.start !== 0 ||
    construct.end !== encoded.length ||
    construct.kind !== "wikilink" ||
    construct.target !== expectedTarget
  ) {
    return null;
  }
  return construct;
}

function classifyNotionTag(value: string): string {
  if (/^\s*<!--/u.test(value)) {
    return "html-comment";
  }
  if (/^\s*<\/?unknown\b/iu.test(value)) {
    return "notion-unknown-tag";
  }
  if (/^\s*<\/?(?:mention|notion)-/iu.test(value)) {
    return "notion-unsupported-tag";
  }
  return "raw-html";
}

function decodedHtmlKind(value: string): string | null {
  const match = /<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s|\/?>)/u.exec(value);
  if (match === null) {
    return null;
  }
  const name = (match[1] as string).toLowerCase();
  if (name === "unknown") {
    return "notion-unknown-tag";
  }
  if (name.startsWith("mention-") || name.startsWith("notion-")) {
    return "notion-unsupported-tag";
  }
  return "raw-html";
}

function isAsciiPunctuation(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    ((codePoint >= 0x21 && codePoint <= 0x2f) ||
      (codePoint >= 0x3a && codePoint <= 0x40) ||
      (codePoint >= 0x5b && codePoint <= 0x60) ||
      (codePoint >= 0x7b && codePoint <= 0x7e))
  );
}

function rawOffsetsForDecodedBoundaries(
  rawSource: string,
  decodedValue: string,
  boundaries: ReadonlySet<number>,
): ReadonlyMap<number, number> {
  let rawCursor = 0;
  let decodedCursor = 0;
  const offsets = new Map<number, number>();

  while (rawCursor < rawSource.length) {
    if (boundaries.has(decodedCursor)) {
      offsets.set(decodedCursor, rawCursor);
    }

    const rawCharacter = String.fromCodePoint(rawSource.codePointAt(rawCursor) as number);
    const escapedCharacter = rawCharacter === "\\"
      ? String.fromCodePoint(rawSource.codePointAt(rawCursor + rawCharacter.length) ?? 0)
      : "";
    const isEscape = rawCharacter === "\\" && isAsciiPunctuation(escapedCharacter);
    const decodedCharacter = isEscape ? escapedCharacter : rawCharacter;
    if (!decodedValue.startsWith(decodedCharacter, decodedCursor)) {
      return offsets;
    }
    rawCursor += rawCharacter.length + (isEscape ? escapedCharacter.length : 0);
    decodedCursor += decodedCharacter.length;
  }

  if (boundaries.has(decodedCursor)) {
    offsets.set(decodedCursor, rawCursor);
  }
  return offsets;
}

function splitDecodedCustomText(
  value: string,
  rawSource: string,
  registry: LocalTokenRegistry,
  unsupported: Set<string>,
): Nodes[] {
  const htmlKind = decodedHtmlKind(value);
  if (htmlKind !== null) {
    unsupported.add(htmlKind);
    return [registry.token(escapeLiteral(value))];
  }

  const scan = scanObsidianText(value);
  if (scan.malformed) {
    unsupported.add("malformed-wikilink");
    return [registry.token(value)];
  }
  if (scan.constructs.length === 0) {
    return [text(value)];
  }
  const decodedBoundaries = new Set<number>();
  for (const construct of scan.constructs) {
    decodedBoundaries.add(construct.start);
    decodedBoundaries.add(construct.end);
  }
  const rawOffsets = rawOffsetsForDecodedBoundaries(rawSource, value, decodedBoundaries);
  const nodes: Nodes[] = [];
  let cursor = 0;
  for (const construct of scan.constructs) {
    if (construct.start > cursor) {
      nodes.push(text(value.slice(cursor, construct.start)));
    }
    const rawStart = rawOffsets.get(construct.start);
    const rawEnd = rawOffsets.get(construct.end);
    const isAuthorized =
      rawStart !== undefined &&
      rawEnd !== undefined &&
      rawSource.slice(rawStart, rawEnd) === escapeLiteral(construct.raw);
    nodes.push(registry.token(isAuthorized ? construct.raw : escapeLiteral(construct.raw)));
    cursor = construct.end;
  }
  if (cursor < value.length) {
    nodes.push(text(value.slice(cursor)));
  }
  return nodes;
}

function transformFromNotion(
  parent: Parent,
  document: ParsedMarkdownDocument,
  links: LinkIndex,
  unsupported: Set<string>,
  registry: LocalTokenRegistry,
): void {
  const transformed: Nodes[] = [];
  for (const original of parent.children as Nodes[]) {
    if (original.type === "text") {
      transformed.push(
        ...splitDecodedCustomText(
          original.value,
          nodeSource(document.source, original),
          registry,
          unsupported,
        ),
      );
      continue;
    }

    if (original.type === "html") {
      unsupported.add(classifyNotionTag(original.value));
      transformed.push(asLiteralForParent(registry.token(escapeLiteral(original.value)).value, parent));
      continue;
    }

    if (!isSupportedNode(original)) {
      const raw = nodeSource(document.source, original);
      transformed.push(asLiteralForParent(registry.token(escapeLiteral(raw)).value, parent));
      continue;
    }

    if (original.type === "link") {
      if (!safeLinkUrl(original.url)) {
        unsupported.add("unsafe-link-scheme");
        const raw = nodeSource(document.source, original);
        transformed.push(asLiteralForParent(registry.token(escapeLiteral(raw)).value, parent));
        continue;
      }
      const paired = links.byUrl.get(original.url);
      if (paired !== undefined) {
        if (original.title === LOCAL_LINK_TITLE) {
          original.url = paired.localTarget;
          original.title = null;
          transformFromNotion(original, document, links, unsupported, registry);
          transformed.push(original);
          continue;
        }
        const label = plainLinkLabel(original);
        const embed =
          label === null || original.title !== EMBED_LINK_TITLE
            ? null
            : pairedEmbed(label, paired.localTarget);
        if (original.title !== null && original.title !== EMBED_LINK_TITLE) {
          unsupported.add("unsupported-paired-link-title");
        } else if (original.title === EMBED_LINK_TITLE && embed === null) {
          unsupported.add("invalid-embed-marker");
        } else if (label === null || (embed === null && !validAlias(label))) {
          unsupported.add("unsupported-paired-link-label");
        } else {
          const local = embed === null
            ? label === paired.localTarget
              ? `[[${paired.localTarget}]]`
              : `[[${paired.localTarget}|${label}]]`
            : `!${embed.raw}`;
          transformed.push(registry.token(local));
          continue;
        }
      }
    }

    if ("children" in original && Array.isArray(original.children)) {
      transformFromNotion(original as Parent, document, links, unsupported, registry);
    }
    transformed.push(original);
  }
  parent.children = transformed as Parent["children"];
}

export function toNotionMarkdown(note: SemanticNote, links: LinkMapping): MappingResult {
  const index = validateLinkMapping(links);
  const semantic = normalizeLocal(parseMarkdown(note.bodyMarkdown), note.tags);
  const document = parseMarkdown(semantic.bodyMarkdown);
  const masked = maskObsidianSyntax(document);
  const root = structuredClone(masked.root);
  const unsupported = new Set(document.unsupportedKinds);
  transformToNotion(root, masked.source, masked.replacements, index, unsupported);
  return {
    semantic,
    markdown: stringifyNotion(root),
    unsupportedKinds: sortedUnique(unsupported),
  };
}

export function fromNotionMarkdown(
  markdown: string,
  links: LinkMapping,
  tags: readonly string[] = [],
): MappingResult {
  const index = validateLinkMapping(links);
  const document = parseMarkdown(markdown);
  const root = structuredClone(document.root);
  const unsupported = new Set(
    document.unsupportedKinds.filter((kind) => kind !== "raw-html" && kind !== "html-comment"),
  );
  const registry = new LocalTokenRegistry(document.source);
  transformFromNotion(root, document, index, unsupported, registry);
  const bodyMarkdown = registry.restore(stringifyMarkdown(root));
  const semantic = { bodyMarkdown, tags: normalizeTags(tags) };
  return {
    semantic,
    markdown: bodyMarkdown,
    unsupportedKinds: sortedUnique(unsupported),
  };
}
