import {
  SAFE_ERROR_CODES,
  sha256Hex,
  type CortexPageObservation,
  type CortexTreeConfigV1,
  type CortexTreeDiscovery,
  type CortexTreeNotionApi,
  type SafeError,
  type SafeErrorCode,
} from "@grandbox-bridge/shared";
import { parseCortexLocalNote } from "./frontmatter.js";
import { stripCortexManagedMarkdown } from "./markdown.js";
import { cortexParentFilePath } from "./path.js";
import { cortexSemanticHash } from "./semantic.js";
import {
  scanCortexVaultNotes,
  type ScannedCortexVaultNote,
} from "../vault/scanner.js";
import type { CanonicalVaultRoot } from "../vault/safety.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CHILD_PAGE_MARKER = /<!-- grandbox-cortex:child-page:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) -->/gu;
const MAX_DEPTH = 32;
const MAX_PAGES = 5_000;

export interface CortexLocalPage {
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly rootPageId: string;
  readonly path: string;
  readonly title: string;
  readonly bytes: string;
  readonly byteHash: string;
  /** The raw page body with Bridge-owned hierarchy controls removed. */
  readonly sourceMarkdown: string;
  readonly semanticHash: string;
  /** Hash of the deterministic direct-child identity list represented locally. */
  readonly structureHash: string;
  readonly directChildPageIds: readonly string[];
}

export interface CortexLocalCandidate {
  readonly path: string;
  readonly parentPageId: string;
  readonly parentPath: string;
  readonly title: string;
  readonly bytes: string;
  readonly byteHash: string;
  readonly sourceMarkdown: string;
  readonly semanticHash: string;
}

export interface CortexReconciliationDependencies {
  readonly notion: CortexTreeNotionApi;
  /** A test seam; production callers leave this undefined and supply `root`. */
  readonly scan?: () => Promise<readonly ScannedCortexVaultNote[]>;
  readonly root?: CanonicalVaultRoot;
  readonly maxDepth?: number;
  readonly maxPages?: number;
  /** Paths owned by legacy direct pairs that must remain disjoint from Cortex. */
  readonly legacyPaths?: readonly string[];
}

export interface CortexReconciliationResult {
  readonly config: CortexTreeConfigV1;
  readonly discovery: CortexTreeDiscovery | null;
  readonly localPages: readonly CortexLocalPage[];
  readonly localCandidates: readonly CortexLocalCandidate[];
  readonly invalidPaths: readonly string[];
  readonly legacyPaths: readonly string[];
  /** True only when both discovery and the reserved-tree scan can prove absence. */
  readonly canClassifyAbsence: boolean;
  readonly error: SafeError | null;
}

function safeError(code: SafeErrorCode, retryable = false): SafeError {
  return Object.freeze({ code, retryable });
}

function safeErrorFrom(caught: unknown, fallback: SafeErrorCode): SafeError {
  if (
    typeof caught === "object" &&
    caught !== null &&
    "code" in caught &&
    typeof caught.code === "string" &&
    SAFE_ERROR_CODES.includes(caught.code as SafeErrorCode)
  ) {
    return safeError(caught.code as SafeErrorCode, "retryable" in caught && caught.retryable === true);
  }
  return safeError(fallback);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validConfig(config: CortexTreeConfigV1): boolean {
  return (
    config !== null &&
    typeof config === "object" &&
    isCanonicalUuid(config.rootPageId) &&
    config.rootFilePath === "The Cortex.md" &&
    config.rootDirectoryPath === "The Cortex"
  );
}

function validLimit(value: number | undefined, fallback: number, maximum: number, minimum = 1): number | null {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function titleForPath(path: string): string | null {
  const name = path.split("/").at(-1);
  if (name === undefined || !name.endsWith(".md") || name.length <= 3) return null;
  return name.slice(0, -3);
}

function emptyResult(config: CortexTreeConfigV1, error: SafeError): CortexReconciliationResult {
  return Object.freeze({
    config,
    discovery: null,
    localPages: Object.freeze([]),
    localCandidates: Object.freeze([]),
    invalidPaths: Object.freeze([]),
    legacyPaths: Object.freeze([]),
    canClassifyAbsence: false,
    error,
  });
}

interface PreliminaryOwned {
  readonly path: string;
  readonly bytes: string;
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly rootPageId: string;
}

/**
 * Child order is owned by the terminal marker sequence, not the incidental
 * filesystem enumeration order.  `stripCortexManagedMarkdown` below still
 * validates that these are the exact terminal controls; this helper only
 * supplies their identity order and proves it matches the direct local set.
 */
function orderedChildPageIds(markdown: string, children: readonly PreliminaryOwned[]): readonly string[] {
  const matcher = new RegExp(CHILD_PAGE_MARKER.source, CHILD_PAGE_MARKER.flags);
  const ids = [...markdown.matchAll(matcher)].map((match) => match[1]);
  if (ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) throw new Error("invalid child markers");
  const expected = new Set(children.map((child) => child.pageId));
  if (ids.length !== expected.size || ids.some((id) => id === undefined || !expected.has(id))) {
    throw new Error("child marker identity mismatch");
  }
  return Object.freeze(ids.filter((id): id is string => id !== undefined));
}

async function materializeLocal(
  config: CortexTreeConfigV1,
  scanned: readonly ScannedCortexVaultNote[],
): Promise<Readonly<{
  pages: readonly CortexLocalPage[];
  candidates: readonly CortexLocalCandidate[];
  invalidPaths: readonly string[];
}>> {
  const preliminaries: PreliminaryOwned[] = [];
  const invalidPaths = new Set<string>();
  const rawCandidates: Array<Extract<ScannedCortexVaultNote, { readonly kind: "candidate" }>> = [];

  for (const entry of scanned) {
    if (entry.kind === "invalid") {
      invalidPaths.add(entry.path);
      continue;
    }
    if (entry.kind === "candidate") {
      rawCandidates.push(entry);
      continue;
    }
    if (entry.kind === "unpaired") continue;
    try {
      const parsed = parseCortexLocalNote(entry.path, entry.note.bytes);
      if (
        parsed.cortex.pageId !== entry.cortex.pageId ||
        parsed.cortex.parentPageId !== entry.cortex.parentPageId ||
        parsed.cortex.rootPageId !== config.rootPageId
      ) {
        invalidPaths.add(entry.path);
        continue;
      }
      preliminaries.push(Object.freeze({
        path: entry.path,
        bytes: entry.note.bytes,
        pageId: parsed.cortex.pageId,
        parentPageId: parsed.cortex.parentPageId,
        rootPageId: parsed.cortex.rootPageId,
      }));
    } catch {
      invalidPaths.add(entry.path);
    }
  }

  preliminaries.sort((left, right) => compare(left.path, right.path));
  const byId = new Map<string, PreliminaryOwned>();
  const byPath = new Map<string, PreliminaryOwned>();
  for (const entry of preliminaries) {
    if (byId.has(entry.pageId) || byPath.has(entry.path)) {
      invalidPaths.add(entry.path);
      continue;
    }
    byId.set(entry.pageId, entry);
    byPath.set(entry.path, entry);
  }

  const pages: CortexLocalPage[] = [];
  for (const entry of preliminaries) {
    if (byId.get(entry.pageId) !== entry) continue;
    const title = titleForPath(entry.path);
    const parentPath = entry.parentPageId === null
      ? null
      : byId.get(entry.parentPageId)?.path ?? null;
    if (
      title === null ||
      (entry.pageId === config.rootPageId && (entry.parentPageId !== null || entry.path !== config.rootFilePath)) ||
      (entry.pageId !== config.rootPageId && (entry.parentPageId === null || parentPath === null))
    ) {
      invalidPaths.add(entry.path);
      continue;
    }
    const children = preliminaries
      .filter((candidate) => candidate.parentPageId === entry.pageId && byId.get(candidate.pageId) === candidate);
    try {
      const parsed = parseCortexLocalNote(entry.path, entry.bytes);
      const directChildPageIds = orderedChildPageIds(parsed.body, children);
      const sourceMarkdown = stripCortexManagedMarkdown({
        markdown: parsed.body,
        expectedParentWikiLink: parentPath,
        expectedChildPageIds: directChildPageIds,
      });
      pages.push(Object.freeze({
        pageId: entry.pageId,
        parentPageId: entry.parentPageId,
        rootPageId: entry.rootPageId,
        path: entry.path,
        title,
        bytes: entry.bytes,
        byteHash: await sha256Hex(entry.bytes),
        sourceMarkdown,
        semanticHash: await cortexSemanticHash(sourceMarkdown),
        structureHash: await sha256Hex(JSON.stringify(directChildPageIds)),
        directChildPageIds,
      }));
    } catch {
      invalidPaths.add(entry.path);
    }
  }

  const validByPath = new Map(pages.map((page) => [page.path, page]));
  const candidates: CortexLocalCandidate[] = [];
  for (const entry of rawCandidates.sort((left, right) => compare(left.path, right.path))) {
    try {
      const parentPath = cortexParentFilePath(entry.path);
      const parent = validByPath.get(parentPath);
      const title = titleForPath(entry.path);
      if (parent === undefined || title === null || parent.pageId === config.rootPageId && parent.path !== config.rootFilePath) {
        invalidPaths.add(entry.path);
        continue;
      }
      candidates.push(Object.freeze({
        path: entry.path,
        parentPageId: parent.pageId,
        parentPath,
        title,
        bytes: entry.note.bytes,
        byteHash: await sha256Hex(entry.note.bytes),
        sourceMarkdown: entry.note.body,
        semanticHash: await cortexSemanticHash(entry.note.body),
      }));
    } catch {
      invalidPaths.add(entry.path);
    }
  }

  return Object.freeze({
    pages: Object.freeze(pages.sort((left, right) => compare(left.path, right.path))),
    candidates: Object.freeze(candidates.sort((left, right) => compare(left.path, right.path))),
    invalidPaths: Object.freeze([...invalidPaths].sort(compare)),
  });
}

/**
 * Obtains the remote tree before touching the reserved local subtree.  This
 * order is a safety boundary: a provider failure can never be reinterpreted
 * as local/remote absence evidence.
 */
export async function reconcileCortexTree(
  config: CortexTreeConfigV1,
  dependencies: CortexReconciliationDependencies,
): Promise<CortexReconciliationResult> {
  if (!validConfig(config) || dependencies === null || typeof dependencies !== "object" || dependencies.notion === null) {
    return emptyResult(config, safeError("invalid-config"));
  }
  const maxDepth = validLimit(dependencies.maxDepth, MAX_DEPTH, MAX_DEPTH, 0);
  const maxPages = validLimit(dependencies.maxPages, MAX_PAGES, MAX_PAGES);
  if (maxDepth === null || maxPages === null) return emptyResult(config, safeError("invalid-config"));

  let discovery: CortexTreeDiscovery;
  try {
    discovery = await dependencies.notion.discoverCortexTree({ rootPageId: config.rootPageId, maxDepth, maxPages });
    if (discovery.rootPageId !== config.rootPageId || !Array.isArray(discovery.pages) || !Array.isArray(discovery.attention)) {
      return emptyResult(config, safeError("invalid-response"));
    }
  } catch (caught) {
    // Do not scan locally after failed remote discovery: absence is unprovable.
    return emptyResult(config, safeErrorFrom(caught, "network-failed"));
  }

  let scanned: readonly ScannedCortexVaultNote[];
  try {
    if (dependencies.scan !== undefined) {
      scanned = await dependencies.scan();
    } else if (dependencies.root !== undefined) {
      scanned = await scanCortexVaultNotes(dependencies.root);
    } else {
      return emptyResult(config, safeError("invalid-config"));
    }
    if (!Array.isArray(scanned)) return emptyResult(config, safeError("invalid-response"));
  } catch (caught) {
    return emptyResult(config, safeErrorFrom(caught, "unsafe-path"));
  }

  try {
    const local = await materializeLocal(config, scanned);
    const legacyPathsInput = dependencies.legacyPaths;
    if (legacyPathsInput !== undefined && !Array.isArray(legacyPathsInput)) {
      return emptyResult(config, safeError("invalid-config"));
    }
    if (legacyPathsInput?.some((path) => typeof path !== "string")) return emptyResult(config, safeError("invalid-config"));
    const legacyPaths = legacyPathsInput === undefined
      ? []
      : [...new Set(legacyPathsInput)].sort(compare);
    return Object.freeze({
      config,
      discovery,
      localPages: local.pages,
      localCandidates: local.candidates,
      invalidPaths: local.invalidPaths,
      legacyPaths: Object.freeze(legacyPaths),
      canClassifyAbsence: discovery.complete && local.invalidPaths.length === 0,
      error: null,
    });
  } catch {
    return Object.freeze({
      config,
      discovery,
      localPages: Object.freeze([]),
      localCandidates: Object.freeze([]),
      invalidPaths: Object.freeze([]),
      legacyPaths: Object.freeze([]),
      canClassifyAbsence: false,
      error: safeError("conversion-failed"),
    });
  }
}
