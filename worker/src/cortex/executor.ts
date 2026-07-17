import {
  parseJournalCompletion,
  parseJournalIntent,
  sha256Hex,
  type BridgeStateV1,
  type Clock,
  type CortexPageObservation,
  type CortexPageStateV1,
  type CortexPlannedEffect,
  type CortexTreeStateV1,
  type JournalCompletionV1,
  type JournalIntentV1,
  type SafeError,
  type SafeErrorCode,
  type UuidSource,
} from "@grandbox-bridge/shared";
import { parseCortexLocalNote, upsertCortexFrontmatter } from "./frontmatter.js";
import { renderCortexMarkdown } from "./markdown.js";
import { cortexParentFilePath } from "./path.js";
import type { CortexExecutableTreePlan, CortexExecutionOperation } from "./planner.js";
import type { JournalStore } from "../persistence/journal-store.js";
import type { VaultWriter } from "../vault/writer.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface CortexExecutorDependencies {
  readonly installationId: string;
  readonly journal: JournalStore;
  readonly notion: Readonly<{
    retrieveCortexPage(input: { readonly rootPageId: string; readonly pageId: string }): Promise<CortexPageObservation | null>;
    createCortexPage(input: {
      readonly rootPageId: string;
      readonly parentPageId: string;
      readonly title: string;
      readonly markdown: string;
      readonly expectedParentEditedAt: string;
    }): Promise<CortexPageObservation>;
    updateCortexBodyExact(input: {
      readonly rootPageId: string;
      readonly pageId: string;
      readonly oldMarkdown: string;
      readonly newMarkdown: string;
      readonly observedEditedAt: string;
    }): Promise<CortexPageObservation>;
    updateCortexTitle(input: {
      readonly rootPageId: string;
      readonly pageId: string;
      readonly title: string;
      readonly observedEditedAt: string;
    }): Promise<CortexPageObservation>;
    moveCortexPage(input: {
      readonly rootPageId: string;
      readonly pageId: string;
      readonly parentPageId: string;
      readonly observedEditedAt: string;
    }): Promise<CortexPageObservation>;
  }>;
  readonly writer: VaultWriter;
  readonly uuid: UuidSource;
  readonly clock: Clock;
  /** A no-follow, bounded reread supplied by the vault boundary. */
  readonly readLocalBytes: (relativePath: string) => Promise<string | null>;
  /** Optional Task 5 orchestration seam. It receives a full state with only Cortex changed. */
  readonly persistState?: (state: BridgeStateV1) => Promise<void>;
}

export interface CortexExecutionResult {
  readonly state: BridgeStateV1;
  readonly outcome: "success" | "conflict" | "attention" | "error";
  readonly writes: number;
  readonly completedEffects: number;
  readonly error: SafeError | null;
}

export interface ExecuteCortexTreePlanInput {
  readonly state: BridgeStateV1;
  readonly plan: CortexExecutableTreePlan;
}

interface EffectOutcome {
  readonly remote: CortexPageObservation | null;
  readonly pageId: string | null;
  readonly localByteHash: string | null;
  readonly localPath: string | null;
  /** The verified execution boundary for failure-safe subtree relocation. */
  readonly effectKind?: CortexPlannedEffect["kind"];
  readonly movedSubtree?: Readonly<{ readonly sourcePath: string; readonly targetPath: string }>;
  /** A local candidate is the only operation that allocates a new page ID. */
  readonly createdRemote?: boolean;
  /** Extra journaled work resolved from an ID allocated by this operation. */
  readonly related?: readonly EffectOutcome[];
}

const NO_VERIFIED_OUTCOMES: readonly EffectOutcome[] = Object.freeze([]);

function outcomesForCreatedRemote(
  outcomes: readonly EffectOutcome[],
  pageId: string | null,
): readonly EffectOutcome[] {
  if (pageId === null) return outcomes;
  return Object.freeze(outcomes.map((outcome) => outcome.pageId === pageId
    ? Object.freeze({ ...outcome, createdRemote: true })
    : outcome));
}

class CortexExecutionError extends Error {
  public readonly verifiedOutcomes: readonly EffectOutcome[];

  public constructor(
    public readonly error: SafeError,
    public readonly pageId: string | null = null,
    public readonly attentionFallbackPageIds: readonly string[] = [],
    verifiedOutcomes: readonly EffectOutcome[] = NO_VERIFIED_OUTCOMES,
  ) {
    super("Cortex execution failed");
    this.name = "CortexExecutionError";
    this.verifiedOutcomes = Object.freeze([...verifiedOutcomes]);
  }
}

function safeError(code: SafeErrorCode, retryable = false): SafeError {
  return Object.freeze({ code, retryable });
}

function errorFrom(caught: unknown): SafeError {
  if (caught instanceof CortexExecutionError) return caught.error;
  if (typeof caught === "object" && caught !== null && "code" in caught && typeof caught.code === "string") {
    const code = caught.code as SafeErrorCode;
    const allowed: readonly SafeErrorCode[] = [
      "invalid-config", "invalid-state", "unsafe-path", "active-lock", "recovery-required", "not-found",
      "authorization-failed", "network-failed", "timeout", "invalid-response", "revision-race",
      "unsupported-content", "identity-collision", "conversion-failed", "internal-error",
    ];
    if (allowed.includes(code)) return safeError(code, "retryable" in caught && caught.retryable === true);
  }
  return safeError("internal-error");
}

function now(clock: Clock): string {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new CortexExecutionError(safeError("internal-error"));
  return value.toISOString();
}

function nextId(uuid: UuidSource): string {
  const value = uuid.randomUUID();
  if (!UUID_PATTERN.test(value)) throw new CortexExecutionError(safeError("internal-error"));
  return value;
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function expectHash(value: string | null, expected: string | null): void {
  if (value !== expected) throw new CortexExecutionError(safeError("revision-race"));
}

async function hashOf(bytes: string | null): Promise<string | null> {
  return bytes === null ? null : sha256Hex(bytes);
}

function sameRemote(
  actual: CortexPageObservation,
  expected: CortexPageObservation,
): boolean {
  return (
    actual.pageId === expected.pageId &&
    actual.rootPageId === expected.rootPageId &&
    actual.parentPageId === expected.parentPageId &&
    actual.title === expected.title &&
    actual.sourceMarkdown === expected.sourceMarkdown &&
    actual.semanticHash === expected.semanticHash &&
    actual.structureHash === expected.structureHash &&
    actual.editedAt === expected.editedAt &&
    actual.complete &&
    actual.directChildPageIds.length === expected.directChildPageIds.length &&
    actual.directChildPageIds.every((child, index) => child === expected.directChildPageIds[index])
  );
}

async function rereadRemote(
  operation: CortexExecutionOperation,
  rootPageId: string,
  dependencies: CortexExecutorDependencies,
  current: ReadonlyMap<string, CortexPageObservation>,
): Promise<CortexPageObservation> {
  const pageId = operation.pageId;
  if (pageId === null) {
    const parent = operation.observedRemote === null
      ? null
      : current.get(operation.observedRemote.pageId) ?? operation.observedRemote;
    if (parent === null) throw new CortexExecutionError(safeError("invalid-response"));
    const observedParent = await dependencies.notion.retrieveCortexPage({ rootPageId, pageId: parent.pageId });
    if (observedParent === null || !sameRemote(observedParent, parent)) {
      throw new CortexExecutionError(safeError("revision-race"));
    }
    return observedParent;
  }
  const expected = current.get(pageId) ?? operation.observedRemote;
  if (expected === null || expected === undefined) throw new CortexExecutionError(safeError("invalid-response"));
  const observed = await dependencies.notion.retrieveCortexPage({ rootPageId, pageId });
  if (observed === null || !sameRemote(observed, expected)) throw new CortexExecutionError(safeError("revision-race"));
  return observed;
}

async function verifyRemote(
  rootPageId: string,
  observed: CortexPageObservation,
  expected: Readonly<{
    pageId: string | null;
    parentPageId: string | null;
    title: string | null;
    sourceMarkdown: string | null;
    semanticHash: string | null;
    structureHash: string | null;
  }>,
  dependencies: CortexExecutorDependencies,
): Promise<CortexPageObservation> {
  if (
    (expected.pageId !== null && observed.pageId !== expected.pageId) ||
    (expected.parentPageId !== null && observed.parentPageId !== expected.parentPageId) ||
    (expected.title !== null && observed.title !== expected.title) ||
    (expected.sourceMarkdown !== null && observed.sourceMarkdown !== expected.sourceMarkdown) ||
    (expected.semanticHash !== null && observed.semanticHash !== expected.semanticHash) ||
    (expected.structureHash !== null && observed.structureHash !== expected.structureHash) ||
    !observed.complete
  ) {
    throw new CortexExecutionError(safeError("revision-race"));
  }
  const reread = await dependencies.notion.retrieveCortexPage({ rootPageId, pageId: observed.pageId });
  if (reread === null || !sameRemote(reread, observed)) throw new CortexExecutionError(safeError("revision-race"));
  return reread;
}

async function requireLocal(
  path: string,
  expectedHash: string | null,
  dependencies: CortexExecutorDependencies,
): Promise<string | null> {
  const bytes = await dependencies.readLocalBytes(path);
  expectHash(await hashOf(bytes), expectedHash);
  return bytes;
}

async function verifyLocal(
  path: string,
  expectedHash: string,
  dependencies: CortexExecutorDependencies,
): Promise<void> {
  const bytes = await dependencies.readLocalBytes(path);
  if (bytes === null || await sha256Hex(bytes) !== expectedHash) throw new CortexExecutionError(safeError("revision-race"));
}

async function markedRemoteMarkdown(sourceMarkdown: string, childPageIds: readonly string[]): Promise<string> {
  return renderCortexMarkdown({ bodyMarkdown: sourceMarkdown, parentWikiLink: null, directChildPageIds: childPageIds });
}

function effectPaths(operation: CortexExecutionOperation): Readonly<{ sourcePath: string | null; targetPath: string | null }> {
  const effect = operation.effect;
  if (effect.kind === "move-cortex-subtree") return Object.freeze({ sourcePath: effect.sourcePath, targetPath: effect.targetPath });
  if (effect.kind === "create-cortex-local" || effect.kind === "write-cortex-local" || effect.kind === "create-cortex-conflict") {
    return Object.freeze({ sourcePath: effect.kind === "write-cortex-local" ? effect.path : null, targetPath: effect.path });
  }
  if (effect.kind === "create-cortex-page") {
    const path = operation.candidate?.path ?? null;
    return Object.freeze({ sourcePath: path, targetPath: path });
  }
  const path = operation.observedLocal?.path ?? operation.target.path;
  return Object.freeze({ sourcePath: path, targetPath: path });
}

async function allocationId(operation: CortexExecutionOperation): Promise<string | null> {
  if (operation.effect.kind !== "create-cortex-page") return null;
  const candidate = operation.candidate;
  if (candidate === null) throw new CortexExecutionError(safeError("invalid-response"));
  return sha256Hex(`${candidate.path}\u0000${candidate.byteHash}`);
}

async function journalIntent(
  operation: CortexExecutionOperation,
  current: CortexPageObservation,
  dependencies: CortexExecutorDependencies,
): Promise<JournalIntentV1> {
  const effect = operation.effect;
  const paths = effectPaths(operation);
  const pageId = effect.kind === "create-cortex-page" ? null : operation.pageId;
  const targetPath = paths.targetPath;
  const sourcePath = paths.sourcePath;
  if (targetPath === null || (pageId !== null && !isCanonicalUuid(pageId))) {
    throw new CortexExecutionError(safeError("invalid-response"));
  }
  const expectedByteHash = effect.kind === "create-cortex-local" || effect.kind === "create-cortex-conflict"
    ? null
    : effect.kind === "move-cortex-subtree"
      ? effect.expectedSourceByteHash
      : effect.kind === "write-cortex-local"
        ? effect.expectedByteHash
      : operation.observedLocal?.byteHash ?? operation.candidate?.byteHash ?? null;
  const resultByteHash =
    effect.kind === "create-cortex-page"
      ? operation.candidate?.byteHash ?? null
      : effect.kind === "create-cortex-local" || effect.kind === "write-cortex-local" || effect.kind === "create-cortex-conflict"
        ? operation.target.localByteHash
        : effect.kind === "move-cortex-subtree"
          ? operation.target.localByteHash
          : operation.observedLocal?.byteHash ?? null;
  const semanticHash = effect.kind === "create-cortex-page"
    ? operation.candidate?.semanticHash ?? null
    : operation.target.semanticHash ?? current.semanticHash;
  const structureHash = operation.target.structureHash ?? current.structureHash;
  const expectedSemanticHash = effect.kind === "create-cortex-page"
    ? operation.candidate?.semanticHash ?? null
    : current.semanticHash;
  const expectedRemoteEditedAt = effect.kind === "create-cortex-page"
    ? current.editedAt
    : current.editedAt;
  const postconditionPageId = pageId;
  const postcondition = {
    pageId: postconditionPageId,
    parentPageId: effect.kind === "create-cortex-page" ? operation.target.parentPageId : operation.target.parentPageId ?? current.parentPageId,
    title: operation.target.title ?? current.title,
    relativePath: targetPath,
    byteHash: resultByteHash,
    semanticHash,
    structureHash,
    // Provider revisions after a PATCH are not knowable before the journaled
    // mutation. The recovery observer treats a create or revision ambiguity as
    // attention rather than replaying it; this remains an immutable fence.
    editedAt: expectedRemoteEditedAt,
  };
  const raw = {
    schemaVersion: 1 as const,
    id: nextId(dependencies.uuid),
    installationId: dependencies.installationId,
    effectKind: effect.kind,
    relativePath: targetPath,
    remoteId: pageId,
    allocationId: await allocationId(operation),
    expectedByteHash,
    expectedSemanticHash,
    resultByteHash,
    resultSemanticHash: semanticHash,
    expectedRemoteEditedAt,
    createdAt: now(dependencies.clock),
    cortex: {
      rootPageId: effect.rootPageId,
      pageId,
      sourcePath,
      targetPath,
      expectedPostcondition: postcondition,
    },
  };
  try {
    return parseJournalIntent(raw);
  } catch {
    throw new CortexExecutionError(safeError("invalid-response"));
  }
}

function completion(
  outcome: EffectOutcome,
  clock: Clock,
): JournalCompletionV1 {
  return parseJournalCompletion({
    schemaVersion: 1,
    resultByteHash: outcome.localByteHash,
    resultSemanticHash: outcome.remote?.semanticHash ?? null,
    resultRemoteId: outcome.remote?.pageId ?? outcome.pageId,
    allocatedBridgeId: null,
    observedRemoteEditedAt: outcome.remote?.editedAt ?? null,
    completedAt: now(clock),
  });
}

function flattenOutcomes(outcomes: readonly EffectOutcome[]): readonly EffectOutcome[] {
  const flattened: EffectOutcome[] = [];
  const visit = (outcome: EffectOutcome) => {
    flattened.push(outcome);
    for (const related of outcome.related ?? []) visit(related);
  };
  for (const outcome of outcomes) visit(outcome);
  return Object.freeze(flattened);
}

function completedOutcome(
  outcome: EffectOutcome,
  effect: CortexPlannedEffect,
): EffectOutcome {
  return Object.freeze({
    ...outcome,
    effectKind: effect.kind,
    ...(effect.kind === "move-cortex-subtree"
      ? { movedSubtree: Object.freeze({ sourcePath: effect.sourcePath, targetPath: effect.targetPath }) }
      : {}),
  });
}

/** Builds the ID-bound local rebind that follows a verified remote creation. */
async function createdCandidateLocalOperation(
  operation: CortexExecutionOperation,
  remote: CortexPageObservation,
): Promise<CortexExecutionOperation> {
  const candidate = operation.candidate;
  if (candidate === null) throw new CortexExecutionError(safeError("invalid-response"));
  const localBytes = upsertCortexFrontmatter(renderCortexMarkdown({
    bodyMarkdown: candidate.sourceMarkdown,
    parentWikiLink: candidate.parentPath,
    directChildPageIds: [],
  }), {
    cortexTree: true,
    pageId: remote.pageId,
    parentPageId: remote.parentPageId,
    rootPageId: remote.rootPageId,
  });
  const localByteHash = await sha256Hex(localBytes);
  const effect: CortexPlannedEffect = Object.freeze({
    kind: "write-cortex-local",
    rootPageId: remote.rootPageId,
    pageId: remote.pageId,
    path: candidate.path,
    expectedByteHash: candidate.byteHash,
    resultByteHash: localByteHash,
  });
  return Object.freeze({
    effectIndex: -1,
    effect,
    pageId: remote.pageId,
    observedRemote: remote,
    observedLocal: null,
    candidate: null,
    target: Object.freeze({
      pageId: remote.pageId,
      parentPageId: remote.parentPageId,
      title: remote.title,
      path: candidate.path,
      sourcePath: candidate.path,
      sourceMarkdown: candidate.sourceMarkdown,
      localBytes,
      localByteHash,
      semanticHash: remote.semanticHash,
      structureHash: remote.structureHash,
      expectedEditedAt: remote.editedAt,
    }),
  });
}

/**
 * A newly-created local child changes its parent's owned child-marker list.
 * The remote page ID does not exist while the create intent is first written,
 * so resolve it from the verified create result and journal the marker refresh
 * as a separate exact local write before state can advance.
 */
async function synchronizeCreatedCandidateParent(
  operation: CortexExecutionOperation,
  created: CortexPageObservation,
  dependencies: CortexExecutorDependencies,
  current: Map<string, CortexPageObservation>,
): Promise<EffectOutcome> {
  const candidate = operation.candidate;
  if (candidate === null) throw new CortexExecutionError(safeError("invalid-response"));
  const parent = await dependencies.notion.retrieveCortexPage({
    rootPageId: operation.effect.rootPageId,
    pageId: candidate.parentPageId,
  });
  if (
    parent === null ||
    !parent.complete ||
    parent.rootPageId !== operation.effect.rootPageId ||
    !parent.directChildPageIds.includes(created.pageId)
  ) {
    throw new CortexExecutionError(safeError("revision-race"), candidate.parentPageId);
  }

  const currentBytes = await dependencies.readLocalBytes(candidate.parentPath);
  if (currentBytes === null) throw new CortexExecutionError(safeError("revision-race"), candidate.parentPageId);
  const parsed = parseCortexLocalNote(candidate.parentPath, currentBytes);
  if (
    parsed.cortex.pageId !== parent.pageId ||
    parsed.cortex.rootPageId !== operation.effect.rootPageId ||
    parsed.cortex.parentPageId !== parent.parentPageId
  ) {
    throw new CortexExecutionError(safeError("revision-race"), candidate.parentPageId);
  }

  const parentWikiLink = parent.parentPageId === null ? null : cortexParentFilePath(candidate.parentPath);
  const rendered = renderCortexMarkdown({
    bodyMarkdown: parent.sourceMarkdown,
    parentWikiLink,
    directChildPageIds: parent.directChildPageIds,
  });
  const localBytes = upsertCortexFrontmatter(rendered, {
    cortexTree: true,
    pageId: parent.pageId,
    parentPageId: parent.parentPageId,
    rootPageId: parent.rootPageId,
  });
  const expectedByteHash = await sha256Hex(currentBytes);
  const localByteHash = await sha256Hex(localBytes);
  const effect: CortexPlannedEffect = Object.freeze({
    kind: "write-cortex-local",
    rootPageId: operation.effect.rootPageId,
    pageId: parent.pageId,
    path: candidate.parentPath,
    expectedByteHash,
    resultByteHash: localByteHash,
  });
  const parentOperation: CortexExecutionOperation = Object.freeze({
    effectIndex: -1,
    effect,
    pageId: parent.pageId,
    observedRemote: parent,
    observedLocal: null,
    candidate: null,
    target: Object.freeze({
      pageId: parent.pageId,
      parentPageId: parent.parentPageId,
      title: parent.title,
      path: candidate.parentPath,
      sourcePath: candidate.parentPath,
      sourceMarkdown: parent.sourceMarkdown,
      localBytes,
      localByteHash,
      semanticHash: parent.semanticHash,
      structureHash: parent.structureHash,
      expectedEditedAt: parent.editedAt,
    }),
  });
  current.set(parent.pageId, parent);
  try {
    return await executeOperation(parentOperation, dependencies, current);
  } catch (caught) {
    const nested = caught instanceof CortexExecutionError ? caught : null;
    throw new CortexExecutionError(
      errorFrom(caught),
      parent.pageId,
      nested?.attentionFallbackPageIds ?? [],
      nested?.verifiedOutcomes ?? NO_VERIFIED_OUTCOMES,
    );
  }
}

async function executeOperation(
  operation: CortexExecutionOperation,
  dependencies: CortexExecutorDependencies,
  current: Map<string, CortexPageObservation>,
  prepared?: Readonly<{ readonly observed: CortexPageObservation; readonly intent: JournalIntentV1 }>,
): Promise<EffectOutcome> {
  const effect = operation.effect;
  const rootPageId = effect.rootPageId;
  const observed = prepared?.observed ?? await rereadRemote(operation, rootPageId, dependencies, current);
  const intent = prepared?.intent ?? await journalIntent(operation, observed, dependencies);
  if (prepared === undefined) await dependencies.journal.begin(intent);
  let outcome: EffectOutcome;
  let intentCompleted = false;

  if (effect.kind === "create-cortex-local") {
    await requireLocal(effect.path, null, dependencies);
    const bytes = operation.target.localBytes;
    if (bytes === null || operation.target.localByteHash === null) throw new CortexExecutionError(safeError("invalid-response"));
    const written = await dependencies.writer.create({ relativePath: effect.path, expectedAbsent: true, content: bytes });
    if (written.byteHash !== operation.target.localByteHash) throw new CortexExecutionError(safeError("revision-race"));
    await verifyLocal(effect.path, written.byteHash, dependencies);
    outcome = { remote: observed, pageId: observed.pageId, localByteHash: written.byteHash, localPath: effect.path };
  } else if (effect.kind === "write-cortex-local") {
    await requireLocal(effect.path, effect.expectedByteHash, dependencies);
    const bytes = operation.target.localBytes;
    if (bytes === null) throw new CortexExecutionError(safeError("invalid-response"));
    const written = await dependencies.writer.write({ relativePath: effect.path, expectedByteHash: effect.expectedByteHash, content: bytes });
    if (written.byteHash !== effect.resultByteHash) throw new CortexExecutionError(safeError("revision-race"));
    await verifyLocal(effect.path, written.byteHash, dependencies);
    outcome = { remote: observed, pageId: observed.pageId, localByteHash: written.byteHash, localPath: effect.path };
  } else if (effect.kind === "move-cortex-subtree") {
    await requireLocal(effect.sourcePath, effect.expectedSourceByteHash, dependencies);
    if (await dependencies.readLocalBytes(effect.targetPath) !== null) throw new CortexExecutionError(safeError("revision-race"));
    const moved = await dependencies.writer.moveCortexSubtree({
      sourcePath: effect.sourcePath,
      targetPath: effect.targetPath,
      expectedSourceByteHash: effect.expectedSourceByteHash,
    });
    if (moved.byteHash !== effect.expectedSourceByteHash) throw new CortexExecutionError(safeError("revision-race"));
    if (await dependencies.readLocalBytes(effect.sourcePath) !== null) throw new CortexExecutionError(safeError("revision-race"));
    await verifyLocal(effect.targetPath, moved.byteHash, dependencies);
    outcome = { remote: observed, pageId: observed.pageId, localByteHash: moved.byteHash, localPath: effect.targetPath };
  } else if (effect.kind === "create-cortex-conflict") {
    await requireLocal(effect.path, null, dependencies);
    const bytes = operation.target.localBytes;
    if (bytes === null) throw new CortexExecutionError(safeError("invalid-response"));
    const created = await dependencies.writer.create({ relativePath: effect.path, expectedAbsent: true, content: bytes });
    if (created.byteHash !== effect.resultByteHash) throw new CortexExecutionError(safeError("revision-race"));
    await verifyLocal(effect.path, created.byteHash, dependencies);
    outcome = { remote: observed, pageId: observed.pageId, localByteHash: created.byteHash, localPath: effect.path };
  } else if (effect.kind === "create-cortex-page") {
    const candidate = operation.candidate;
    if (candidate === null) throw new CortexExecutionError(safeError("invalid-response"));
    await requireLocal(candidate.path, candidate.byteHash, dependencies);
    let createdPageId: string | null = null;
    let createdRemoteId: string | null = null;
    const verifiedRelated: EffectOutcome[] = [];
    try {
      const created = await dependencies.notion.createCortexPage({
        rootPageId,
        parentPageId: effect.parentPageId,
        title: effect.title,
        markdown: candidate.sourceMarkdown,
        expectedParentEditedAt: observed.editedAt,
      });
      createdPageId = isCanonicalUuid(created.pageId) ? created.pageId : null;
      const remote = await verifyRemote(rootPageId, created, {
        pageId: null,
        parentPageId: effect.parentPageId,
        title: effect.title,
        sourceMarkdown: candidate.sourceMarkdown,
        semanticHash: effect.semanticHash,
        structureHash: null,
      }, dependencies);
      createdRemoteId = remote.pageId;
      const rebindOperation = await createdCandidateLocalOperation(operation, remote);
      // Begin the ID-bound local rebind before retiring the allocation intent.
      // If a process stops in either small window, recovery can only prove the
      // immutable state it sees or mark attention; it can never treat the bare
      // candidate hash as the postcondition of an ID-frontmatter rewrite.
      current.set(remote.pageId, remote);
      const rebindObserved = await rereadRemote(rebindOperation, rootPageId, dependencies, current);
      const rebindIntent = await journalIntent(rebindOperation, rebindObserved, dependencies);
      await dependencies.journal.begin(rebindIntent);
      const createOutcome: EffectOutcome = Object.freeze({
        remote,
        pageId: remote.pageId,
        localByteHash: candidate.byteHash,
        localPath: candidate.path,
      });
      await dependencies.journal.complete(intent.id, completion(createOutcome, dependencies.clock));
      intentCompleted = true;
      const rebind = await executeOperation(rebindOperation, dependencies, current, {
        observed: rebindObserved,
        intent: rebindIntent,
      });
      verifiedRelated.push(Object.freeze({ ...rebind, createdRemote: true }));
      const parentMarker = await synchronizeCreatedCandidateParent(operation, remote, dependencies, current);
      verifiedRelated.push(parentMarker);
      outcome = Object.freeze({
        remote,
        pageId: remote.pageId,
        localByteHash: candidate.byteHash,
        localPath: candidate.path,
        related: Object.freeze(verifiedRelated),
      });
    } catch (caught) {
      const nested = caught instanceof CortexExecutionError ? caught : null;
      const nestedOutcomes = outcomesForCreatedRemote(
        nested?.verifiedOutcomes ?? NO_VERIFIED_OUTCOMES,
        createdRemoteId,
      );
      const failedNewRemote = createdRemoteId !== null && nested?.pageId === createdRemoteId;
      throw new CortexExecutionError(
        errorFrom(caught),
        failedNewRemote ? null : nested?.pageId ?? createdPageId,
        [...(nested?.attentionFallbackPageIds ?? []), candidate.parentPageId, rootPageId],
        [...verifiedRelated, ...nestedOutcomes],
      );
    }
  } else if (effect.kind === "update-cortex-body") {
    const oldMarkdown = await markedRemoteMarkdown(observed.sourceMarkdown, observed.directChildPageIds);
    const nextMarkdown = await markedRemoteMarkdown(operation.target.sourceMarkdown ?? "", observed.directChildPageIds);
    const updated = await dependencies.notion.updateCortexBodyExact({
      rootPageId,
      pageId: effect.pageId,
      oldMarkdown,
      newMarkdown: nextMarkdown,
      observedEditedAt: observed.editedAt,
    });
    const remote = await verifyRemote(rootPageId, updated, {
      pageId: effect.pageId,
      parentPageId: observed.parentPageId,
      title: observed.title,
      sourceMarkdown: operation.target.sourceMarkdown,
      semanticHash: effect.nextSemanticHash,
      structureHash: observed.structureHash,
    }, dependencies);
    outcome = { remote, pageId: remote.pageId, localByteHash: operation.observedLocal?.byteHash ?? null, localPath: operation.observedLocal?.path ?? null };
  } else if (effect.kind === "update-cortex-title") {
    const updated = await dependencies.notion.updateCortexTitle({
      rootPageId,
      pageId: effect.pageId,
      title: effect.title,
      observedEditedAt: observed.editedAt,
    });
    const remote = await verifyRemote(rootPageId, updated, {
      pageId: effect.pageId,
      parentPageId: observed.parentPageId,
      title: effect.title,
      sourceMarkdown: observed.sourceMarkdown,
      semanticHash: observed.semanticHash,
      structureHash: observed.structureHash,
    }, dependencies);
    outcome = { remote, pageId: remote.pageId, localByteHash: operation.observedLocal?.byteHash ?? null, localPath: operation.observedLocal?.path ?? null };
  } else if (effect.kind === "move-cortex-page") {
    const moved = await dependencies.notion.moveCortexPage({
      rootPageId,
      pageId: effect.pageId,
      parentPageId: effect.parentPageId,
      observedEditedAt: observed.editedAt,
    });
    const remote = await verifyRemote(rootPageId, moved, {
      pageId: effect.pageId,
      parentPageId: effect.parentPageId,
      title: observed.title,
      sourceMarkdown: observed.sourceMarkdown,
      semanticHash: observed.semanticHash,
      structureHash: observed.structureHash,
    }, dependencies);
    outcome = { remote, pageId: remote.pageId, localByteHash: operation.observedLocal?.byteHash ?? null, localPath: operation.observedLocal?.path ?? null };
  } else {
    throw new CortexExecutionError(safeError("invalid-response"));
  }

  const completed = completedOutcome(outcome, effect);
  if (!intentCompleted) {
    try {
      await dependencies.journal.complete(intent.id, completion(completed, dependencies.clock));
    } catch (caught) {
      throw new CortexExecutionError(errorFrom(caught), completed.pageId, [], [completed]);
    }
  }
  if (completed.remote !== null) current.set(completed.remote.pageId, completed.remote);
  return completed;
}

function sameState(left: CortexTreeStateV1 | null | undefined, right: CortexTreeStateV1 | null): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}

function withAttention(
  tree: CortexTreeStateV1 | null,
  pageIds: readonly (string | null | undefined)[],
): CortexTreeStateV1 | null {
  if (tree === null) return tree;
  const pageId = pageIds.find((candidate): candidate is string => candidate !== null &&
    candidate !== undefined &&
    tree.pages[candidate] !== undefined &&
    tree.pages[candidate]?.status !== "conflict");
  if (pageId === undefined) return tree;
  return Object.freeze({
    ...tree,
    pages: Object.freeze({ ...tree.pages, [pageId]: Object.freeze({ ...tree.pages[pageId] as CortexPageStateV1, status: "attention" }) }),
  });
}

function relocatedSubtreePath(
  path: string,
  sourcePath: string,
  targetPath: string,
): string | null {
  if (path === sourcePath) return targetPath;
  if (!sourcePath.endsWith(".md") || !targetPath.endsWith(".md")) return null;
  const sourceDirectory = sourcePath.slice(0, -3);
  const targetDirectory = targetPath.slice(0, -3);
  return path.startsWith(`${sourceDirectory}/`)
    ? `${targetDirectory}${path.slice(sourceDirectory.length)}`
    : null;
}

function isLocalPathFinalization(outcome: EffectOutcome): boolean {
  return outcome.effectKind === "create-cortex-local" ||
    outcome.effectKind === "write-cortex-local" ||
    outcome.effectKind === "move-cortex-subtree";
}

/**
 * A successful subtree writer proves that every existing descendant moved on
 * disk. For descendants without a later verified local rewrite, retain only
 * that proven transformed path and put them behind an attention boundary.
 */
function applyVerifiedSubtreeRelocations(
  prior: CortexTreeStateV1 | null,
  pages: Record<string, CortexPageStateV1>,
  outcomes: readonly EffectOutcome[],
): void {
  if (prior === null) return;
  const finalizationIndex = new Map<string, number>();
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.pageId !== null && isLocalPathFinalization(outcome)) finalizationIndex.set(outcome.pageId, index);
  }
  const physicalPaths = new Map(Object.entries(prior.pages).map(([pageId, page]) => [pageId, page.localPath]));
  for (const [index, outcome] of outcomes.entries()) {
    const boundary = outcome.movedSubtree;
    if (boundary === undefined) continue;
    for (const [pageId, current] of Object.entries(pages)) {
      const physicalPath = physicalPaths.get(pageId);
      if (physicalPath === undefined) continue;
      const relocatedPath = relocatedSubtreePath(physicalPath, boundary.sourcePath, boundary.targetPath);
      if (relocatedPath === null) continue;
      physicalPaths.set(pageId, relocatedPath);
      if ((finalizationIndex.get(pageId) ?? -1) >= index) continue;
      pages[pageId] = Object.freeze({ ...current, localPath: relocatedPath, status: "attention" });
    }
  }
}

function refreshState(
  provisional: CortexTreeStateV1 | null,
  prior: CortexTreeStateV1 | null,
  remotes: ReadonlyMap<string, CortexPageObservation>,
  outcomes: readonly EffectOutcome[],
  plan: CortexExecutableTreePlan,
  clock: Clock,
): CortexTreeStateV1 | null {
  if (provisional === null) return null;
  const pages: Record<string, CortexPageStateV1> = { ...provisional.pages };
  const expandedOutcomes = flattenOutcomes(outcomes);
  const outcomeByPage = new Map(expandedOutcomes.filter((outcome) => outcome.pageId !== null).map((outcome) => [outcome.pageId as string, outcome]));
  for (const [pageId, page] of Object.entries(pages)) {
    const remote = remotes.get(pageId);
    if (remote === undefined || page.status !== "synced") continue;
    const outcome = outcomeByPage.get(pageId);
    const operation = plan.operations.find((candidate) => candidate.pageId === pageId);
    pages[pageId] = Object.freeze({
      ...page,
      parentPageId: remote.parentPageId,
      title: remote.title,
      localPath: outcome?.localPath ?? operation?.target.path ?? page.localPath,
      lastLocalSemanticHash: remote.semanticHash,
      lastNotionSemanticHash: remote.semanticHash,
      lastCommonSemanticHash: remote.semanticHash,
      lastCommonStructureHash: remote.structureHash,
      lastCommonLocalByteHash: outcome?.localByteHash ?? page.lastCommonLocalByteHash,
      lastNotionEditedAt: remote.editedAt,
      lastSyncedAt: now(clock),
    });
  }
  applyVerifiedSubtreeRelocations(prior, pages, expandedOutcomes);
  // A successfully created local candidate becomes a regular owned Cortex
  // page only after both provider and local postconditions were verified.
  for (const outcome of expandedOutcomes) {
    if (!outcome.createdRemote || outcome.remote === null || outcome.localPath === null || outcome.localByteHash === null) continue;
    const remote = outcome.remote;
    pages[remote.pageId] = Object.freeze({
      pageId: remote.pageId,
      parentPageId: remote.parentPageId,
      rootPageId: remote.rootPageId,
      localPath: outcome.localPath,
      title: remote.title,
      status: "synced",
      lastLocalSemanticHash: remote.semanticHash,
      lastNotionSemanticHash: remote.semanticHash,
      lastCommonSemanticHash: remote.semanticHash,
      lastCommonStructureHash: remote.structureHash,
      lastCommonLocalByteHash: outcome.localByteHash,
      lastNotionEditedAt: remote.editedAt,
      lastSyncedAt: now(clock),
      lastSeenTraversalId: plan.traversalId ?? provisional.lastSuccessfulTraversalId ?? remote.pageId,
    });
  }
  return Object.freeze({ ...provisional, pages: Object.freeze(pages) });
}

/**
 * Failure persistence starts from the durable input state, never from the
 * plan's all-pages future snapshot.  Only outcomes that completed their own
 * provider/filesystem verification may advance an existing page; every other
 * page retains its prior durable projection until a later reconciliation.
 */
function refreshVerifiedState(
  prior: CortexTreeStateV1 | null,
  outcomes: readonly EffectOutcome[],
  plan: CortexExecutableTreePlan,
  clock: Clock,
): CortexTreeStateV1 | null {
  if (prior === null) return null;
  const pages: Record<string, CortexPageStateV1> = { ...prior.pages };
  const expandedOutcomes = flattenOutcomes(outcomes);
  for (const outcome of expandedOutcomes) {
    if (outcome.remote === null || outcome.pageId === null) continue;
    // A conflict artifact is evidence that the original page remains an
    // explicit resolution boundary. It must never become that page's local
    // projection or advance its common baseline if a later effect fails.
    if (outcome.effectKind === "create-cortex-conflict") {
      const existing = pages[outcome.pageId];
      if (existing !== undefined) {
        pages[outcome.pageId] = Object.freeze({ ...existing, status: "conflict" });
      }
      continue;
    }
    const remote = outcome.remote;
    const existing = pages[remote.pageId];
    if (existing !== undefined) {
      pages[remote.pageId] = Object.freeze({
        ...existing,
        parentPageId: remote.parentPageId,
        title: remote.title,
        localPath: outcome.localPath ?? existing.localPath,
        lastLocalSemanticHash: remote.semanticHash,
        lastNotionSemanticHash: remote.semanticHash,
        lastCommonSemanticHash: remote.semanticHash,
        lastCommonStructureHash: remote.structureHash,
        lastCommonLocalByteHash: outcome.localByteHash ?? existing.lastCommonLocalByteHash,
        lastNotionEditedAt: remote.editedAt,
        lastSyncedAt: now(clock),
      });
    }
    if (!outcome.createdRemote || outcome.localPath === null || outcome.localByteHash === null) continue;
    pages[remote.pageId] = Object.freeze({
      pageId: remote.pageId,
      parentPageId: remote.parentPageId,
      rootPageId: remote.rootPageId,
      localPath: outcome.localPath,
      title: remote.title,
      status: "synced",
      lastLocalSemanticHash: remote.semanticHash,
      lastNotionSemanticHash: remote.semanticHash,
      lastCommonSemanticHash: remote.semanticHash,
      lastCommonStructureHash: remote.structureHash,
      lastCommonLocalByteHash: outcome.localByteHash,
      lastNotionEditedAt: remote.editedAt,
      lastSyncedAt: now(clock),
      lastSeenTraversalId: plan.traversalId ?? prior.lastSuccessfulTraversalId ?? remote.pageId,
    });
  }
  applyVerifiedSubtreeRelocations(prior, pages, expandedOutcomes);
  return Object.freeze({ ...prior, pages: Object.freeze(pages) });
}

async function persist(
  state: BridgeStateV1,
  cortex: CortexTreeStateV1 | null,
  dependencies: CortexExecutorDependencies,
): Promise<BridgeStateV1> {
  const next: BridgeStateV1 = Object.freeze({ ...state, schemaVersion: 2, cortex });
  if (dependencies.persistState !== undefined) await dependencies.persistState(next);
  return next;
}

/**
 * Executes one fresh Cortex-only plan. It never replays old effects: an
 * incomplete journal record is intentionally left for prove-or-attention
 * recovery before a caller schedules another plan.
 */
export async function executeCortexTreePlan(
  input: ExecuteCortexTreePlanInput,
  dependencies: CortexExecutorDependencies,
): Promise<CortexExecutionResult> {
  if (input.plan.error !== null) {
    const cortex = withAttention(input.plan.nextCortex ?? input.state.cortex ?? null, []);
    try {
      const state = await persist(input.state, cortex, dependencies);
      return Object.freeze({ state, outcome: "attention", writes: 0, completedEffects: 0, error: input.plan.error });
    } catch {
      return Object.freeze({ state: input.state, outcome: "error", writes: 0, completedEffects: 0, error: safeError("recovery-required") });
    }
  }

  const current = new Map<string, CortexPageObservation>();
  for (const operation of input.plan.operations) {
    if (operation.observedRemote !== null) current.set(operation.observedRemote.pageId, operation.observedRemote);
  }
  const outcomes: EffectOutcome[] = [];
  let failedOperation: CortexExecutionOperation | null = null;
  try {
    for (const operation of input.plan.operations) {
      failedOperation = operation;
      outcomes.push(await executeOperation(operation, dependencies, current));
      failedOperation = null;
    }
    const cortex = refreshState(input.plan.nextCortex, input.state.cortex ?? null, current, outcomes, input.plan, dependencies.clock);
    const state = sameState(input.state.cortex, cortex)
      ? input.state
      : await persist(input.state, cortex, dependencies);
    const outcome = input.plan.pages.some((page) => page.action === "attention")
      ? "attention"
      : input.plan.pages.some((page) => page.action === "conflict")
        ? "conflict"
        : "success";
    const completedEffects = flattenOutcomes(outcomes).length;
    return Object.freeze({ state, outcome, writes: completedEffects, completedEffects, error: null });
  } catch (caught) {
    const error = errorFrom(caught);
    if (caught instanceof CortexExecutionError) outcomes.push(...caught.verifiedOutcomes);
    const failurePageId = caught instanceof CortexExecutionError && caught.pageId !== null
      ? caught.pageId
      : failedOperation?.pageId ?? null;
    const fallbackPageIds = caught instanceof CortexExecutionError ? caught.attentionFallbackPageIds : [];
    const cortex = withAttention(
      refreshVerifiedState(input.state.cortex ?? null, outcomes, input.plan, dependencies.clock),
      [failurePageId, ...fallbackPageIds],
    );
    try {
      const state = await persist(input.state, cortex, dependencies);
      const completedEffects = flattenOutcomes(outcomes).length;
      return Object.freeze({ state, outcome: "attention", writes: completedEffects, completedEffects, error });
    } catch {
      const completedEffects = flattenOutcomes(outcomes).length;
      return Object.freeze({ state: input.state, outcome: "error", writes: completedEffects, completedEffects, error: safeError("recovery-required") });
    }
  }
}
