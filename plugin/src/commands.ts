import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Pair,
  type ParsedNode,
  type YAMLMap,
} from "yaml";
import { hasGithubManagedTag, inspectGithubManagedBytes } from "@grandbox-bridge/shared";

const MAX_FRONTMATTER_BYTES = 65_536;
const MAX_YAML_DEPTH = 32;
const MAX_YAML_NODES = 1_024;
const MAX_TAG_BYTES = 256;
const MAX_TAG_COUNT = 128;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class NoteCommandError extends Error {
  public constructor() {
    super("Bridge note action unavailable");
    this.name = "NoteCommandError";
  }
}

export interface ChangeNoteOptInInput {
  readonly path: string;
  readonly bytes: string;
  readonly optedIn: boolean;
}

interface FrontmatterRange {
  readonly yamlStart: number;
  readonly closeStart: number;
  readonly lineEnding: "\n" | "\r\n";
}

interface ParsedFrontmatter {
  readonly range: FrontmatterRange;
  readonly notionSync: boolean | null;
  readonly notionSyncPair: Pair<ParsedNode, ParsedNode | null> | null;
  readonly tags: readonly string[];
}

interface ConversionBudget {
  nodes: number;
}

function invalid(): never {
  throw new NoteCommandError();
}

function excludedPath(path: unknown): boolean {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    return true;
  }
  const segments = path.split("/");
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  return (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.startsWith(".") || segment.toLowerCase() === "templates") ||
    segments.includes("Bridge Conflicts") ||
    basename.endsWith(".bridge-conflict.md") ||
    path === "Grandbox Bridge.md"
  );
}

export function isManageableMarkdownPath(path: unknown): path is string {
  return typeof path === "string" && path.toLowerCase().endsWith(".md") && !excludedPath(path);
}

function frontmatterRange(bytes: string): FrontmatterRange | null {
  const opening = bytes.startsWith("---\r\n") ? "\r\n" : bytes.startsWith("---\n") ? "\n" : null;
  if (opening === null) return null;
  const yamlStart = 3 + opening.length;
  const remaining = bytes.slice(yamlStart);
  const match = /(?:^|\n)---(?=\r?\n|$)/u.exec(remaining);
  if (match === null || match.index === undefined) invalid();
  const closeStart = yamlStart + match.index + (match[0].startsWith("\n") ? 1 : 0);
  if (Buffer.byteLength(bytes.slice(yamlStart, closeStart), "utf8") > MAX_FRONTMATTER_BYTES) invalid();
  return { yamlStart, closeStart, lineEnding: opening };
}

function assertSafeYamlNode(node: ParsedNode | null, depth: number, budget: ConversionBudget): void {
  if (node === null) return;
  budget.nodes += 1;
  if (
    budget.nodes > MAX_YAML_NODES ||
    depth > MAX_YAML_DEPTH ||
    isAlias(node) ||
    node.tag !== undefined ||
    ("anchor" in node && node.anchor !== undefined)
  ) {
    invalid();
  }

  if (isScalar(node)) {
    const value: unknown = node.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return;
    }
    invalid();
  }

  if (isSeq(node)) {
    for (const item of node.items) assertSafeYamlNode(item, depth + 1, budget);
    return;
  }

  if (isMap(node)) {
    const keys = new Set<string>();
    for (const pair of node.items) {
      const key = pair.key;
      if (
        !isScalar(key) ||
        typeof key.value !== "string" ||
        key.value === "<<" ||
        PROTOTYPE_KEYS.has(key.value) ||
        keys.has(key.value)
      ) {
        invalid();
      }
      keys.add(key.value);
      if (depth > 0 && key.value === "notion_sync") invalid();
      assertSafeYamlNode(key, depth + 1, budget);
      assertSafeYamlNode(pair.value, depth + 1, budget);
    }
    return;
  }

  invalid();
}

function pairForKey(root: YAMLMap.Parsed, key: string): Pair<ParsedNode, ParsedNode | null> | null {
  let found: Pair<ParsedNode, ParsedNode | null> | null = null;
  for (const pair of root.items) {
    if (isScalar(pair.key) && pair.key.value === key) {
      if (found !== null) invalid();
      found = pair;
    }
  }
  return found;
}

function tagValue(node: ParsedNode | null): string {
  if (!isScalar(node) || typeof node.value !== "string") invalid();
  const value = node.value;
  if (
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > MAX_TAG_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid();
  }
  return value;
}

function tagsFromRoot(root: YAMLMap.Parsed): readonly string[] {
  const pair = pairForKey(root, "tags");
  if (pair === null) return Object.freeze([]);
  const value = pair.value;
  const items = isSeq(value) ? value.items : [value];
  if (items.length > MAX_TAG_COUNT) invalid();
  return Object.freeze(items.map((item) => tagValue(item)));
}

function isSimpleRootNotionSyncField(
  bytes: string,
  range: FrontmatterRange,
  key: ParsedNode,
  value: ParsedNode | null,
): boolean {
  if (
    !isScalar(key) ||
    key.range === null ||
    key.range === undefined ||
    !isScalar(value) ||
    value.range === null ||
    value.range === undefined
  ) {
    return false;
  }
  const source = bytes.slice(range.yamlStart, range.closeStart);
  const lineStart = source.lastIndexOf("\n", key.range[0] - 1) + 1;
  const nextLine = source.indexOf("\n", value.range[1]);
  const line = source.slice(lineStart, nextLine === -1 ? source.length : nextLine);
  return /^[ \t]*notion_sync[ \t]*:[ \t]*(?:true|false)[ \t]*(?:#.*)?\r?$/u.test(line);
}

function parseFrontmatter(bytes: string, range: FrontmatterRange): ParsedFrontmatter {
  const yamlSource = bytes.slice(range.yamlStart, range.closeStart);
  if (/^%(?:YAML|TAG)\b/mu.test(yamlSource)) invalid();
  const document = parseDocument(yamlSource, {
    customTags: [],
    keepSourceTokens: true,
    logLevel: "error",
    merge: false,
    prettyErrors: false,
    resolveKnownTags: false,
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0 || document.warnings.length > 0) invalid();
  if (document.contents === null) {
    return { range, notionSync: null, notionSyncPair: null, tags: Object.freeze([]) };
  }
  if (!isMap(document.contents)) invalid();
  const root = document.contents;
  assertSafeYamlNode(root, 0, { nodes: 0 });

  const notionSyncPair = pairForKey(root, "notion_sync");
  let notionSync: boolean | null = null;
  if (notionSyncPair !== null) {
    const key = notionSyncPair.key;
    const value = notionSyncPair.value;
    if (
      !isScalar(key) ||
      key.type !== "PLAIN" ||
      !isScalar(value) ||
      typeof value.value !== "boolean" ||
      value.range === null ||
      value.range === undefined
    ) {
      invalid();
    }
    if (!isSimpleRootNotionSyncField(bytes, range, key, value)) invalid();
    notionSync = value.value;
  }
  return { range, notionSync, notionSyncPair, tags: tagsFromRoot(root) };
}

function isGeneratedGithubIdentity(bytes: string, tags: readonly string[]): boolean {
  return inspectGithubManagedBytes(bytes) !== "none" || hasGithubManagedTag(tags);
}

/**
 * Uses the same exact marker and parsed-tag semantics as the worker. Invalid
 * frontmatter is unsafe for an event-triggered write, so it also fails closed.
 */
export function isGeneratedGithubNote(bytes: unknown): boolean {
  if (typeof bytes !== "string" || inspectGithubManagedBytes(bytes) !== "none") return true;
  try {
    const range = frontmatterRange(bytes);
    if (range === null) return false;
    return hasGithubManagedTag(parseFrontmatter(bytes, range).tags);
  } catch {
    return true;
  }
}

function replaceRange(bytes: string, start: number, end: number, replacement: string): string {
  if (start < 0 || end < start || end > bytes.length) invalid();
  return `${bytes.slice(0, start)}${replacement}${bytes.slice(end)}`;
}

function updateExistingFrontmatter(bytes: string, parsed: ParsedFrontmatter, optedIn: boolean): string {
  const originalSuffix = bytes.slice(parsed.range.closeStart);
  let updated: string;
  if (parsed.notionSyncPair === null) {
    if (!optedIn) invalid();
    updated = replaceRange(
      bytes,
      parsed.range.closeStart,
      parsed.range.closeStart,
      `notion_sync: true${parsed.range.lineEnding}`,
    );
  } else {
    const value = parsed.notionSyncPair.value;
    if (!isScalar(value) || value.range === null || value.range === undefined) invalid();
    updated = replaceRange(
      bytes,
      parsed.range.yamlStart + value.range[0],
      parsed.range.yamlStart + value.range[1],
      optedIn ? "true" : "false",
    );
  }
  if (!updated.endsWith(originalSuffix)) invalid();
  const updatedRange = frontmatterRange(updated);
  if (updatedRange === null) invalid();
  const verified = parseFrontmatter(updated, updatedRange);
  if (verified.notionSync !== optedIn || isGeneratedGithubIdentity(updated, verified.tags)) invalid();
  return updated;
}

/** Changes only a plain root `notion_sync` scalar after bounded YAML validation. */
export function changeNoteOptIn(input: ChangeNoteOptInInput): string {
  if (typeof input !== "object" || input === null || typeof input.bytes !== "string" || typeof input.optedIn !== "boolean") invalid();
  if (!isManageableMarkdownPath(input.path) || isGeneratedGithubNote(input.bytes)) invalid();
  const range = frontmatterRange(input.bytes);
  if (range === null) {
    if (!input.optedIn) invalid();
    return `---\nnotion_sync: true\n---\n${input.bytes}`;
  }
  return updateExistingFrontmatter(input.bytes, parseFrontmatter(input.bytes, range), input.optedIn);
}
