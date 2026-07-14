import type { Nodes, Root } from "mdast";
import { decodeString } from "micromark-util-decode-string";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";

export const MAX_MARKDOWN_BYTES = 1_048_576;

const MAX_AST_NODES = 16_384;
const MAX_AST_DEPTH = 64;
const MAX_CUSTOM_CONSTRUCTS = 4_096;
const MAX_CUSTOM_TARGET_BYTES = 1_024;

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

export interface ParsedMarkdownDocument {
  readonly source: string;
  readonly root: Root;
  readonly unsupportedKinds: string[];
}

export interface ObsidianConstruct {
  readonly kind: "wikilink" | "embed";
  readonly raw: string;
  readonly target: string;
  readonly alias: string | null;
  readonly start: number;
  readonly end: number;
}

export interface TextScan {
  readonly constructs: ObsidianConstruct[];
  readonly malformed: boolean;
}

export type MarkdownMaskReplacement =
  | ObsidianConstruct
  | { readonly kind: "malformed"; readonly raw: string };

export interface MarkdownMask {
  readonly root: Root;
  readonly source: string;
  readonly prefix: string;
  readonly replacements: ReadonlyMap<string, MarkdownMaskReplacement>;
}

export class MarkdownParseError extends Error {
  public constructor() {
    super("Invalid Markdown document");
    this.name = "MarkdownParseError";
  }
}

function invalidMarkdown(): MarkdownParseError {
  return new MarkdownParseError();
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseRoot(source: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(source);
}

function escapedAsciiPositions(value: string): Uint8Array {
  const escaped = new Uint8Array(value.length);
  let slashCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\") {
      slashCount += 1;
      continue;
    }
    if (slashCount % 2 === 1) {
      escaped[index] = 1;
    }
    slashCount = 0;
  }
  return escaped;
}

function isValidCustomPart(value: string): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    utf8Length(value) <= MAX_CUSTOM_TARGET_BYTES &&
    !/[\[\]\r\n\u0000-\u001f\u007f]/u.test(value)
  );
}

function scanTextSource(raw: string, absoluteStart: number): TextScan {
  const constructs: ObsidianConstruct[] = [];
  const escaped = escapedAsciiPositions(raw);
  let malformed = false;
  let cursor = 0;

  while (cursor < raw.length) {
    const embed = raw.startsWith("![[", cursor) && escaped[cursor] === 0;
    const wiki = !embed && raw.startsWith("[[", cursor) && escaped[cursor] === 0;
    if (!embed && !wiki) {
      cursor += 1;
      continue;
    }

    const openingLength = embed ? 3 : 2;
    const contentStart = cursor + openingLength;
    let close = -1;
    let nested = -1;
    let firstPipe = -1;
    let secondPipe = -1;
    let inner = contentStart;
    while (inner < raw.length) {
      if (escaped[inner] === 0 && raw.startsWith("[[", inner)) {
        nested = inner;
        break;
      }
      if (escaped[inner] === 0 && raw.startsWith("]]", inner)) {
        close = inner;
        break;
      }
      if (raw[inner] === "|" && escaped[inner] === 0) {
        if (firstPipe === -1) {
          firstPipe = inner;
        } else if (secondPipe === -1) {
          secondPipe = inner;
        }
      }
      inner += 1;
    }

    if (nested !== -1) {
      malformed = true;
      cursor = nested;
      continue;
    }
    if (close === -1) {
      malformed = true;
      break;
    }

    const content = raw.slice(contentStart, close);
    const relativePipe = firstPipe === -1 ? -1 : firstPipe - contentStart;
    const target = relativePipe === -1 ? content : content.slice(0, relativePipe);
    const alias = relativePipe === -1 ? null : content.slice(relativePipe + 1);
    if (
      secondPipe !== -1 ||
      !isValidCustomPart(target) ||
      (alias !== null && !isValidCustomPart(alias))
    ) {
      malformed = true;
      cursor = close + 2;
      continue;
    }

    const end = close + 2;
    constructs.push({
      kind: embed ? "embed" : "wikilink",
      raw: raw.slice(cursor, end),
      target,
      alias,
      start: absoluteStart + cursor,
      end: absoluteStart + end,
    });
    cursor = end;
  }

  return { constructs, malformed };
}

export function scanObsidianText(value: string): TextScan {
  return scanTextSource(value, 0);
}

function positionOffsets(node: Nodes): { readonly start: number; readonly end: number } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === "number" && typeof end === "number" ? { start, end } : null;
}

function visitTree(
  root: Root,
  visitor: (node: Nodes, depth: number) => void,
): void {
  let count = 0;
  const visit = (node: Nodes, depth: number): void => {
    count += 1;
    if (count > MAX_AST_NODES || depth > MAX_AST_DEPTH) {
      throw invalidMarkdown();
    }
    visitor(node, depth);
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children as Nodes[]) {
        visit(child, depth + 1);
      }
    }
  };
  visit(root, 0);
}

function unsupportedNodeKind(node: Nodes): string | null {
  if (SUPPORTED_NODE_TYPES.has(node.type)) {
    if (node.type === "code") {
      const language = node.lang?.toLowerCase() ?? "";
      if (["dataview", "dataviewjs", "tasks", "query"].includes(language)) {
        return "obsidian-plugin-construct";
      }
    }
    return null;
  }
  if (node.type === "html") {
    return /^\s*<!--/u.test(node.value) ? "html-comment" : "raw-html";
  }
  return `unsupported-${node.type.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function parseMarkdown(markdown: string): ParsedMarkdownDocument {
  try {
    if (typeof markdown !== "string" || utf8Length(markdown) > MAX_MARKDOWN_BYTES) {
      throw invalidMarkdown();
    }
    const source = normalizeLineEndings(markdown);
    const root = parseRoot(source);
    const unsupported = new Set<string>();

    visitTree(root, (node) => {
      const kind = unsupportedNodeKind(node);
      if (kind !== null) {
        unsupported.add(kind);
      }
      if (node.type === "text") {
        const offsets = positionOffsets(node);
        if (offsets !== null) {
          const raw = source.slice(offsets.start, offsets.end);
          if (scanTextSource(raw, offsets.start).malformed) {
            unsupported.add("malformed-wikilink");
          }
          if (raw.includes("%%")) {
            unsupported.add("obsidian-comment");
          }
        }
      }
    });

    return { source, root, unsupportedKinds: sortedUnique(unsupported) };
  } catch (caught) {
    if (caught instanceof MarkdownParseError) {
      throw caught;
    }
    throw invalidMarkdown();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function restoreSerializedSlashParity(slashes: string): string {
  return slashes.length % 2 === 0 ? slashes : `${slashes}\\`;
}

export function restoreSerializedTokens(
  value: string,
  tokenPattern: RegExp,
  restore: (token: string, slashes: string, bang: "!" | undefined) => string | undefined,
  onTokenPass?: () => void,
): string {
  const tokens: Array<{ readonly index: number; readonly value: string }> = [];
  onTokenPass?.();
  value.replace(tokenPattern, (token: string, offset: number): string => {
    tokens.push({ index: offset, value: token });
    return token;
  });
  if (tokens.length === 0) {
    return value;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const token of tokens) {
    let contextEnd = token.index;
    let bang: "!" | undefined;
    if (contextEnd > cursor && value[contextEnd - 1] === "!") {
      bang = "!";
      contextEnd -= 1;
    }
    let slashStart = contextEnd;
    while (slashStart > cursor && value[slashStart - 1] === "\\") {
      slashStart -= 1;
    }
    const replacement = restore(token.value, value.slice(slashStart, contextEnd), bang);
    if (replacement === undefined) {
      continue;
    }
    parts.push(value.slice(cursor, slashStart), replacement);
    cursor = token.index + token.value.length;
  }
  if (cursor === 0) {
    return value;
  }
  parts.push(value.slice(cursor));
  return parts.join("");
}

export function createDecodedTokenPrefix(
  document: ParsedMarkdownDocument,
  stem: string,
  additionalValues: Iterable<string> = [],
): string {
  const usedSuffixes = new Set<number>();
  const pattern = new RegExp(`${escapeRegExp(stem)}([0-9]{1,7})X`, "gu");
  const collect = (value: string): void => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
      usedSuffixes.add(Number(match[1]));
    }
  };

  collect(document.source);
  visitTree(document.root, (node) => {
    for (const value of Object.values(node)) {
      if (typeof value === "string") {
        collect(value);
      }
    }
  });
  for (const value of additionalValues) {
    collect(value);
  }

  let suffix = 0;
  while (usedSuffixes.has(suffix)) {
    suffix += 1;
  }
  return `${stem}${suffix}X`;
}

export function maskObsidianSyntax(document: ParsedMarkdownDocument): MarkdownMask {
  const edits: Array<{ readonly start: number; readonly end: number; readonly token: string }> = [];
  const replacements = new Map<string, MarkdownMaskReplacement>();
  const prefix = createDecodedTokenPrefix(document, "GRANDBOXWIKITOKEN");
  const root = structuredClone(document.root);
  let requiresReparse = false;
  let tokenIndex = 0;

  visitTree(root, (node) => {
    if (node.type !== "text") {
      return;
    }
    const offsets = positionOffsets(node);
    if (offsets === null) {
      return;
    }
    const raw = document.source.slice(offsets.start, offsets.end);
    const scan = scanTextSource(raw, offsets.start);
    const textEdits: Array<{ readonly start: number; readonly end: number; readonly token: string }> = [];
    if (scan.malformed) {
      if (tokenIndex >= MAX_CUSTOM_CONSTRUCTS) {
        throw invalidMarkdown();
      }
      const token = `${prefix}${tokenIndex}END`;
      tokenIndex += 1;
      edits.push({ start: offsets.start, end: offsets.end, token });
      replacements.set(token, { kind: "malformed", raw });
      textEdits.push({ start: 0, end: raw.length, token });
    } else {
      for (const construct of scan.constructs) {
        if (tokenIndex >= MAX_CUSTOM_CONSTRUCTS) {
          throw invalidMarkdown();
        }
        const token = `${prefix}${tokenIndex}END`;
        tokenIndex += 1;
        edits.push({ start: construct.start, end: construct.end, token });
        replacements.set(token, construct);
        textEdits.push({
          start: construct.start - offsets.start,
          end: construct.end - offsets.start,
          token,
        });
      }
    }

    if (textEdits.length === 0 || requiresReparse) {
      return;
    }
    if (decodeString(raw) !== node.value) {
      requiresReparse = true;
      return;
    }
    const parts: string[] = [];
    let cursor = 0;
    for (const edit of textEdits) {
      if (edit.start < cursor || edit.end < edit.start) {
        throw invalidMarkdown();
      }
      parts.push(raw.slice(cursor, edit.start), edit.token);
      cursor = edit.end;
    }
    parts.push(raw.slice(cursor));
    node.value = decodeString(parts.join(""));
  });

  let sourceCursor = 0;
  for (const edit of edits) {
    if (edit.start < sourceCursor || edit.end < edit.start) {
      throw invalidMarkdown();
    }
    sourceCursor = edit.end;
  }
  if (!requiresReparse) {
    return { source: document.source, root, prefix, replacements };
  }

  const sourceParts: string[] = [];
  sourceCursor = 0;
  for (const edit of edits) {
    sourceParts.push(document.source.slice(sourceCursor, edit.start), edit.token);
    sourceCursor = edit.end;
  }
  sourceParts.push(document.source.slice(sourceCursor));
  const source = sourceParts.join("");
  const masked = parseMarkdown(source);
  return { source, root: masked.root, prefix, replacements };
}

export function restoreMarkdownMask(
  value: string,
  mask: MarkdownMask,
  onTokenPass?: () => void,
): string {
  if (mask.replacements.size === 0) {
    return value;
  }
  const tokenPattern = new RegExp(`${escapeRegExp(mask.prefix)}[0-9]{1,7}END`, "gu");
  return restoreSerializedTokens(
    value,
    tokenPattern,
    (token, slashes, bang) => {
      const replacement = mask.replacements.get(token);
      if (replacement === undefined) {
        return undefined;
      }
      if (
        bang === "!" &&
        replacement.kind === "wikilink" &&
        slashes.length % 2 === 0
      ) {
        return `${slashes}\\!${replacement.raw}`;
      }
      const restoredSlashes =
        bang === undefined && replacement.kind !== "malformed"
          ? restoreSerializedSlashParity(slashes)
          : slashes;
      return `${restoredSlashes}${bang ?? ""}${replacement.raw}`;
    },
    onTokenPass,
  );
}
