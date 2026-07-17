import {
  sha256Hex,
  type CortexPageObservation,
  type CortexPagePlan,
  type CortexPageStateV1,
  type CortexPlanAction,
  type CortexPlannedEffect,
  type CortexTreeConfigV1,
  type CortexTreePlan,
  type CortexTreeStateV1,
  type SafeError,
  type SafeErrorCode,
} from "@grandbox-bridge/shared";
import { upsertCortexFrontmatter } from "./frontmatter.js";
import { renderCortexMarkdown } from "./markdown.js";
import { projectCortexTreePaths } from "./path.js";
import type {
  CortexLocalCandidate,
  CortexLocalPage,
  CortexReconciliationResult,
} from "./reconcile.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface CortexPlanningInput {
  readonly config: CortexTreeConfigV1;
  readonly state: CortexTreeStateV1 | null;
  readonly reconciliation: CortexReconciliationResult;
  /** Injected only for deterministic state timestamps in tests and callers. */
  readonly now?: () => string;
}

/** Extra immutable data needed to execute a sparse shared contract effect safely. */
export interface CortexExecutionOperation {
  readonly effectIndex: number;
  readonly effect: CortexPlannedEffect;
  readonly pageId: string | null;
  readonly observedRemote: CortexPageObservation | null;
  readonly observedLocal: CortexLocalPage | null;
  readonly candidate: CortexLocalCandidate | null;
  readonly target: Readonly<{
    pageId: string | null;
    parentPageId: string | null;
    title: string | null;
    path: string | null;
    sourcePath: string | null;
    sourceMarkdown: string | null;
    localBytes: string | null;
    localByteHash: string | null;
    semanticHash: string | null;
    structureHash: string | null;
    expectedEditedAt: string | null;
  }>;
}

/** A CortexTreePlan plus the immutable execution context that PairPlan never carries. */
export interface CortexExecutableTreePlan extends CortexTreePlan {
  readonly operations: readonly CortexExecutionOperation[];
  /** Provisional Cortex-only state, finalized from verified executor observations. */
  readonly nextCortex: CortexTreeStateV1 | null;
}

interface RemoteTree {
  readonly root: CortexPageObservation;
  readonly pages: readonly CortexPageObservation[];
  readonly byId: ReadonlyMap<string, CortexPageObservation>;
  readonly depth: ReadonlyMap<string, number>;
}

interface LocalRenderTarget {
  readonly path: string;
  readonly bytes: string;
  readonly byteHash: string;
}

interface DraftPage {
  readonly pageId: string | null;
  action: CortexPlanAction;
  error: SafeError | null;
  readonly effects: CortexPlannedEffect[];
  readonly operationData: Array<Omit<CortexExecutionOperation, "effectIndex" | "effect">>;
}

function safeError(code: SafeErrorCode, retryable = false): SafeError {
  return Object.freeze({ code, retryable });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function timestamp(now: (() => string) | undefined): string {
  const value = now === undefined ? new Date().toISOString() : now();
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime()) || new Date(value).toISOString() !== value) {
    throw new Error("invalid clock");
  }
  return value;
}

function asPagePlans(drafts: Iterable<DraftPage>): readonly CortexPagePlan[] {
  return Object.freeze([...drafts]
    .sort((left, right) => {
      const leftKey = left.pageId ?? "~";
      const rightKey = right.pageId ?? "~";
      return compare(leftKey, rightKey);
    })
    .map((draft) => Object.freeze({
      pageId: draft.pageId,
      action: draft.action,
      effects: Object.freeze([...draft.effects]),
      error: draft.error,
    })));
}

function emptyPlan(
  config: CortexTreeConfigV1,
  error: SafeError,
  state: CortexTreeStateV1 | null,
  pageIds: readonly string[] = [],
): CortexExecutableTreePlan {
  const pages = Object.freeze([...pageIds].sort(compare).map((pageId) => Object.freeze({
    pageId,
    action: "attention" as const,
    effects: Object.freeze([]),
    error,
  })));
  return Object.freeze({
    rootPageId: config.rootPageId,
    traversalId: null,
    complete: false,
    pages,
    effects: Object.freeze([]),
    error,
    operations: Object.freeze([]),
    nextCortex: attentionState(state, new Set(pageIds), error),
  });
}

function attentionState(
  state: CortexTreeStateV1 | null,
  ids: ReadonlySet<string>,
  _error: SafeError,
): CortexTreeStateV1 | null {
  if (state === null) return null;
  const pages: Record<string, CortexPageStateV1> = {};
  for (const [pageId, page] of Object.entries(state.pages)) {
    pages[pageId] = Object.freeze({ ...page, status: ids.size === 0 || ids.has(pageId) ? "attention" : page.status });
  }
  return Object.freeze({ ...state, pages: Object.freeze(pages), lastSuccessfulTraversalId: state.lastSuccessfulTraversalId });
}

function validateRemoteTree(input: CortexPlanningInput): RemoteTree | SafeError {
  const discovery = input.reconciliation.discovery;
  if (discovery === null || discovery.rootPageId !== input.config.rootPageId || !discovery.complete) {
    return safeError("invalid-response");
  }
  const byId = new Map<string, CortexPageObservation>();
  for (const page of discovery.pages) {
    if (
      !isCanonicalUuid(page.pageId) ||
      page.rootPageId !== input.config.rootPageId ||
      byId.has(page.pageId) ||
      !Array.isArray(page.directChildPageIds) ||
      !page.directChildPageIds.every(isCanonicalUuid) ||
      !page.complete
    ) {
      return safeError("identity-collision");
    }
    byId.set(page.pageId, page);
  }
  const root = byId.get(input.config.rootPageId);
  if (root === undefined || root.parentPageId !== null) return safeError("identity-collision");

  const childClaims = new Set<string>();
  for (const page of byId.values()) {
    if (
      page.pageId !== root.pageId &&
      (page.parentPageId === null || !byId.has(page.parentPageId) || page.pageId === page.parentPageId)
    ) {
      return safeError("identity-collision");
    }
    for (const childId of page.directChildPageIds) {
      if (!byId.has(childId) || childClaims.has(`${page.pageId}:${childId}`)) return safeError("identity-collision");
      childClaims.add(`${page.pageId}:${childId}`);
    }
  }
  for (const page of byId.values()) {
    const seen = new Set<string>();
    let current: CortexPageObservation | undefined = page;
    for (let depth = 0; depth <= 32; depth += 1) {
      if (current.pageId === root.pageId) break;
      if (seen.has(current.pageId) || current.parentPageId === null) return safeError("identity-collision");
      seen.add(current.pageId);
      current = byId.get(current.parentPageId);
      if (current === undefined) return safeError("identity-collision");
    }
    if (current === undefined || current.pageId !== root.pageId) return safeError("identity-collision");
  }
  for (const page of byId.values()) {
    for (const childId of page.directChildPageIds) {
      if (byId.get(childId)?.parentPageId !== page.pageId) return safeError("identity-collision");
    }
  }

  const depth = new Map<string, number>([[root.pageId, 0]]);
  const resolveDepth = (pageId: string): number => {
    const cached = depth.get(pageId);
    if (cached !== undefined) return cached;
    const page = byId.get(pageId);
    if (page === undefined || page.parentPageId === null) throw new Error("unknown parent");
    const value = resolveDepth(page.parentPageId) + 1;
    depth.set(pageId, value);
    return value;
  };
  try {
    for (const pageId of byId.keys()) resolveDepth(pageId);
  } catch {
    return safeError("identity-collision");
  }
  return Object.freeze({
    root,
    pages: Object.freeze([...byId.values()].sort((left, right) => {
      const depthDifference = (depth.get(left.pageId) as number) - (depth.get(right.pageId) as number);
      return depthDifference === 0 ? compare(left.pageId, right.pageId) : depthDifference;
    })),
    byId,
    depth,
  });
}

function validPrior(state: CortexTreeStateV1 | null, config: CortexTreeConfigV1): boolean {
  if (state === null) return true;
  if (
    typeof state !== "object" ||
    state.pages === null ||
    typeof state.pages !== "object" ||
    state.rootPageId !== config.rootPageId ||
    state.rootFilePath !== config.rootFilePath ||
    state.rootDirectoryPath !== config.rootDirectoryPath ||
    state.pages[config.rootPageId] === undefined
  ) {
    return false;
  }
  const seenPaths = new Set<string>();
  for (const [key, page] of Object.entries(state.pages)) {
    if (
      page === null ||
      typeof page !== "object" ||
      key !== page.pageId ||
      !isCanonicalUuid(page.pageId) ||
      !isCanonicalUuid(page.rootPageId) ||
      !isCanonicalUuid(page.lastSeenTraversalId) ||
      typeof page.localPath !== "string" ||
      typeof page.title !== "string" ||
      page.rootPageId !== config.rootPageId ||
      seenPaths.has(page.localPath) ||
      (page.pageId === config.rootPageId && (page.parentPageId !== null || page.localPath !== config.rootFilePath)) ||
      (page.pageId !== config.rootPageId && (page.parentPageId === null || state.pages[page.parentPageId] === undefined))
    ) {
      return false;
    }
    seenPaths.add(page.localPath);
  }
  for (const page of Object.values(state.pages)) {
    const visited = new Set<string>();
    let current: CortexPageStateV1 | undefined = page;
    for (let depth = 0; depth <= 32; depth += 1) {
      if (current.pageId === config.rootPageId) break;
      if (visited.has(current.pageId) || current.parentPageId === null) return false;
      visited.add(current.pageId);
      current = state.pages[current.parentPageId];
      if (current === undefined) return false;
    }
    if (current === undefined || current.pageId !== config.rootPageId) return false;
  }
  return true;
}

async function renderTarget(
  page: CortexPageObservation,
  path: string,
  paths: ReadonlyMap<string, string>,
): Promise<LocalRenderTarget> {
  const parentPath = page.parentPageId === null ? null : paths.get(page.parentPageId) ?? null;
  if (page.pageId !== page.rootPageId && parentPath === null) throw new Error("unknown parent path");
  const markdown = renderCortexMarkdown({
    bodyMarkdown: page.sourceMarkdown,
    parentWikiLink: parentPath,
    directChildPageIds: page.directChildPageIds,
  });
  const bytes = upsertCortexFrontmatter(markdown, {
    cortexTree: true,
    pageId: page.pageId,
    parentPageId: page.parentPageId,
    rootPageId: page.rootPageId,
  });
  return Object.freeze({ path, bytes, byteHash: await sha256Hex(bytes) });
}

function localChanged(local: CortexLocalPage, prior: CortexPageStateV1): boolean {
  return (
    local.semanticHash !== prior.lastCommonSemanticHash ||
    local.structureHash !== prior.lastCommonStructureHash ||
    local.title !== prior.title ||
    local.parentPageId !== prior.parentPageId
  );
}

function remoteChanged(remote: CortexPageObservation, prior: CortexPageStateV1): boolean {
  return (
    remote.semanticHash !== prior.lastCommonSemanticHash ||
    remote.structureHash !== prior.lastCommonStructureHash ||
    remote.title !== prior.title ||
    remote.parentPageId !== prior.parentPageId
  );
}

function directRemoteMove(remote: CortexPageObservation, prior: CortexPageStateV1): boolean {
  return remote.title !== prior.title || remote.parentPageId !== prior.parentPageId;
}

/**
 * A direct remote move of an ancestor changes a descendant's projected path
 * even though the descendant's own page fields are unchanged.  The parent
 * operation performs the sole physical subtree move; descendants receive only
 * ordered post-move writes for their regenerated breadcrumbs/frontmatter.
 */
function hasDirectlyMovedRemoteAncestor(
  page: CortexPageObservation,
  remote: RemoteTree,
  state: CortexTreeStateV1 | null,
): boolean {
  let parentId = page.parentPageId;
  const seen = new Set<string>();
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const ancestor = remote.byId.get(parentId);
    const prior = state?.pages[parentId];
    if (ancestor === undefined || prior === undefined) return false;
    if (directRemoteMove(ancestor, prior)) return true;
    parentId = ancestor.parentPageId;
  }
  return false;
}

/**
 * A direct reparent can remove the relocating ancestor from the new remote
 * ancestry. Resolve the predecessor boundary from durable prior ancestry so a
 * child never schedules its old source after that ancestor has moved it.
 */
function hasDirectlyMovedPriorAncestor(
  page: CortexPageObservation,
  remote: RemoteTree,
  state: CortexTreeStateV1 | null,
): boolean {
  let parentId = state?.pages[page.pageId]?.parentPageId ?? null;
  const seen = new Set<string>();
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const prior = state?.pages[parentId];
    const ancestor = remote.byId.get(parentId);
    if (prior === undefined || ancestor === undefined) return false;
    if (directRemoteMove(ancestor, prior)) return true;
    parentId = prior.parentPageId;
  }
  return false;
}

function converged(local: CortexLocalPage, remote: CortexPageObservation): boolean {
  return (
    local.semanticHash === remote.semanticHash &&
    local.structureHash === remote.structureHash &&
    local.title === remote.title &&
    local.parentPageId === remote.parentPageId
  );
}

function conflictArtifact(page: CortexPageObservation, local: CortexLocalPage): string {
  const fields = {
    schemaVersion: 1,
    kind: "cortex-conflict",
    pageId: page.pageId,
    local: {
      path: local.path,
      title: local.title,
      parentPageId: local.parentPageId,
      semanticHash: local.semanticHash,
      structureHash: local.structureHash,
      sourceMarkdown: local.sourceMarkdown,
    },
    remote: {
      title: page.title,
      parentPageId: page.parentPageId,
      semanticHash: page.semanticHash,
      structureHash: page.structureHash,
      sourceMarkdown: page.sourceMarkdown,
    },
  };
  return `# Cortex sync conflict\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\`\n`;
}

function desiredState(
  config: CortexTreeConfigV1,
  remote: RemoteTree,
  rendered: ReadonlyMap<string, LocalRenderTarget>,
  traversalId: string,
  at: string,
  prior: CortexTreeStateV1 | null,
): CortexTreeStateV1 {
  const pages: Record<string, CortexPageStateV1> = {};
  for (const page of remote.pages) {
    const target = rendered.get(page.pageId);
    if (target === undefined) throw new Error("missing local target");
    const priorPage = prior?.pages[page.pageId];
    // A conflict is an explicit resolution boundary.  Preserve the baseline
    // common hashes and local projection rather than seeding a new baseline
    // from one side while the two originals remain unresolved.
    if (priorPage?.status === "conflict") {
      pages[page.pageId] = Object.freeze({ ...priorPage, status: "conflict" as const });
      continue;
    }
    pages[page.pageId] = Object.freeze({
      pageId: page.pageId,
      parentPageId: page.parentPageId,
      rootPageId: config.rootPageId,
      localPath: target.path,
      title: page.title,
      status: "synced",
      lastLocalSemanticHash: page.semanticHash,
      lastNotionSemanticHash: page.semanticHash,
      lastCommonSemanticHash: page.semanticHash,
      lastCommonStructureHash: page.structureHash,
      lastCommonLocalByteHash: target.byteHash,
      lastNotionEditedAt: page.editedAt,
      lastSyncedAt: at,
      lastSeenTraversalId: traversalId,
    });
  }
  return Object.freeze({
    rootPageId: config.rootPageId,
    rootFilePath: config.rootFilePath,
    rootDirectoryPath: config.rootDirectoryPath,
    pages: Object.freeze(pages),
    lastSuccessfulTraversalId: traversalId,
  });
}

function withPageStatus(
  state: CortexTreeStateV1,
  pageId: string,
  status: CortexPageStateV1["status"],
): CortexTreeStateV1 {
  const page = state.pages[pageId];
  if (page === undefined) return state;
  return Object.freeze({
    ...state,
    pages: Object.freeze({ ...state.pages, [pageId]: Object.freeze({ ...page, status }) }),
  });
}

function retainConflictState(
  state: CortexTreeStateV1,
  pageId: string,
  prior: CortexPageStateV1,
): CortexTreeStateV1 {
  if (state.pages[pageId] === undefined) return state;
  return Object.freeze({
    ...state,
    pages: Object.freeze({ ...state.pages, [pageId]: Object.freeze({ ...prior, status: "conflict" as const }) }),
  });
}

/** Do not let an attention-only dependent inherit an unverified future path. */
function retainAttentionState(
  state: CortexTreeStateV1,
  pageId: string,
  prior: CortexPageStateV1,
): CortexTreeStateV1 {
  if (state.pages[pageId] === undefined) return state;
  return Object.freeze({
    ...state,
    pages: Object.freeze({ ...state.pages, [pageId]: Object.freeze({ ...prior, status: "attention" as const }) }),
  });
}

function pageDraft(drafts: Map<string, DraftPage>, pageId: string | null): DraftPage {
  const key = pageId ?? `candidate:${drafts.size}`;
  const existing = drafts.get(key);
  if (existing !== undefined) return existing;
  const created: DraftPage = { pageId, action: "noop", error: null, effects: [], operationData: [] };
  drafts.set(key, created);
  return created;
}

function addEffect(
  draft: DraftPage,
  action: CortexPlanAction,
  effect: CortexPlannedEffect,
  data: Omit<CortexExecutionOperation, "effectIndex" | "effect">,
): void {
  if (draft.action === "noop") draft.action = action;
  draft.effects.push(effect);
  draft.operationData.push(data);
}

function markAttention(draft: DraftPage, error: SafeError): void {
  draft.action = "attention";
  draft.error = error;
  draft.effects.length = 0;
  draft.operationData.length = 0;
}

function hasPlannedSubtreeMove(draft: DraftPage | undefined): boolean {
  return draft?.effects.some((effect) => effect.kind === "move-cortex-subtree") === true;
}

function conflictRoots(
  drafts: ReadonlyMap<string, DraftPage>,
  state: CortexTreeStateV1 | null,
): ReadonlySet<string> {
  const roots = new Set<string>();
  for (const draft of drafts.values()) {
    if (draft.pageId !== null && draft.action === "conflict") roots.add(draft.pageId);
  }
  for (const [pageId, prior] of Object.entries(state?.pages ?? {})) {
    if (prior.status === "conflict") roots.add(pageId);
  }
  return roots;
}

function plannedSubtreeMoveSources(drafts: ReadonlyMap<string, DraftPage>): readonly string[] {
  const sources: string[] = [];
  for (const draft of drafts.values()) {
    for (const effect of draft.effects) {
      if (effect.kind === "move-cortex-subtree") sources.push(effect.sourcePath);
    }
  }
  return sources;
}

function isWithinSubtree(path: string, sourcePath: string): boolean {
  if (!sourcePath.endsWith(".md")) return false;
  return path.startsWith(`${sourcePath.slice(0, -3)}/`);
}

/**
 * A direct remote move needs one executable physical subtree relocation.  A
 * conflict or an attention hold leaves that relocation absent, so descendants
 * must remain behind the durable predecessor tree rather than writing a path
 * from the remote tree's future topology.
 */
function blockedRelocationRoots(
  remote: RemoteTree,
  rendered: ReadonlyMap<string, LocalRenderTarget>,
  state: CortexTreeStateV1 | null,
  localsById: ReadonlyMap<string, CortexLocalPage>,
  drafts: ReadonlyMap<string, DraftPage>,
): ReadonlySet<string> {
  const roots = new Set<string>();
  if (state === null) return roots;
  for (const [pageId, prior] of Object.entries(state.pages)) {
    const page = remote.byId.get(pageId);
    const target = rendered.get(pageId);
    const local = localsById.get(pageId);
    if (
      page !== undefined &&
      target !== undefined &&
      local !== undefined &&
      directRemoteMove(page, prior) &&
      prior.localPath !== target.path &&
      local.path !== target.path &&
      !hasPlannedSubtreeMove(drafts.get(pageId))
    ) {
      roots.add(pageId);
    }
  }
  return roots;
}

/**
 * Resolves containment through both durable predecessor and current remote
 * ancestry. A move out of a blocked root exists only in predecessor ancestry;
 * a move into it exists only in current remote ancestry.
 */
function hasRelocationBoundary(
  pageId: string,
  remote: RemoteTree,
  state: CortexTreeStateV1 | null,
  barrierRoots: ReadonlySet<string>,
): boolean {
  const pending = [pageId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const currentId = pending.pop();
    if (currentId === undefined || seen.has(currentId)) continue;
    if (barrierRoots.has(currentId)) return true;
    seen.add(currentId);
    const prior: CortexPageStateV1 | undefined = state?.pages[currentId];
    const currentParent = remote.byId.get(currentId)?.parentPageId ?? null;
    if (prior?.parentPageId !== null && prior?.parentPageId !== undefined) pending.push(prior.parentPageId);
    if (currentParent !== null) pending.push(currentParent);
  }
  return false;
}

function finalPlan(
  config: CortexTreeConfigV1,
  traversalId: string,
  drafts: Map<string, DraftPage>,
  nextCortex: CortexTreeStateV1 | null,
): CortexExecutableTreePlan {
  const pages = asPagePlans(drafts.values());
  const effects: CortexPlannedEffect[] = [];
  const operations: CortexExecutionOperation[] = [];
  // Effects were constructed in page-tree order by the caller; retain that
  // order by collecting their declarations rather than the display sort above.
  const declarationOrder = [...drafts.values()];
  for (const draft of declarationOrder) {
    for (const [index, effect] of draft.effects.entries()) {
      const effectIndex = effects.length;
      effects.push(effect);
      const data = draft.operationData[index];
      if (data === undefined) throw new Error("missing operation");
      operations.push(Object.freeze({ ...data, effectIndex, effect }));
    }
  }
  return Object.freeze({
    rootPageId: config.rootPageId,
    traversalId,
    complete: true,
    pages,
    effects: Object.freeze(effects),
    error: null,
    operations: Object.freeze(operations),
    nextCortex,
  });
}

/**
 * Builds a dedicated Cortex plan. It never creates a delete effect and rejects
 * an incomplete or malformed tree before deciding that any page is absent.
 */
export async function planCortexTree(input: CortexPlanningInput): Promise<CortexExecutableTreePlan> {
  try {
    if (input === null || typeof input !== "object" || input.reconciliation.error !== null) {
      return emptyPlan(input.config, input.reconciliation.error ?? safeError("invalid-response"), input.state);
    }
    if (!validPrior(input.state, input.config)) return emptyPlan(input.config, safeError("invalid-state"), input.state);
    const remote = validateRemoteTree(input);
    if ("code" in remote) {
      const ids = input.reconciliation.discovery?.pages.map((page) => page.pageId) ?? [];
      return emptyPlan(input.config, remote, input.state, ids);
    }
    if (!input.reconciliation.canClassifyAbsence || input.reconciliation.invalidPaths.length > 0) {
      return emptyPlan(input.config, safeError("invalid-response"), input.state, remote.pages.map((page) => page.pageId));
    }

    const occupied = [
      ...input.reconciliation.localCandidates.map((candidate) => candidate.path),
      ...input.reconciliation.invalidPaths,
    ];
    let projected: ReadonlyMap<string, string>;
    try {
      projected = projectCortexTreePaths({
        rootPageId: input.config.rootPageId,
        pages: remote.pages.map((page) => ({
          pageId: page.pageId,
          parentPageId: page.parentPageId,
          rootPageId: page.rootPageId,
          title: page.title,
        })),
        occupiedPaths: occupied,
        legacyPaths: input.reconciliation.legacyPaths,
      });
    } catch {
      return emptyPlan(input.config, safeError("identity-collision"), input.state, remote.pages.map((page) => page.pageId));
    }

    const rendered = new Map<string, LocalRenderTarget>();
    for (const page of remote.pages) {
      const path = projected.get(page.pageId);
      if (path === undefined) throw new Error("missing projection");
      rendered.set(page.pageId, await renderTarget(page, path, projected));
    }
    const at = timestamp(input.now);
    let nextCortex = desiredState(input.config, remote, rendered, input.reconciliation.discovery?.traversalId ?? "", at, input.state);
    const localsById = new Map(input.reconciliation.localPages.map((page) => [page.pageId, page]));
    const drafts = new Map<string, DraftPage>();

    // A complete traversal proves only the absence itself.  Do not use a
    // missing child as permission to rewrite its parent's managed structure:
    // that would strand an otherwise untouched local/remote original.  Record
    // the observed status and wait for an explicit resolution instead.
    if (input.state !== null) {
      const missingNotion = Object.keys(input.state.pages).filter((pageId) => !remote.byId.has(pageId));
      const missingLocal = Object.keys(input.state.pages).filter((pageId) => remote.byId.has(pageId) && !localsById.has(pageId));
      if (missingNotion.length > 0 || missingLocal.length > 0) {
        let statusOnly = input.state;
        for (const pageId of missingNotion) {
          const draft = pageDraft(drafts, pageId);
          draft.action = "attention";
          statusOnly = withPageStatus(statusOnly, pageId, "missing-notion");
        }
        for (const pageId of missingLocal) {
          const draft = pageDraft(drafts, pageId);
          draft.action = "attention";
          statusOnly = withPageStatus(statusOnly, pageId, "missing-local");
        }
        return finalPlan(input.config, input.reconciliation.discovery?.traversalId ?? "", drafts, statusOnly);
      }
    }

    // Remote pages are always considered parent-before-child.
    for (const page of remote.pages) {
      const prior = input.state?.pages[page.pageId] ?? null;
      const local = localsById.get(page.pageId) ?? null;
      const target = rendered.get(page.pageId) as LocalRenderTarget;
      const draft = pageDraft(drafts, page.pageId);

      if (prior === null && local === null) {
        addEffect(draft, "create-local", Object.freeze({
          kind: "create-cortex-local",
          rootPageId: input.config.rootPageId,
          pageId: page.pageId,
          path: target.path,
          expectedAbsent: true,
          resultByteHash: target.byteHash,
        }), {
          pageId: page.pageId,
          observedRemote: page,
          observedLocal: null,
          candidate: null,
          target: Object.freeze({
            pageId: page.pageId,
            parentPageId: page.parentPageId,
            title: page.title,
            path: target.path,
            sourcePath: null,
            sourceMarkdown: page.sourceMarkdown,
            localBytes: target.bytes,
            localByteHash: target.byteHash,
            semanticHash: page.semanticHash,
            structureHash: page.structureHash,
            expectedEditedAt: page.editedAt,
          }),
        });
        continue;
      }

      if (prior !== null && local === null) {
        draft.action = "attention";
        continue;
      }
      if (local === null) continue;

      if (prior === null) {
        if (!converged(local, page) || local.path !== target.path) {
          markAttention(draft, safeError("identity-collision"));
        }
        continue;
      }

      // A prior conflict is deliberately not an implicit last-writer-wins
      // decision.  Its artifact is already present (or recovery will demand
      // attention); no mutation is eligible until an explicit resolver
      // replaces the conflict state.
      if (prior.status === "conflict") {
        draft.action = "conflict";
        nextCortex = retainConflictState(nextCortex, page.pageId, prior);
        continue;
      }

      const changedLocal = localChanged(local, prior);
      const changedRemote = remoteChanged(page, prior);
      const movedByAncestor = local.path !== target.path && !directRemoteMove(page, prior) &&
        hasDirectlyMovedRemoteAncestor(page, remote, input.state);
      const directMoveBehindPriorAncestor = local.path !== target.path && directRemoteMove(page, prior) &&
        hasDirectlyMovedPriorAncestor(page, remote, input.state);
      // The direct child may now have a different remote parent, so the new
      // remote ancestry no longer contains the parent that will first relocate
      // its bytes. Do not emit a stale second source move or a future-path
      // write. A verified predecessor move can later record its real path.
      if (directMoveBehindPriorAncestor) {
        markAttention(draft, safeError("identity-collision"));
        nextCortex = retainAttentionState(nextCortex, page.pageId, prior);
        continue;
      }
      // A descendant cannot safely push an independent local edit while an
      // ancestor's remote move will relocate its bytes beneath it.  Preserve
      // both sides for explicit resolution rather than emitting a write at a
      // path whose move precondition no longer describes the local original.
      if (movedByAncestor && changedLocal) {
        markAttention(draft, safeError("identity-collision"));
        nextCortex = retainAttentionState(nextCortex, page.pageId, prior);
        continue;
      }
      if (changedLocal && changedRemote && !converged(local, page)) {
        const artifactPath = `The Cortex/.conflicts/${page.pageId}.conflict.md`;
        const artifact = conflictArtifact(page, local);
        const artifactHash = await sha256Hex(artifact);
        addEffect(draft, "conflict", Object.freeze({
          kind: "create-cortex-conflict",
          rootPageId: input.config.rootPageId,
          pageId: page.pageId,
          path: artifactPath,
          expectedAbsent: true,
          resultByteHash: artifactHash,
        }), {
          pageId: page.pageId,
          observedRemote: page,
          observedLocal: local,
          candidate: null,
          target: Object.freeze({
            pageId: page.pageId,
            parentPageId: page.parentPageId,
            title: page.title,
            path: artifactPath,
            sourcePath: local.path,
            sourceMarkdown: artifact,
            localBytes: artifact,
            localByteHash: artifactHash,
            semanticHash: page.semanticHash,
            structureHash: page.structureHash,
            expectedEditedAt: page.editedAt,
          }),
        });
        nextCortex = retainConflictState(nextCortex, page.pageId, prior);
        continue;
      }

      if (changedLocal && !changedRemote) {
        if (local.semanticHash !== prior.lastCommonSemanticHash) {
          addEffect(draft, "update-remote-body", Object.freeze({
            kind: "update-cortex-body",
            rootPageId: input.config.rootPageId,
            pageId: page.pageId,
            expectedEditedAt: page.editedAt,
            expectedSemanticHash: page.semanticHash,
            nextSemanticHash: local.semanticHash,
            expectedStructureHash: page.structureHash,
          }), {
            pageId: page.pageId,
            observedRemote: page,
            observedLocal: local,
            candidate: null,
            target: Object.freeze({
              pageId: page.pageId,
              parentPageId: page.parentPageId,
              title: local.title,
              path: local.path,
              sourcePath: local.path,
              sourceMarkdown: local.sourceMarkdown,
              localBytes: local.bytes,
              localByteHash: local.byteHash,
              semanticHash: local.semanticHash,
              structureHash: page.structureHash,
              expectedEditedAt: page.editedAt,
            }),
          });
        }
        if (local.title !== prior.title) {
          addEffect(draft, "update-remote-title", Object.freeze({
            kind: "update-cortex-title",
            rootPageId: input.config.rootPageId,
            pageId: page.pageId,
            expectedEditedAt: page.editedAt,
            title: local.title,
          }), {
            pageId: page.pageId,
            observedRemote: page,
            observedLocal: local,
            candidate: null,
            target: Object.freeze({
              pageId: page.pageId,
              parentPageId: page.parentPageId,
              title: local.title,
              path: local.path,
              sourcePath: local.path,
              sourceMarkdown: local.sourceMarkdown,
              localBytes: local.bytes,
              localByteHash: local.byteHash,
              semanticHash: local.semanticHash,
              structureHash: page.structureHash,
              expectedEditedAt: page.editedAt,
            }),
          });
        }
        if (local.parentPageId !== prior.parentPageId) {
          if (page.pageId === input.config.rootPageId || local.parentPageId === null) {
            markAttention(draft, safeError("identity-collision"));
            continue;
          }
          addEffect(draft, "move-remote", Object.freeze({
            kind: "move-cortex-page",
            rootPageId: input.config.rootPageId,
            pageId: page.pageId,
            expectedEditedAt: page.editedAt,
            parentPageId: local.parentPageId,
          }), {
            pageId: page.pageId,
            observedRemote: page,
            observedLocal: local,
            candidate: null,
            target: Object.freeze({
              pageId: page.pageId,
              parentPageId: local.parentPageId,
              title: local.title,
              path: local.path,
              sourcePath: local.path,
              sourceMarkdown: local.sourceMarkdown,
              localBytes: local.bytes,
              localByteHash: local.byteHash,
              semanticHash: local.semanticHash,
              structureHash: page.structureHash,
              expectedEditedAt: page.editedAt,
            }),
          });
        }
        continue;
      }

      if ((changedRemote && !changedLocal) || movedByAncestor) {
        const movedDirectly = directRemoteMove(page, prior);
        if (page.pageId === input.config.rootPageId && movedDirectly) {
          markAttention(draft, safeError("identity-collision"));
          continue;
        }
        if (local.path !== target.path && movedDirectly) {
          addEffect(draft, "move-local", Object.freeze({
            kind: "move-cortex-subtree",
            rootPageId: input.config.rootPageId,
            pageId: page.pageId,
            sourcePath: local.path,
            targetPath: target.path,
            expectedSourceByteHash: local.byteHash,
          }), {
            pageId: page.pageId,
            observedRemote: page,
            observedLocal: local,
            candidate: null,
            target: Object.freeze({
              pageId: page.pageId,
              parentPageId: page.parentPageId,
              title: page.title,
              path: target.path,
              sourcePath: local.path,
              sourceMarkdown: page.sourceMarkdown,
              localBytes: target.bytes,
              localByteHash: target.byteHash,
              semanticHash: page.semanticHash,
              structureHash: page.structureHash,
              expectedEditedAt: page.editedAt,
            }),
          });
        }
        const writePath = target.path;
        const expectedByteHash = local.byteHash;
        if (local.bytes !== target.bytes || local.path !== target.path) {
          addEffect(draft, "write-local", Object.freeze({
            kind: "write-cortex-local",
            rootPageId: input.config.rootPageId,
            pageId: page.pageId,
            path: writePath,
            expectedByteHash,
            resultByteHash: target.byteHash,
          }), {
            pageId: page.pageId,
            observedRemote: page,
            observedLocal: local,
            candidate: null,
            target: Object.freeze({
              pageId: page.pageId,
              parentPageId: page.parentPageId,
              title: page.title,
              path: writePath,
              sourcePath: local.path,
              sourceMarkdown: page.sourceMarkdown,
              localBytes: target.bytes,
              localByteHash: target.byteHash,
              semanticHash: page.semanticHash,
              structureHash: page.structureHash,
              expectedEditedAt: page.editedAt,
            }),
          });
        }
      }
    }

    // Derive barriers only after every paired page draft exists.  In
    // particular, a direct reparent can leave its previous ancestor absent
    // from the final remote ancestry; the prior tree is the only truthful
    // source of the physical predecessor boundary.
    const blockedRoots = blockedRelocationRoots(remote, rendered, input.state, localsById, drafts);
    const barrierRoots = new Set([...blockedRoots, ...conflictRoots(drafts, input.state)]);
    if (barrierRoots.size > 0) {
      for (const page of remote.pages) {
        const pageId = page.pageId;
        if (!hasRelocationBoundary(pageId, remote, input.state, barrierRoots)) continue;
        const draft = pageDraft(drafts, pageId);
        // The conflict artifact is the durable resolution record for its own
        // barrier root.  Every other page must shed projected effects and
        // retain its physically verified predecessor projection.
        if (draft.action === "conflict") continue;
        markAttention(draft, safeError("identity-collision"));
        const prior = input.state?.pages[pageId];
        nextCortex = prior === undefined
          ? withPageStatus(nextCortex, pageId, "attention")
          : retainAttentionState(nextCortex, pageId, prior);
      }
    }

    // A candidate can only create beneath a local page that is already paired
    // and is not waiting on an unexecuted predecessor relocation. A planned
    // parent subtree move also relocates a bare candidate before its stale
    // source-path preflight could run, so leave that candidate for the next
    // reconciliation at its physical destination.
    const moveSources = plannedSubtreeMoveSources(drafts);
    for (const candidate of input.reconciliation.localCandidates) {
      const parent = remote.byId.get(candidate.parentPageId);
      if (parent === undefined) continue;
      if (hasRelocationBoundary(candidate.parentPageId, remote, input.state, barrierRoots)) continue;
      if (moveSources.some((sourcePath) => isWithinSubtree(candidate.path, sourcePath))) continue;
      const draft = pageDraft(drafts, null);
      addEffect(draft, "create-remote", Object.freeze({
        kind: "create-cortex-page",
        rootPageId: input.config.rootPageId,
        parentPageId: candidate.parentPageId,
        title: candidate.title,
        semanticHash: candidate.semanticHash,
        structureHash: await sha256Hex("[]"),
      }), {
        pageId: null,
        observedRemote: parent,
        observedLocal: null,
        candidate,
        target: Object.freeze({
          pageId: null,
          parentPageId: candidate.parentPageId,
          title: candidate.title,
          path: candidate.path,
          sourcePath: candidate.path,
          sourceMarkdown: candidate.sourceMarkdown,
          localBytes: null,
          localByteHash: candidate.byteHash,
          semanticHash: candidate.semanticHash,
          structureHash: await sha256Hex("[]"),
          expectedEditedAt: parent.editedAt,
        }),
      });
    }

    return finalPlan(input.config, input.reconciliation.discovery?.traversalId ?? "", drafts, nextCortex);
  } catch {
    return emptyPlan(input.config, safeError("conversion-failed"), input.state);
  }
}
