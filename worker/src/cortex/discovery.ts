import {
  sha256Hex,
  type CortexDiscoveryAttention,
  type CortexPageObservation,
  type CortexTreeDiscovery,
  type DiscoverCortexTreeInput,
} from "@grandbox-bridge/shared";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_DEPTH = 32;
const MAX_PAGES = 5_000;
const MAX_BLOCK_LIST_PAGES = 5_000;

export class CortexDiscoveryError extends Error {
  public constructor(public readonly kind: "invalid" | "truncated") {
    super(`Cortex discovery ${kind}`);
    this.name = "CortexDiscoveryError";
  }
}

export interface CortexDiscoverySource {
  retrieveCortexPage(pageId: string, rootPageId: string): Promise<CortexPageObservation | null>;
  listBlockChildren(pageId: string, startCursor?: string): Promise<unknown>;
}

export interface CortexDiscoveryDependencies {
  readonly source: CortexDiscoverySource;
  readonly traversalId: () => string;
}

interface BlockChildrenPage {
  readonly childPageIds: readonly string[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

interface NormalizedDiscoveryInput {
  readonly rootPageId: string;
  readonly maxDepth: number;
  readonly maxPages: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isStrictInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    Buffer.byteLength(value, "utf8") <= 2_000 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function normalizeInput(value: unknown): NormalizedDiscoveryInput {
  if (!isRecord(value) || !isCanonicalUuid(value.rootPageId)) throw new CortexDiscoveryError("invalid");
  const maxDepth = value.maxDepth === undefined ? MAX_DEPTH : value.maxDepth;
  const maxPages = value.maxPages === undefined ? MAX_PAGES : value.maxPages;
  if (
    typeof maxDepth !== "number" ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > MAX_DEPTH ||
    typeof maxPages !== "number" ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > MAX_PAGES
  ) {
    throw new CortexDiscoveryError("invalid");
  }
  return Object.freeze({ rootPageId: value.rootPageId, maxDepth, maxPages });
}

function normalizeTraversalId(value: unknown): string {
  if (!isCanonicalUuid(value)) throw new CortexDiscoveryError("invalid");
  return value;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validObservation(value: unknown, pageId: string, rootPageId: string): value is CortexPageObservation {
  if (!isRecord(value) || value.pageId !== pageId || value.rootPageId !== rootPageId) return false;
  return (
    (value.parentPageId === null || isCanonicalUuid(value.parentPageId)) &&
    isBoundedText(value.title) &&
    typeof value.sourceMarkdown === "string" &&
    Array.isArray(value.directChildPageIds) &&
    value.directChildPageIds.every(isCanonicalUuid) &&
    isHash(value.semanticHash) &&
    isHash(value.structureHash) &&
    isStrictInstant(value.editedAt) &&
    typeof value.complete === "boolean"
  );
}

function parseBlockChildrenPage(value: unknown): BlockChildrenPage {
  if (
    !isRecord(value) ||
    value.object !== "list" ||
    !Array.isArray(value.results) ||
    value.results.length > 100 ||
    typeof value.has_more !== "boolean" ||
    !(value.next_cursor === null || typeof value.next_cursor === "string")
  ) {
    throw new CortexDiscoveryError("invalid");
  }
  if (value.has_more !== (value.next_cursor !== null)) throw new CortexDiscoveryError("truncated");
  if (
    value.next_cursor !== null &&
    (value.next_cursor.length === 0 || Buffer.byteLength(value.next_cursor, "utf8") > 2_048 || /[\r\n\u0000]/u.test(value.next_cursor))
  ) {
    throw new CortexDiscoveryError("truncated");
  }

  const childPageIds: string[] = [];
  for (const result of value.results) {
    if (!isRecord(result) || result.object !== "block" || typeof result.type !== "string") {
      throw new CortexDiscoveryError("invalid");
    }
    if (result.type !== "child_page") continue;
    if (!isCanonicalUuid(result.id) || !isRecord(result.child_page)) throw new CortexDiscoveryError("invalid");
    childPageIds.push(result.id);
  }
  return Object.freeze({ childPageIds: Object.freeze(childPageIds), hasMore: value.has_more, nextCursor: value.next_cursor });
}

function attentionForError(pageId: string, caught: unknown): CortexDiscoveryAttention {
  if (caught instanceof CortexDiscoveryError) {
    return caught.kind === "invalid"
      ? Object.freeze({ kind: "invalid-page" as const, pageId })
      : Object.freeze({ kind: "truncated" as const, pageId });
  }
  if (isRecord(caught) && (caught.code === "authorization-failed" || caught.code === "not-found")) {
    return Object.freeze({ kind: "inaccessible" as const, pageId });
  }
  if (isRecord(caught) && caught.code === "invalid-response") {
    return Object.freeze({ kind: "invalid-page" as const, pageId });
  }
  return Object.freeze({ kind: "truncated" as const, pageId });
}

async function observationWithChildren(
  observation: CortexPageObservation,
  parentPageId: string | null,
  childPageIds: readonly string[],
): Promise<CortexPageObservation> {
  return Object.freeze({
    ...observation,
    parentPageId,
    directChildPageIds: Object.freeze([...childPageIds]),
    structureHash: await sha256Hex(JSON.stringify(childPageIds)),
  });
}

/** Fetches and validates every page of a single block-children cursor chain. */
export async function collectCortexChildPageIds(source: CortexDiscoverySource, pageId: string): Promise<readonly string[]> {
  if (!isCanonicalUuid(pageId) || source === null || typeof source !== "object" || typeof source.listBlockChildren !== "function") {
    throw new CortexDiscoveryError("invalid");
  }
  const childPageIds: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let listPages = 0; listPages < MAX_BLOCK_LIST_PAGES; listPages += 1) {
    const parsed = parseBlockChildrenPage(await source.listBlockChildren(pageId, cursor));
    childPageIds.push(...parsed.childPageIds);
    if (!parsed.hasMore) return Object.freeze(childPageIds);
    const nextCursor = parsed.nextCursor;
    if (nextCursor === null || seenCursors.has(nextCursor)) throw new CortexDiscoveryError("truncated");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new CortexDiscoveryError("truncated");
}

/**
 * Traverses exactly one regular-page tree. Provider failures are represented
 * as attention, never as missing-page evidence.
 */
export async function discoverCortexTree(
  input: DiscoverCortexTreeInput,
  dependencies: CortexDiscoveryDependencies,
): Promise<CortexTreeDiscovery> {
  const normalized = normalizeInput(input);
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    dependencies.source === null ||
    typeof dependencies.source !== "object" ||
    typeof dependencies.source.retrieveCortexPage !== "function" ||
    typeof dependencies.source.listBlockChildren !== "function" ||
    typeof dependencies.traversalId !== "function"
  ) {
    throw new CortexDiscoveryError("invalid");
  }
  const traversalId = normalizeTraversalId(dependencies.traversalId());
  const pages: CortexPageObservation[] = [];
  const attention: CortexDiscoveryAttention[] = [];
  const visited = new Set<string>([normalized.rootPageId]);
  let complete = true;
  let pageLimitReached = false;

  const addAttention = (entry: CortexDiscoveryAttention): void => {
    complete = false;
    attention.push(entry);
  };

  const visit = async (pageId: string, expectedParentPageId: string | null, depth: number): Promise<void> => {
    if (pageLimitReached) return;
    let observed: CortexPageObservation | null;
    try {
      observed = await dependencies.source.retrieveCortexPage(pageId, normalized.rootPageId);
    } catch (caught) {
      addAttention(attentionForError(pageId, caught));
      return;
    }
    if (observed === null) {
      addAttention(Object.freeze({ kind: "inaccessible" as const, pageId }));
      return;
    }
    if (!validObservation(observed, pageId, normalized.rootPageId) || (expectedParentPageId !== null && observed.parentPageId !== expectedParentPageId)) {
      addAttention(Object.freeze({ kind: "invalid-page" as const, pageId }));
      return;
    }

    let childPageIds: readonly string[];
    try {
      childPageIds = await collectCortexChildPageIds(dependencies.source, pageId);
    } catch (caught) {
      const normalizedObservation = await observationWithChildren(observed, expectedParentPageId, []);
      pages.push(normalizedObservation);
      if (!observed.complete) addAttention(Object.freeze({ kind: "truncated" as const, pageId }));
      addAttention(attentionForError(pageId, caught));
      return;
    }

    const traversalChildPageIds = [...childPageIds].sort(compareIds);
    const normalizedObservation = await observationWithChildren(observed, expectedParentPageId, childPageIds);
    pages.push(normalizedObservation);
    if (!observed.complete) addAttention(Object.freeze({ kind: "truncated" as const, pageId }));
    if (depth >= normalized.maxDepth) {
      if (traversalChildPageIds.length > 0) {
        addAttention(Object.freeze({ kind: "depth-limit" as const, pageId: traversalChildPageIds[0] as string }));
      }
      return;
    }

    for (const childPageId of traversalChildPageIds) {
      if (visited.has(childPageId)) {
        addAttention(Object.freeze({ kind: "cycle" as const, pageId: childPageId }));
        continue;
      }
      if (visited.size >= normalized.maxPages) {
        addAttention(Object.freeze({ kind: "page-limit" as const, pageId: childPageId }));
        pageLimitReached = true;
        return;
      }
      visited.add(childPageId);
      await visit(childPageId, pageId, depth + 1);
      if (pageLimitReached) return;
    }
  };

  await visit(normalized.rootPageId, null, 0);
  return Object.freeze({
    rootPageId: normalized.rootPageId,
    traversalId,
    pages: Object.freeze(pages),
    complete,
    attention: Object.freeze(attention),
  });
}
