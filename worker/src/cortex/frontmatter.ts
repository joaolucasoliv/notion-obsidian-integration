import {
  parseLocalNote,
  upsertFrontmatterScalars,
  type ParsedLocalNote,
} from "../markdown/frontmatter.js";
import {
  CORTEX_ROOT_FILE_PATH,
  isCortexLocalPath,
} from "./path.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OWNED_KEYS = new Set([
  "cortex_tree",
  "cortex_page_id",
  "cortex_parent_page_id",
  "cortex_root_page_id",
]);

export class CortexFrontmatterError extends Error {
  public constructor() {
    super("Invalid Cortex frontmatter");
    this.name = "CortexFrontmatterError";
  }
}

export interface CortexFrontmatter {
  readonly cortexTree: true;
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly rootPageId: string;
}

export interface ParsedCortexLocalNote extends ParsedLocalNote {
  readonly cortex: CortexFrontmatter;
}

export type CortexFrontmatterInspection =
  | { readonly kind: "none" }
  | { readonly kind: "owned"; readonly cortex: CortexFrontmatter }
  | { readonly kind: "invalid" };

function invalidFrontmatter(): CortexFrontmatterError {
  return new CortexFrontmatterError();
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validateCortexFrontmatter(value: unknown): CortexFrontmatter {
  if (
    typeof value !== "object" ||
    value === null ||
    !((value as { cortexTree?: unknown }).cortexTree === true) ||
    !isCanonicalUuid((value as { pageId?: unknown }).pageId) ||
    !isCanonicalUuid((value as { rootPageId?: unknown }).rootPageId) ||
    (((value as { parentPageId?: unknown }).parentPageId !== null) &&
      !isCanonicalUuid((value as { parentPageId?: unknown }).parentPageId))
  ) {
    throw invalidFrontmatter();
  }
  const cortex = value as CortexFrontmatter;
  if (
    (cortex.pageId === cortex.rootPageId && cortex.parentPageId !== null) ||
    (cortex.pageId !== cortex.rootPageId && cortex.parentPageId === null)
  ) {
    throw invalidFrontmatter();
  }
  return cortex;
}

/**
 * Separates a valid Cortex ownership envelope from unrelated YAML without
 * widening the legacy ParsedLocalNote contract.
 */
export function inspectCortexFrontmatter(note: ParsedLocalNote): CortexFrontmatterInspection {
  try {
    const fields = note.frontmatter;
    const keys = Object.keys(fields).filter((key) => key.startsWith("cortex_"));
    if (keys.length === 0) return { kind: "none" };
    if (keys.length !== OWNED_KEYS.size || keys.some((key) => !OWNED_KEYS.has(key))) return { kind: "invalid" };
    if (fields.cortex_tree !== true || note.notionSync) return { kind: "invalid" };

    const cortex = validateCortexFrontmatter({
      cortexTree: fields.cortex_tree,
      pageId: fields.cortex_page_id,
      parentPageId: fields.cortex_parent_page_id,
      rootPageId: fields.cortex_root_page_id,
    });
    if (cortex.pageId === cortex.rootPageId) {
      if (note.path !== CORTEX_ROOT_FILE_PATH) return { kind: "invalid" };
    } else if (!isCortexLocalPath(note.path) || note.path === CORTEX_ROOT_FILE_PATH || !note.path.endsWith(".md")) {
      return { kind: "invalid" };
    }
    return { kind: "owned", cortex: Object.freeze({ ...cortex }) };
  } catch {
    return { kind: "invalid" };
  }
}

export function parseCortexLocalNote(path: string, bytes: string): ParsedCortexLocalNote {
  const note = parseLocalNote(path, bytes);
  const inspected = inspectCortexFrontmatter(note);
  if (inspected.kind !== "owned") throw invalidFrontmatter();
  return { ...note, cortex: inspected.cortex };
}

/**
 * Adds or updates only the four Cortex-owned frontmatter keys. The generic
 * scalar editor preserves every non-Cortex key, comment, order, and body byte.
 */
export function upsertCortexFrontmatter(bytes: string, cortex: CortexFrontmatter): string {
  const validated = validateCortexFrontmatter(cortex);
  const current = parseLocalNote("note.md", bytes);
  if (current.notionSync) throw invalidFrontmatter();
  const existingCortexKeys = Object.keys(current.frontmatter).filter((key) => key.startsWith("cortex_"));
  if (existingCortexKeys.length > 0) {
    const existingPageId = current.frontmatter.cortex_page_id;
    const existingRootPageId = current.frontmatter.cortex_root_page_id;
    const existingPath = existingPageId === existingRootPageId
      ? CORTEX_ROOT_FILE_PATH
      : "The Cortex/verification.md";
    try {
      parseCortexLocalNote(existingPath, bytes);
    } catch {
      throw invalidFrontmatter();
    }
  }

  const updated = upsertFrontmatterScalars(bytes, [
    { key: "cortex_tree", value: true },
    { key: "cortex_page_id", value: validated.pageId },
    { key: "cortex_parent_page_id", value: validated.parentPageId },
    { key: "cortex_root_page_id", value: validated.rootPageId },
  ]);
  const verificationPath = validated.pageId === validated.rootPageId
    ? CORTEX_ROOT_FILE_PATH
    : "The Cortex/verification.md";
  const verified = parseCortexLocalNote(verificationPath, updated);
  if (
    verified.cortex.pageId !== validated.pageId ||
    verified.cortex.parentPageId !== validated.parentPageId ||
    verified.cortex.rootPageId !== validated.rootPageId ||
    verified.body !== current.body
  ) {
    throw invalidFrontmatter();
  }
  return updated;
}
