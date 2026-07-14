import type { SemanticNote } from "@grandbox-bridge/shared";

const MAX_RELATIVE_PATH_BYTES = 1_024;
const MAX_TITLE_BYTES = 1_024;
const MAX_URL_BYTES = 2_048;
const MAX_SEMANTIC_BODY_BYTES = 1_048_576;
const MAX_ARTIFACT_BYTES = 2_228_224;
const MAX_TAG_COUNT = 128;
const MAX_TAG_BYTES = 256;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ConflictArtifactInput {
  readonly bridgeId: string;
  readonly conflictDate: string;
  readonly localPath: string;
  readonly localTitle: string;
  readonly notionPageUrl: string;
  readonly localSemantic: Readonly<SemanticNote>;
  readonly notionSemantic: Readonly<SemanticNote>;
}

export class ConflictArtifactError extends Error {
  public readonly kind: "invalid" | "too-large";

  public constructor(kind: "invalid" | "too-large") {
    super("Invalid conflict artifact");
    this.name = "ConflictArtifactError";
    this.kind = kind;
  }
}

function invalidArtifact(): ConflictArtifactError {
  return new ConflictArtifactError("invalid");
}

function tooLargeArtifact(): ConflictArtifactError {
  return new ConflictArtifactError("too-large");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] as number) - (rightPoints[index] as number);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    byteLength(value) > MAX_RELATIVE_PATH_BYTES ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    /[\r\n]/u.test(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isStrictCalendarDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysByMonth[month - 1] as number);
}

function canonicalPageId(value: string): string | null {
  const compact = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(compact)) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function isValidatedNotionPageUrl(value: unknown): value is string {
  if (typeof value !== "string" || byteLength(value) > MAX_URL_BYTES || /[\u0000-\u0020\u007f\\]/u.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const trustedHost =
      parsed.hostname === "notion.so" ||
      parsed.hostname.endsWith(".notion.so") ||
      parsed.hostname === "notion.site" ||
      parsed.hostname.endsWith(".notion.site");
    if (
      parsed.protocol !== "https:" ||
      !trustedHost ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.href !== value
    ) {
      return false;
    }
    const match = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(parsed.pathname);
    return match !== null && canonicalPageId(match[1] as string) !== null;
  } catch {
    return false;
  }
}

function isValidTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    byteLength(value) <= MAX_TITLE_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function normalizeTags(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_TAG_COUNT) throw invalidArtifact();
  const tags: string[] = [];
  for (const tag of value) {
    if (
      typeof tag !== "string" ||
      tag.length === 0 ||
      tag.trim() !== tag ||
      byteLength(tag) > MAX_TAG_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(tag)
    ) {
      throw invalidArtifact();
    }
    tags.push(tag);
  }
  return Object.freeze([...new Set(tags)].sort(compareCodePoints));
}

function validateSemantic(value: unknown): value is Readonly<SemanticNote> {
  if (!hasExactKeys(value, ["bodyMarkdown", "tags"]) || typeof value.bodyMarkdown !== "string") {
    return false;
  }
  if (byteLength(value.bodyMarkdown) > MAX_SEMANTIC_BODY_BYTES) {
    throw tooLargeArtifact();
  }
  normalizeTags(value.tags);
  return true;
}

function validateInput(value: unknown): asserts value is ConflictArtifactInput {
  if (
    !hasExactKeys(value, [
      "bridgeId",
      "conflictDate",
      "localPath",
      "localTitle",
      "notionPageUrl",
      "localSemantic",
      "notionSemantic",
    ]) ||
    !isCanonicalUuid(value.bridgeId) ||
    !isStrictCalendarDay(value.conflictDate) ||
    !isSafeRelativePath(value.localPath) ||
    !isValidTitle(value.localTitle) ||
    !isValidatedNotionPageUrl(value.notionPageUrl) ||
    !validateSemantic(value.localSemantic) ||
    !validateSemantic(value.notionSemantic)
  ) {
    throw invalidArtifact();
  }
}

function trimDangerousEdges(value: string): string {
  return value.replace(/^[. ]+|[. ]+$/gu, "");
}

function capUtf8(value: string, maximum: number): string {
  let used = 0;
  let result = "";
  for (const character of value) {
    const width = byteLength(character);
    if (used + width > maximum) break;
    result += character;
    used += width;
  }
  return result;
}

export function safeConflictName(localTitle: string): string {
  const normalized = localTitle.normalize("NFC");
  const stem = normalized.toLowerCase().endsWith(".md") ? normalized.slice(0, -3) : normalized;
  let result = "";
  let replacingUnsafeRun = false;
  for (const character of stem) {
    if (/[\p{L}\p{N} ._-]/u.test(character)) {
      result += character;
      replacingUnsafeRun = false;
    } else if (!replacingUnsafeRun) {
      result += "-";
      replacingUnsafeRun = true;
    }
  }
  const capped = trimDangerousEdges(capUtf8(result, 160));
  return capped.length === 0 ? "Note" : capped;
}

export function conflictArtifactPath(input: ConflictArtifactInput): string {
  validateInput(input);
  const path = `Bridge Conflicts/${input.conflictDate}/${safeConflictName(input.localTitle)} — ${input.bridgeId}.md`;
  if (!isSafeRelativePath(path)) throw invalidArtifact();
  return path;
}

function longestRun(value: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const candidate of value) {
    if (candidate === character) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function collisionSafeFence(input: ConflictArtifactInput, localTags: readonly string[], notionTags: readonly string[]): string {
  const values = [
    input.localSemantic.bodyMarkdown,
    input.notionSemantic.bodyMarkdown,
    JSON.stringify(localTags),
    JSON.stringify(notionTags),
  ];
  const maximum = values.reduce((current, value) => Math.max(current, longestRun(value, "~")), 0);
  return "~".repeat(Math.max(3, maximum + 3));
}

function fenced(value: string, fence: string, info: string): string {
  return `${fence}${info}\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}`;
}

function escapedLinkLabel(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+.!|~-]/gu, "\\$&");
}

function localObsidianUrl(path: string): string {
  return `obsidian://open?path=${path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export function renderConflictArtifact(input: ConflictArtifactInput): string {
  validateInput(input);
  const localTags = normalizeTags(input.localSemantic.tags);
  const notionTags = normalizeTags(input.notionSemantic.tags);
  const fence = collisionSafeFence(input, localTags, notionTags);
  const artifact = [
    "# Grandbox Bridge conflict",
    "",
    `Local note: [${escapedLinkLabel(input.localTitle)}](<${localObsidianUrl(input.localPath)}>)`,
    `Notion page: [Open in Notion](<${input.notionPageUrl}>)`,
    "",
    "## Local semantic note",
    "",
    "Tags",
    fenced(JSON.stringify(localTags), fence, "json"),
    "",
    "Body",
    fenced(input.localSemantic.bodyMarkdown, fence, "text"),
    "",
    "## Notion semantic note",
    "",
    "Tags",
    fenced(JSON.stringify(notionTags), fence, "json"),
    "",
    "Body",
    fenced(input.notionSemantic.bodyMarkdown, fence, "text"),
    "",
  ].join("\n");
  if (byteLength(artifact) > MAX_ARTIFACT_BYTES) throw tooLargeArtifact();
  return artifact;
}
