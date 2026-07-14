import type { SemanticNote } from "@grandbox-bridge/shared";
import { decodeString } from "micromark-util-decode-string";
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
  createDecodedTokenPrefix,
  maskObsidianSyntax,
  parseMarkdown,
  restoreSerializedTokens,
  restoreSerializedSlashParity,
  restoreMarkdownMask,
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
const NOTION_LITERAL_SPECIAL_CHARACTERS = new Set([
  "\\",
  "*",
  "~",
  "`",
  "$",
  "[",
  "]",
  "<",
  ">",
  "{",
  "}",
  "|",
  "^",
]);
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

function restoreMaskTokens(raw: string, mask: MarkdownMask): string {
  return restoreMarkdownMask(raw, mask);
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

function splitMaskedText(
  value: string,
  mask: MarkdownMask,
  convert: (replacement: MaskReplacement) => Nodes,
): Nodes[] {
  const nodes: Nodes[] = [];
  let cursor = 0;
  const tokenPattern = new RegExp(`${mask.prefix}[0-9]{1,7}END`, "gu");
  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index;
    if (index === undefined) {
      throw invalidMapping();
    }
    if (index > cursor) {
      nodes.push(text(value.slice(cursor, index)));
    }
    const replacement = mask.replacements.get(token);
    if (replacement === undefined) {
      throw invalidMapping();
    }
    nodes.push(convert(replacement));
    cursor = index + token.length;
  }
  if (cursor < value.length) {
    nodes.push(text(value.slice(cursor)));
  }
  return nodes.length === 0 ? [text("")] : nodes;
}

function isSupportedNode(node: Nodes): boolean {
  return SUPPORTED_NODE_TYPES.has(node.type);
}

function transformToNotion(
  parent: Parent,
  mask: MarkdownMask,
  links: LinkIndex,
  unsupported: Set<string>,
  customValidationCache: Map<string, boolean>,
  hasLinkAncestor = false,
): void {
  const transformed: Nodes[] = [];
  for (const original of parent.children as Nodes[]) {
    if (original.type === "text") {
      transformed.push(
        ...splitMaskedText(original.value, mask, (replacement) => {
          if (replacement.kind === "malformed") {
            unsupported.add("malformed-wikilink");
            return text(replacement.raw);
          }
          if (hasLinkAncestor || parent.type === "link") {
            unsupported.add("nested-custom-link");
            return text(replacement.raw);
          }
          const record = links.byTarget.get(replacement.target);
          if (record === undefined) {
            return text(replacement.raw);
          }
          if (
            replacement.alias !== null &&
            !validCustomEmission(replacement.raw, replacement.kind, customValidationCache)
          ) {
            unsupported.add("unsupported-paired-link-label");
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
      const raw = restoreMaskTokens(nodeSource(mask.source, original), mask);
      transformed.push(asLiteralForParent(raw, parent));
      continue;
    }

    if (original.type === "link") {
      if (!safeLinkUrl(original.url)) {
        unsupported.add("unsafe-link-scheme");
        const raw = restoreMaskTokens(nodeSource(mask.source, original), mask);
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
      transformToNotion(
        original as Parent,
        mask,
        links,
        unsupported,
        customValidationCache,
        hasLinkAncestor || parent.type === "link",
      );
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

type LocalTokenKind = "embed" | "literal" | "wikilink";

class LocalTokenRegistry {
  readonly #replacements: Array<{ readonly kind: LocalTokenKind; readonly value: string }> = [];
  readonly #prefix: string;

  public constructor(document: ParsedMarkdownDocument, additionalValues: Iterable<string>) {
    this.#prefix = createDecodedTokenPrefix(
      document,
      "GRANDBOXLOCALTOKEN",
      additionalValues,
    );
  }

  public token(value: string, kind: LocalTokenKind = "literal"): Text {
    const index = this.#replacements.length;
    if (index > 9_999_999) {
      throw invalidMapping();
    }
    const token = `${this.#prefix}${index}END`;
    this.#replacements.push({ kind, value });
    return text(token);
  }

  public restore(markdown: string): string {
    if (this.#replacements.length === 0) {
      return markdown;
    }
    const tokenPattern = new RegExp(`${this.#prefix}[0-9]{1,7}END`, "gu");
    return restoreSerializedTokens(markdown, tokenPattern, (token, slashes, bang) => {
      const encodedIndex = token.slice(this.#prefix.length, -"END".length);
      const replacement = this.#replacements[Number(encodedIndex)];
      if (replacement === undefined) {
        return undefined;
      }
      if (
        bang === "!" &&
        replacement.kind === "wikilink" &&
        slashes.length % 2 === 0
      ) {
        return `${slashes}\\!${replacement.value}`;
      }
      const restoredSlashes =
        bang === undefined && replacement.kind !== "literal"
          ? restoreSerializedSlashParity(slashes)
          : slashes;
      return `${restoredSlashes}${bang ?? ""}${replacement.value}`;
    });
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
    !/[\\|\[\]\r\n\u0000-\u001f\u007f]/u.test(value)
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

function validCustomEmission(
  candidate: string,
  expectedKind: "wikilink" | "embed",
  cache: Map<string, boolean>,
): boolean {
  const key = `${expectedKind}\u0000${candidate}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  let valid = false;
  try {
    const document = parseMarkdown(candidate);
    const block = document.root.children[0];
    const child = block?.type === "paragraph" ? block.children[0] : undefined;
    const scan = scanObsidianText(candidate);
    const construct = scan.constructs[0];
    valid =
      document.unsupportedKinds.length === 0 &&
      document.root.children.length === 1 &&
      block?.type === "paragraph" &&
      block.children.length === 1 &&
      child?.type === "text" &&
      nodeSource(document.source, child) === candidate &&
      child.value === candidate &&
      !scan.malformed &&
      scan.constructs.length === 1 &&
      construct !== undefined &&
      construct.kind === expectedKind &&
      construct.start === 0 &&
      construct.end === candidate.length;
  } catch {
    valid = false;
  }
  cache.set(key, valid);
  return valid;
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

interface DecodedSourceSegment {
  readonly decoded: string;
  readonly kind: "escape" | "literal" | "reference";
  readonly rawEnd: number;
  readonly raw: string;
}

function nextDecodedSourceSegment(rawSource: string, rawCursor: number): DecodedSourceSegment {
  const rawCharacter = String.fromCodePoint(rawSource.codePointAt(rawCursor) as number);
  if (rawCharacter === "\\") {
    const escapedCharacter = String.fromCodePoint(
      rawSource.codePointAt(rawCursor + rawCharacter.length) ?? 0,
    );
    if (isAsciiPunctuation(escapedCharacter)) {
      const rawEnd = rawCursor + rawCharacter.length + escapedCharacter.length;
      return {
        decoded: escapedCharacter,
        kind: "escape",
        raw: rawSource.slice(rawCursor, rawEnd),
        rawEnd,
      };
    }
  }

  if (rawCharacter === "&") {
    const referenceLimit = Math.min(rawSource.length, rawCursor + 33);
    for (let end = rawCursor + 1; end < referenceLimit; end += 1) {
      if (rawSource[end] !== ";") {
        continue;
      }
      const candidate = rawSource.slice(rawCursor, end + 1);
      const decoded = decodeString(candidate);
      if (decoded !== candidate) {
        return { decoded, kind: "reference", raw: candidate, rawEnd: end + 1 };
      }
      break;
    }
  }

  return {
    decoded: rawCharacter,
    kind: "literal",
    raw: rawCharacter,
    rawEnd: rawCursor + rawCharacter.length,
  };
}

function rawOffsetsForDecodedBoundaries(
  rawSource: string,
  decodedValue: string,
  boundaries: ReadonlySet<number>,
): ReadonlyMap<number, number> | null {
  let rawCursor = 0;
  let decodedCursor = 0;
  const offsets = new Map<number, number>();

  while (rawCursor < rawSource.length && decodedCursor < decodedValue.length) {
    if (boundaries.has(decodedCursor)) {
      offsets.set(decodedCursor, rawCursor);
    }

    const segment = nextDecodedSourceSegment(rawSource, rawCursor);
    if (!decodedValue.startsWith(segment.decoded, decodedCursor)) {
      return null;
    }
    rawCursor = segment.rawEnd;
    decodedCursor += segment.decoded.length;
  }

  if (rawCursor !== rawSource.length || decodedCursor !== decodedValue.length) {
    return null;
  }
  if (boundaries.has(decodedValue.length)) {
    offsets.set(decodedValue.length, rawSource.length);
  }
  for (const boundary of boundaries) {
    if (!offsets.has(boundary)) {
      return null;
    }
  }
  return offsets;
}

function isAuthorizedRawConstruct(
  rawSource: string,
  construct: ObsidianConstruct,
): boolean {
  let rawCursor = 0;
  let decodedCursor = 0;
  while (rawCursor < rawSource.length && decodedCursor < construct.raw.length) {
    const segment = nextDecodedSourceSegment(rawSource, rawCursor);
    if (!construct.raw.startsWith(segment.decoded, decodedCursor)) {
      return false;
    }

    let segmentCursor = 0;
    for (const character of segment.decoded) {
      const characterLength = character.length;
      const absoluteDecodedCursor = decodedCursor + segmentCursor;
      if (NOTION_LITERAL_SPECIAL_CHARACTERS.has(character)) {
        if (segment.kind !== "escape" || segment.raw !== `\\${character}`) {
          return false;
        }
      } else if (segment.kind === "escape") {
        return false;
      }
      if (
        construct.kind === "embed" &&
        absoluteDecodedCursor === 0 &&
        character === "!" &&
        (segment.kind !== "literal" || segment.raw !== "!")
      ) {
        return false;
      }
      segmentCursor += characterLength;
    }

    rawCursor = segment.rawEnd;
    decodedCursor += segment.decoded.length;
  }
  return rawCursor === rawSource.length && decodedCursor === construct.raw.length;
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
  }
  if (scan.constructs.length === 0) {
    return [scan.malformed ? registry.token(escapeLiteral(value)) : text(value)];
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
      const before = value.slice(cursor, construct.start);
      nodes.push(scan.malformed ? registry.token(escapeLiteral(before)) : text(before));
    }
    const rawStart = rawOffsets?.get(construct.start);
    const rawEnd = rawOffsets?.get(construct.end);
    const isAuthorized =
      rawOffsets !== null &&
      rawStart !== undefined &&
      rawEnd !== undefined &&
      isAuthorizedRawConstruct(rawSource.slice(rawStart, rawEnd), construct);
    nodes.push(
      registry.token(
        isAuthorized ? construct.raw : escapeLiteral(construct.raw),
        isAuthorized ? construct.kind : "literal",
      ),
    );
    cursor = construct.end;
  }
  if (cursor < value.length) {
    const after = value.slice(cursor);
    nodes.push(scan.malformed ? registry.token(escapeLiteral(after)) : text(after));
  }
  return nodes;
}

function transformFromNotion(
  parent: Parent,
  document: ParsedMarkdownDocument,
  links: LinkIndex,
  unsupported: Set<string>,
  registry: LocalTokenRegistry,
  customValidationCache: Map<string, boolean>,
): void {
  const transformed: Nodes[] = [];
  const originalChildren = parent.children as Nodes[];
  for (let childIndex = 0; childIndex < originalChildren.length; childIndex += 1) {
    const original = originalChildren[childIndex] as Nodes;
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
          transformFromNotion(
            original,
            document,
            links,
            unsupported,
            registry,
            customValidationCache,
          );
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
          if (!validCustomEmission(local, embed === null ? "wikilink" : "embed", customValidationCache)) {
            unsupported.add("unsupported-paired-link-label");
            transformed.push(original);
            continue;
          } else {
            transformed.push(registry.token(local, embed === null ? "wikilink" : "embed"));
            continue;
          }
        }
      }
    }

    if ("children" in original && Array.isArray(original.children)) {
      transformFromNotion(
        original as Parent,
        document,
        links,
        unsupported,
        registry,
        customValidationCache,
      );
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
  transformToNotion(root, masked, index, unsupported, new Map());
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
  const registry = new LocalTokenRegistry(document, index.byTarget.keys());
  transformFromNotion(root, document, index, unsupported, registry, new Map());
  const bodyMarkdown = registry.restore(stringifyMarkdown(root));
  const semantic = { bodyMarkdown, tags: normalizeTags(tags) };
  return {
    semantic,
    markdown: bodyMarkdown,
    unsupportedKinds: sortedUnique(unsupported),
  };
}
