import { sha256Hex, type SemanticNote } from "@grandbox-bridge/shared";
import type { Root } from "mdast";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import {
  MarkdownParseError,
  maskObsidianSyntax,
  normalizeLineEndings,
  restoreMarkdownMask,
  type ParsedMarkdownDocument,
} from "./parse.js";

const MAX_TAG_COUNT = 128;
const MAX_TAG_BYTES = 256;

export const REMARK_STRINGIFY_OPTIONS = Object.freeze({
  bullet: "-" as const,
  bulletOther: "+" as const,
  closeAtx: false,
  emphasis: "*" as const,
  fence: "`" as const,
  fences: true,
  incrementListMarker: true,
  listItemIndent: "one" as const,
  resourceLink: true,
  rule: "-" as const,
  ruleRepetition: 3,
  ruleSpaces: false,
  setext: false,
  strong: "*" as const,
});

function invalidMarkdown(): MarkdownParseError {
  return new MarkdownParseError();
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function compareCodePointStrings(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] as number) - (rightPoints[index] as number);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

export function normalizeTags(tags: readonly string[]): string[] {
  if (!Array.isArray(tags) || tags.length > MAX_TAG_COUNT) {
    throw invalidMarkdown();
  }
  for (const tag of tags) {
    if (
      typeof tag !== "string" ||
      tag.length === 0 ||
      tag.trim() !== tag ||
      utf8Length(tag) > MAX_TAG_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(tag)
    ) {
      throw invalidMarkdown();
    }
  }
  return [...new Set(tags)].sort(compareCodePointStrings);
}

export function stringifyMarkdown(root: Root): string {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkStringify, REMARK_STRINGIFY_OPTIONS)
    .stringify(root);
}

export interface NormalizeLocalOptions {
  readonly onMaskRestorationPass?: () => void;
}

export function normalizeLocal(
  document: ParsedMarkdownDocument,
  tags: readonly string[] = [],
  options: NormalizeLocalOptions = {},
): SemanticNote {
  const masked = maskObsidianSyntax(document);
  const bodyMarkdown = restoreMarkdownMask(
    stringifyMarkdown(masked.root),
    masked,
    options.onMaskRestorationPass,
  );
  return {
    bodyMarkdown: normalizeLineEndings(bodyMarkdown),
    tags: normalizeTags(tags),
  };
}

export async function semanticHash(note: SemanticNote): Promise<string> {
  const canonical = {
    bodyMarkdown: normalizeLineEndings(note.bodyMarkdown),
    tags: normalizeTags(note.tags),
  };
  return sha256Hex(JSON.stringify(canonical));
}
