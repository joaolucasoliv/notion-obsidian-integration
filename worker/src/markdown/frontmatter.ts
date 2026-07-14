import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type Pair,
  type ParsedNode,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

export const MAX_LOCAL_NOTE_BYTES = 1_048_576;

const MAX_FRONTMATTER_BYTES = 65_536;
const MAX_YAML_DEPTH = 32;
const MAX_YAML_NODES = 1_024;
const MAX_TAG_COUNT = 128;
const MAX_TAG_BYTES = 256;
const MAX_RELATIVE_PATH_BYTES = 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface ParsedLocalNote {
  path: string;
  bytes: string;
  frontmatter: Readonly<Record<string, unknown>>;
  body: string;
  notionSync: boolean;
  bridgeId: string | null;
  tags: string[];
}

export class LocalNoteParseError extends Error {
  public constructor() {
    super("Invalid local note");
    this.name = "LocalNoteParseError";
  }
}

interface FrontmatterBounds {
  readonly yamlStart: number;
  readonly closeStart: number;
  readonly bodyStart: number;
  readonly lineEnding: "\n" | "\r\n";
}

interface ParsedInternals {
  readonly note: ParsedLocalNote;
  readonly bounds: FrontmatterBounds | null;
  readonly root: YAMLMap.Parsed | null;
  readonly tagsPair: Pair<ParsedNode, ParsedNode | null> | null;
}

interface ConversionBudget {
  nodes: number;
}

function invalidLocalNote(): LocalNoteParseError {
  return new LocalNoteParseError();
}

function assertSafeRelativePath(path: string): void {
  const segments = path.split("/");
  const unsafe =
    path.length === 0 ||
    Buffer.byteLength(path, "utf8") > MAX_RELATIVE_PATH_BYTES ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    /[\r\n]/.test(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");

  if (unsafe) {
    throw invalidLocalNote();
  }
}

function locateFrontmatter(bytes: string): FrontmatterBounds | null {
  let yamlStart: number;
  let lineEnding: "\n" | "\r\n";
  if (bytes.startsWith("---\r\n")) {
    yamlStart = 5;
    lineEnding = "\r\n";
  } else if (bytes.startsWith("---\n")) {
    yamlStart = 4;
    lineEnding = "\n";
  } else {
    return null;
  }

  const remaining = bytes.slice(yamlStart);
  const closing = /(?:^|\n)(---)(?=\r?\n|$)/.exec(remaining);
  if (closing === null || closing.index === undefined) {
    throw invalidLocalNote();
  }

  const closeStart = yamlStart + closing.index + (closing[0].startsWith("\n") ? 1 : 0);
  const afterDelimiter = closeStart + 3;
  const bodyStart = bytes.startsWith("\r\n", afterDelimiter)
    ? afterDelimiter + 2
    : bytes.startsWith("\n", afterDelimiter)
      ? afterDelimiter + 1
      : afterDelimiter;

  if (Buffer.byteLength(bytes.slice(yamlStart, closeStart), "utf8") > MAX_FRONTMATTER_BYTES) {
    throw invalidLocalNote();
  }

  return { yamlStart, closeStart, bodyStart, lineEnding };
}

function assertSupportedNode(node: ParsedNode, depth: number, budget: ConversionBudget): void {
  budget.nodes += 1;
  if (
    budget.nodes > MAX_YAML_NODES ||
    depth > MAX_YAML_DEPTH ||
    isAlias(node) ||
    node.tag !== undefined ||
    ("anchor" in node && node.anchor !== undefined)
  ) {
    throw invalidLocalNote();
  }
}

function convertYamlNode(
  node: ParsedNode | null,
  depth: number,
  budget: ConversionBudget,
): unknown {
  if (node === null) {
    return null;
  }
  assertSupportedNode(node, depth, budget);

  if (isScalar(node)) {
    const value: unknown = node.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return value;
    }
    throw invalidLocalNote();
  }

  if (isSeq(node)) {
    const values = node.items.map((item) => convertYamlNode(item, depth + 1, budget));
    return Object.freeze(values);
  }

  if (isMap(node)) {
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const pair of node.items) {
      const key = pair.key;
      if (
        !isScalar(key) ||
        typeof key.value !== "string" ||
        key.value === "<<" ||
        PROTOTYPE_KEYS.has(key.value)
      ) {
        throw invalidLocalNote();
      }
      assertSupportedNode(key, depth + 1, budget);
      Object.defineProperty(record, key.value, {
        configurable: false,
        enumerable: true,
        value: convertYamlNode(pair.value, depth + 1, budget),
        writable: false,
      });
    }
    return Object.freeze(record);
  }

  throw invalidLocalNote();
}

function pairForKey(
  root: YAMLMap.Parsed,
  key: string,
): Pair<ParsedNode, ParsedNode | null> | null {
  for (const pair of root.items) {
    if (isScalar(pair.key) && pair.key.value === key) {
      return pair;
    }
  }
  return null;
}

function isCanonicalUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function assertValidTag(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > MAX_TAG_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalidLocalNote();
  }
}

function tagsFromOwnedValue(value: unknown): string[] {
  const candidates = Array.isArray(value) ? value : [value];
  if (candidates.length > MAX_TAG_COUNT) {
    throw invalidLocalNote();
  }
  for (const candidate of candidates) {
    assertValidTag(candidate);
  }
  return [...candidates] as string[];
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  if (!Array.isArray(tags) || tags.length > MAX_TAG_COUNT) {
    throw invalidLocalNote();
  }
  for (const tag of tags) {
    assertValidTag(tag);
  }
  return Object.freeze(
    [...new Set(tags)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function parseLocalNoteInternal(path: string, bytes: string): ParsedInternals {
  try {
    assertSafeRelativePath(path);
    if (typeof bytes !== "string" || Buffer.byteLength(bytes, "utf8") > MAX_LOCAL_NOTE_BYTES) {
      throw invalidLocalNote();
    }

    const bounds = locateFrontmatter(bytes);
    if (bounds === null) {
      const empty = Object.freeze(Object.create(null) as Record<string, unknown>);
      return {
        bounds: null,
        root: null,
        tagsPair: null,
        note: {
          path,
          bytes,
          frontmatter: empty,
          body: bytes,
          notionSync: false,
          bridgeId: null,
          tags: [],
        },
      };
    }

    const yamlSource = bytes.slice(bounds.yamlStart, bounds.closeStart);
    if (/^%(?:YAML|TAG)\b/m.test(yamlSource)) {
      throw invalidLocalNote();
    }
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
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw invalidLocalNote();
    }
    if (document.contents !== null && !isMap(document.contents)) {
      throw invalidLocalNote();
    }

    const root = document.contents;
    const converted = root === null
      ? Object.freeze(Object.create(null) as Record<string, unknown>)
      : convertYamlNode(root, 0, { nodes: 0 });
    if (typeof converted !== "object" || converted === null || Array.isArray(converted)) {
      throw invalidLocalNote();
    }
    const frontmatter = converted as Readonly<Record<string, unknown>>;

    const notionValue = frontmatter.notion_sync;
    if (notionValue !== undefined && typeof notionValue !== "boolean") {
      throw invalidLocalNote();
    }
    const bridgeValue = frontmatter.bridge_id;
    if (
      bridgeValue !== undefined &&
      (typeof bridgeValue !== "string" || !isCanonicalUuid(bridgeValue))
    ) {
      throw invalidLocalNote();
    }
    const tagsValue = frontmatter.tags;
    const tags = tagsValue === undefined ? [] : tagsFromOwnedValue(tagsValue);
    const tagsPair = root === null ? null : pairForKey(root, "tags");

    return {
      bounds,
      root,
      tagsPair,
      note: {
        path,
        bytes,
        frontmatter,
        body: bytes.slice(bounds.bodyStart),
        notionSync: notionValue === true,
        bridgeId: typeof bridgeValue === "string" ? bridgeValue : null,
        tags,
      },
    };
  } catch (caught) {
    if (caught instanceof LocalNoteParseError) {
      throw caught;
    }
    throw invalidLocalNote();
  }
}

export function parseLocalNote(path: string, bytes: string): ParsedLocalNote {
  return parseLocalNoteInternal(path, bytes).note;
}

function requireFrontmatter(bytes: string): ParsedInternals & { readonly bounds: FrontmatterBounds } {
  const parsed = parseLocalNoteInternal("note.md", bytes);
  if (parsed.bounds === null) {
    throw invalidLocalNote();
  }
  return parsed as ParsedInternals & { readonly bounds: FrontmatterBounds };
}

function replaceRange(bytes: string, start: number, end: number, replacement: string): string {
  if (start < 0 || end < start || end > bytes.length) {
    throw invalidLocalNote();
  }
  return `${bytes.slice(0, start)}${replacement}${bytes.slice(end)}`;
}

export function upsertBridgeId(bytes: string, id: string): string {
  if (typeof id !== "string" || !isCanonicalUuid(id)) {
    throw invalidLocalNote();
  }
  const parsed = requireFrontmatter(bytes);
  if (parsed.note.bridgeId !== null) {
    if (parsed.note.bridgeId === id) {
      return bytes;
    }
    throw invalidLocalNote();
  }

  const insertion = `bridge_id: ${id}${parsed.bounds.lineEnding}`;
  const updated = replaceRange(bytes, parsed.bounds.closeStart, parsed.bounds.closeStart, insertion);
  const verified = parseLocalNote("note.md", updated);
  if (
    verified.bridgeId !== id ||
    verified.notionSync !== parsed.note.notionSync ||
    verified.body !== parsed.note.body
  ) {
    throw invalidLocalNote();
  }
  return updated;
}

function renderTag(tag: string): string {
  const rendered = stringify(tag, { schema: "core" });
  return rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered;
}

function renderScalarTag(node: ParsedNode, tag: string): string {
  if (!isScalar(node)) {
    throw invalidLocalNote();
  }
  if (node.type === "QUOTE_SINGLE") {
    return `'${tag.replaceAll("'", "''")}'`;
  }
  if (node.type === "QUOTE_DOUBLE") {
    return JSON.stringify(tag);
  }
  return renderTag(tag);
}

function renderFlowTags(tags: readonly string[]): string {
  const rendered = stringify([...tags], {
    collectionStyle: "flow",
    flowCollectionPadding: false,
    lineWidth: 0,
    schema: "core",
  });
  return rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered;
}

function replaceBlockTags(
  bytes: string,
  parsed: ParsedInternals & { readonly bounds: FrontmatterBounds },
  sequence: YAMLSeq.Parsed,
  normalized: readonly string[],
): string {
  const key = parsed.tagsPair?.key;
  if (key === null || key === undefined || key.range === null || key.range === undefined) {
    throw invalidLocalNote();
  }
  if (normalized.length === 0) {
    return replaceRange(
      bytes,
      parsed.bounds.yamlStart + key.range[1],
      parsed.bounds.yamlStart + sequence.range[1],
      `: []${parsed.bounds.lineEnding}`,
    );
  }

  const yamlSource = bytes.slice(parsed.bounds.yamlStart, parsed.bounds.closeStart);
  const lineStart = yamlSource.lastIndexOf("\n", sequence.range[0] - 1) + 1;
  const indentation = yamlSource.slice(lineStart, sequence.range[0]);
  if (!/^[ \t]*$/.test(indentation)) {
    throw invalidLocalNote();
  }

  const suffixByTag = new Map<string, string>();
  for (const item of sequence.items) {
    if (
      item !== null &&
      isScalar(item) &&
      typeof item.value === "string" &&
      item.range !== null &&
      item.range !== undefined &&
      !suffixByTag.has(item.value)
    ) {
      suffixByTag.set(item.value, yamlSource.slice(item.range[1], item.range[2]));
    }
  }

  let replacement = "";
  for (const [index, tag] of normalized.entries()) {
    const suffix = suffixByTag.get(tag) ?? parsed.bounds.lineEnding;
    replacement += `${index === 0 ? "" : indentation}- ${renderTag(tag)}${suffix}`;
  }
  return replaceRange(
    bytes,
    parsed.bounds.yamlStart + sequence.range[0],
    parsed.bounds.yamlStart + sequence.range[1],
    replacement,
  );
}

export function replaceSyncedTags(bytes: string, tags: readonly string[]): string {
  const normalized = normalizeTags(tags);
  const parsed = requireFrontmatter(bytes);
  if (parsed.tagsPair === null) {
    if (normalized.length === 0) {
      return bytes;
    }
    const insertion = `tags: ${renderFlowTags(normalized)}${parsed.bounds.lineEnding}`;
    return replaceRange(bytes, parsed.bounds.closeStart, parsed.bounds.closeStart, insertion);
  }

  const value = parsed.tagsPair.value;
  if (value === null || value.range === null || value.range === undefined) {
    throw invalidLocalNote();
  }

  let updated: string;
  if (isSeq(value) && value.flow !== true) {
    updated = replaceBlockTags(bytes, parsed, value, normalized);
  } else {
    const replacement = isScalar(value) && normalized.length === 1
      ? renderScalarTag(value, normalized[0] as string)
      : renderFlowTags(normalized);
    updated = replaceRange(
      bytes,
      parsed.bounds.yamlStart + value.range[0],
      parsed.bounds.yamlStart + value.range[1],
      replacement,
    );
  }

  const verified = parseLocalNote("note.md", updated);
  if (
    verified.notionSync !== parsed.note.notionSync ||
    verified.bridgeId !== parsed.note.bridgeId ||
    verified.body !== parsed.note.body ||
    verified.tags.length !== normalized.length ||
    verified.tags.some((tag, index) => tag !== normalized[index])
  ) {
    throw invalidLocalNote();
  }
  return updated;
}
