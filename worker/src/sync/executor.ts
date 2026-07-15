import {
  parseJournalCompletion,
  parseJournalIntent,
  type BridgeStateV1,
  type Clock,
  type JournalCompletionV1,
  type JournalIntentV1,
  type NotionApi,
  type NotionObservation,
  type PairPlan,
  type PairPlanningInput,
  type PairStateAdvance,
  type PairStateV1,
  type PlannedEffect,
  type SafeError,
  type SafeErrorCode,
  type UuidSource,
} from "@grandbox-bridge/shared";
import { sha256Hex } from "@grandbox-bridge/shared";
import { upsertBridgeId } from "../markdown/frontmatter.js";
import type { JournalStore } from "../persistence/journal-store.js";
import type { VaultWriter } from "../vault/writer.js";
import { safeErrorFrom } from "./reconcile.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface PlannedPair {
  readonly input: PairPlanningInput;
  readonly plan: PairPlan;
}

export interface ExecutorDependencies {
  readonly installationId: string;
  readonly notionConfig: Readonly<{
    parentPageId: string;
    dataSourceId: string;
  }>;
  readonly journal: JournalStore;
  readonly notion: NotionApi;
  readonly writer: VaultWriter;
  readonly uuid: UuidSource;
  readonly clock: Clock;
  readonly readLocalBytes: (relativePath: string) => Promise<string | null>;
}

export interface ExecutionCounts {
  readonly planned: number;
  readonly writes: number;
  readonly pushed: number;
  readonly pulled: number;
  readonly conflicts: number;
  readonly errors: number;
  readonly succeededPairs: number;
}

export interface ExecutionResult {
  readonly state: BridgeStateV1;
  readonly counts: ExecutionCounts;
}

interface EffectResult {
  readonly local: { readonly byteHash: string; readonly semanticHash: string | null } | null;
  readonly remote: Extract<NotionObservation, { readonly kind: "present" }> | null;
  readonly bridgeId: string | null;
}

interface PairExecutionResult {
  readonly ok: boolean;
  readonly state: BridgeStateV1;
  readonly writes: number;
  readonly error: SafeError | null;
}

export class ExecutorError extends Error {
  public constructor(public readonly error: SafeError) {
    super("Executor failed");
    this.name = "ExecutorError";
  }
}

function fixedError(code: SafeErrorCode, retryable = false): SafeError {
  return Object.freeze({ code, retryable });
}

function timestamp(clock: Clock): string {
  try {
    const value = clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Invalid time");
    return value.toISOString();
  } catch {
    throw new ExecutorError(fixedError("internal-error"));
  }
}

function nextUuid(uuid: UuidSource): string {
  try {
    const value = uuid.randomUUID();
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("Invalid UUID");
    return value;
  } catch {
    throw new ExecutorError(fixedError("internal-error"));
  }
}

function currentRemote(
  input: PairPlanningInput,
  results: readonly EffectResult[],
): Extract<NotionObservation, { readonly kind: "present" }> {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const remote = results[index]?.remote;
    if (remote !== null && remote !== undefined) return remote;
  }
  if (input.notion.kind !== "present") throw new ExecutorError(fixedError("invalid-response"));
  return input.notion;
}

function expectedRevision(
  effect: Extract<PlannedEffect, { readonly expectedRevision: unknown }>,
  input: PairPlanningInput,
  results: readonly EffectResult[],
): string {
  if (effect.expectedRevision.kind === "observed") {
    if (input.notion.kind !== "present" || input.notion.editedAt !== effect.expectedRevision.editedAt) {
      throw new ExecutorError(fixedError("revision-race"));
    }
    return effect.expectedRevision.editedAt;
  }
  const result = results[effect.expectedRevision.effectIndex];
  if (result?.remote === null || result?.remote === undefined) {
    throw new ExecutorError(fixedError("revision-race"));
  }
  return result.remote.editedAt;
}

function managedMatches(
  remote: Extract<NotionObservation, { readonly kind: "present" }>,
  expected: Extract<PlannedEffect, { readonly kind: "update-notion-properties" }> ["expected"],
): boolean {
  return (
    remote.managed.title === expected.title &&
    remote.managed.obsidianPath === expected.obsidianPath &&
    remote.managed.status === expected.status &&
    remote.semantic.tags.length === expected.tags.length &&
    remote.semantic.tags.every((tag, index) => tag === expected.tags[index])
  );
}

function effectIntent(
  effect: PlannedEffect,
  context: {
    readonly id: string;
    readonly installationId: string;
    readonly createdAt: string;
    readonly allocationId: string | null;
    readonly resultByteHash: string | null;
    readonly expectedSemanticHash: string | null;
    readonly resultSemanticHash: string | null;
    readonly expectedRemoteEditedAt: string | null;
  },
): JournalIntentV1 {
  const local = effect.kind === "initialize-pair" || effect.kind === "write-local" || effect.kind === "create-conflict";
  const remote = effect.kind === "create-notion-page" || effect.kind === "update-notion-body-exact" || effect.kind === "update-notion-properties" || effect.kind === "set-notion-status";
  const relativePath =
    effect.kind === "initialize-pair" || effect.kind === "write-local" || effect.kind === "create-conflict"
      ? effect.path
      : null;
  const remoteId =
    effect.kind === "update-notion-body-exact" || effect.kind === "update-notion-properties" || effect.kind === "set-notion-status"
      ? effect.pageId
      : null;
  const expectedByteHash =
    effect.kind === "initialize-pair" || effect.kind === "write-local" ? effect.expectedByteHash : null;
  const intent = {
    schemaVersion: 1 as const,
    id: context.id,
    installationId: context.installationId,
    effectKind: effect.kind,
    relativePath: local ? relativePath : null,
    remoteId: remote ? remoteId : null,
    allocationId: context.allocationId,
    expectedByteHash,
    expectedSemanticHash: context.expectedSemanticHash,
    resultByteHash: context.resultByteHash,
    resultSemanticHash: context.resultSemanticHash,
    expectedRemoteEditedAt: context.expectedRemoteEditedAt,
    createdAt: context.createdAt,
  };
  return parseJournalIntent(intent);
}

function completion(
  clock: Clock,
  result: EffectResult,
): JournalCompletionV1 {
  return parseJournalCompletion({
    schemaVersion: 1,
    resultByteHash: result.local?.byteHash ?? null,
    resultSemanticHash: result.local?.semanticHash ?? null,
    resultRemoteId: result.remote?.pageId ?? null,
    allocatedBridgeId: result.bridgeId,
    observedRemoteEditedAt: result.remote?.editedAt ?? null,
    completedAt: timestamp(clock),
  });
}

function localSemanticForWrite(input: PairPlanningInput): string {
  if (input.notion.kind !== "present") throw new ExecutorError(fixedError("invalid-response"));
  return input.notion.semanticHash;
}

function resolvedBridgeId(identity: PairPlan["identity"], allocated: string | null): string {
  if (identity === null) throw new ExecutorError(fixedError("invalid-response"));
  if (identity.kind === "existing") return identity.bridgeId;
  if (allocated === null) throw new ExecutorError(fixedError("invalid-response"));
  return allocated;
}

function shallowState(state: Readonly<BridgeStateV1>): BridgeStateV1 {
  return {
    schemaVersion: 1,
    installationId: state.installationId,
    pairs: Object.fromEntries(Object.entries(state.pairs).map(([id, pair]) => [id, { ...pair }])),
    graph: state.graph === null ? null : { ...state.graph },
    lastFullReconciliationAt: state.lastFullReconciliationAt,
    lastRun: state.lastRun === null ? null : { ...state.lastRun },
  };
}

function localEvidence(
  advance: Extract<PairStateAdvance, { readonly kind: "establish-common" }>,
  input: PairPlanningInput,
  effects: readonly EffectResult[],
): { readonly byteHash: string; readonly semanticHash: string } {
  const recentLocal = [...effects].reverse().find((result) => result.local !== null)?.local;
  if (recentLocal !== undefined && recentLocal !== null && recentLocal.semanticHash !== null) {
    return { byteHash: recentLocal.byteHash, semanticHash: recentLocal.semanticHash };
  }
  if (advance.localEvidence.kind === "effect-result") {
    const result = effects[advance.localEvidence.effectIndex]?.local;
    if (result === null || result === undefined || result.semanticHash === null) {
      throw new ExecutorError(fixedError("invalid-response"));
    }
    return { byteHash: result.byteHash, semanticHash: result.semanticHash };
  }
  if (input.local.kind !== "present") throw new ExecutorError(fixedError("invalid-response"));
  return { byteHash: input.local.byteHash, semanticHash: input.local.semanticHash };
}

function remoteEvidence(
  evidence: Extract<PairStateAdvance, { readonly kind: "establish-common" }> ["notionEvidence"],
  input: PairPlanningInput,
  effects: readonly EffectResult[],
): Extract<NotionObservation, { readonly kind: "present" }> {
  if (evidence.kind === "effect-result") {
    const result = effects[evidence.effectIndex]?.remote;
    if (result === null || result === undefined) throw new ExecutorError(fixedError("invalid-response"));
    return result;
  }
  if (input.notion.kind !== "present") throw new ExecutorError(fixedError("invalid-response"));
  return input.notion;
}

function applyStateAdvance(
  state: BridgeStateV1,
  input: PairPlanningInput,
  plan: PairPlan,
  effects: readonly EffectResult[],
  clock: Clock,
): BridgeStateV1 {
  const advance = plan.stateAdvance;
  if (advance.kind === "none") return state;
  const next = shallowState(state);
  if (advance.kind === "preserve-common") {
    const evidence = advance.notionRevision === null
      ? null
      : advance.notionRevision.kind === "observation"
        ? input.notion.kind === "present" ? input.notion : null
        : effects[advance.notionRevision.effectIndex]?.remote ?? null;
    const prior = next.pairs[advance.base.bridgeId];
    if (prior === undefined) throw new ExecutorError(fixedError("invalid-state"));
    next.pairs[advance.base.bridgeId] = {
      ...prior,
      status: advance.status,
      localPath: advance.localPath,
      ...(evidence === null ? {} : { lastNotionEditedAt: evidence.editedAt }),
    };
    return next;
  }

  const identity = resolvedBridgeId(plan.identity, effects.find((effect) => effect.bridgeId !== null)?.bridgeId ?? null);
  const local = localEvidence(advance, input, effects);
  const notion = remoteEvidence(advance.notionEvidence, input, effects);
  const now = timestamp(clock);
  const pair: PairStateV1 = {
    bridgeId: identity,
    localPath: advance.localPath,
    notionPageId: notion.pageId,
    status: "synced",
    lastLocalSemanticHash: local.semanticHash,
    lastNotionSemanticHash: notion.semanticHash,
    lastCommonSemanticHash: advance.semanticHash,
    lastCommonLocalByteHash: local.byteHash,
    lastNotionEditedAt: notion.editedAt,
    lastSyncedAt: now,
  };
  next.pairs[identity] = pair;
  return next;
}

async function executeEffect(
  effect: PlannedEffect,
  input: PairPlanningInput,
  plan: PairPlan,
  results: readonly EffectResult[],
  dependencies: ExecutorDependencies,
  allocatedBridgeId: string | null,
): Promise<EffectResult> {
  let plannedLocal: { readonly content: string; readonly byteHash: string; readonly semanticHash: string } | null = null;
  let expectedSemanticHash: string | null = null;
  let resultSemanticHash: string | null = null;
  let expectedRemoteEditedAt: string | null = null;
  let allocationId: string | null = null;
  let bridgeId = allocatedBridgeId;

  if (effect.kind === "initialize-pair") {
    if (effect.identity.kind !== "allocate-on-apply") throw new ExecutorError(fixedError("invalid-response"));
    const current = await dependencies.readLocalBytes(effect.path);
    if (current === null) throw new ExecutorError(fixedError("revision-race"));
    const currentHash = await sha256Hex(current);
    if (currentHash !== effect.expectedByteHash || input.local.kind !== "present") {
      throw new ExecutorError(fixedError("revision-race"));
    }
    bridgeId = nextUuid(dependencies.uuid);
    const content = upsertBridgeId(current, bridgeId);
    plannedLocal = {
      content,
      byteHash: await sha256Hex(content),
      semanticHash: input.local.semanticHash,
    };
    allocationId = effect.identity.allocationId;
    expectedSemanticHash = input.local.semanticHash;
    resultSemanticHash = input.local.semanticHash;
  } else if (effect.kind === "create-notion-page") {
    if (input.local.kind !== "present") throw new ExecutorError(fixedError("invalid-response"));
    allocationId = effect.identity.kind === "allocate-on-apply" ? effect.identity.allocationId : null;
    expectedSemanticHash = input.local.semanticHash;
    resultSemanticHash = input.local.semanticHash;
  } else if (effect.kind === "write-local") {
    plannedLocal = {
      content: effect.nextBytes,
      byteHash: effect.expectedNextByteHash,
      semanticHash: localSemanticForWrite(input),
    };
    expectedSemanticHash = input.local.kind === "present" ? input.local.semanticHash : null;
    resultSemanticHash = plannedLocal.semanticHash;
  } else if (effect.kind === "create-conflict") {
    plannedLocal = { content: effect.content, byteHash: await sha256Hex(effect.content), semanticHash: "" };
  } else if (input.notion.kind === "present") {
    expectedSemanticHash = input.notion.semanticHash;
    resultSemanticHash = effect.kind === "update-notion-body-exact" && input.local.kind === "present"
      ? input.local.semanticHash
      : input.notion.semanticHash;
    expectedRemoteEditedAt = expectedRevision(effect, input, results);
  }

  const intent = effectIntent(effect, {
    id: nextUuid(dependencies.uuid),
    installationId: dependencies.installationId,
    createdAt: timestamp(dependencies.clock),
    allocationId,
    resultByteHash: plannedLocal?.byteHash ?? null,
    expectedSemanticHash,
    resultSemanticHash,
    expectedRemoteEditedAt,
  });
  await dependencies.journal.begin(intent);

  let result: EffectResult;
  if (effect.kind === "initialize-pair") {
    if (plannedLocal === null) throw new ExecutorError(fixedError("internal-error"));
    const written = await dependencies.writer.write({
      relativePath: effect.path,
      expectedByteHash: effect.expectedByteHash,
      content: plannedLocal.content,
    });
    if (written.byteHash !== plannedLocal.byteHash) throw new ExecutorError(fixedError("revision-race"));
    result = { local: { byteHash: written.byteHash, semanticHash: plannedLocal.semanticHash }, remote: null, bridgeId };
  } else if (effect.kind === "create-notion-page") {
    const observed = await dependencies.notion.createNotePage({
      parentPageId: dependencies.notionConfig.parentPageId,
      dataSourceId: dependencies.notionConfig.dataSourceId,
      bridgeId: resolvedBridgeId(effect.identity, bridgeId),
      title: effect.title,
      obsidianPath: effect.obsidianPath,
      tags: effect.tags,
      markdown: effect.markdown,
    });
    if (observed.kind !== "present") throw new ExecutorError(fixedError("invalid-response"));
    result = { local: null, remote: observed, bridgeId };
  } else if (effect.kind === "update-notion-body-exact") {
    const observed = await dependencies.notion.updateBodyExact({
      pageId: effect.pageId,
      oldMarkdown: effect.oldMarkdown,
      newMarkdown: effect.newMarkdown,
      observedEditedAt: expectedRevision(effect, input, results),
    });
    if (observed.kind !== "present") throw new ExecutorError(fixedError("invalid-response"));
    result = { local: null, remote: observed, bridgeId };
  } else if (effect.kind === "update-notion-properties") {
    const remote = currentRemote(input, results);
    if (!managedMatches(remote, effect.expected)) throw new ExecutorError(fixedError("revision-race"));
    const observed = await dependencies.notion.updateManagedProperties({
      pageId: effect.pageId,
      title: effect.next.title,
      obsidianPath: effect.next.obsidianPath,
      tags: effect.next.tags,
      status: effect.next.status,
      observedEditedAt: expectedRevision(effect, input, results),
    });
    if (observed.kind !== "present") throw new ExecutorError(fixedError("invalid-response"));
    result = { local: null, remote: observed, bridgeId };
  } else if (effect.kind === "set-notion-status") {
    const remote = currentRemote(input, results);
    if (remote.managed.status !== effect.expectedStatus) throw new ExecutorError(fixedError("revision-race"));
    const observed = await dependencies.notion.updateManagedProperties({
      pageId: effect.pageId,
      title: remote.managed.title,
      obsidianPath: remote.managed.obsidianPath,
      tags: remote.semantic.tags,
      status: effect.nextStatus,
      observedEditedAt: expectedRevision(effect, input, results),
    });
    if (observed.kind !== "present") throw new ExecutorError(fixedError("invalid-response"));
    result = { local: null, remote: observed, bridgeId };
  } else if (effect.kind === "write-local") {
    if (plannedLocal === null) throw new ExecutorError(fixedError("internal-error"));
    const written = await dependencies.writer.write({
      relativePath: effect.path,
      expectedByteHash: effect.expectedByteHash,
      content: effect.nextBytes,
    });
    if (written.byteHash !== effect.expectedNextByteHash) throw new ExecutorError(fixedError("revision-race"));
    result = { local: { byteHash: written.byteHash, semanticHash: plannedLocal.semanticHash }, remote: null, bridgeId };
  } else {
    if (plannedLocal === null) throw new ExecutorError(fixedError("internal-error"));
    const written = await dependencies.writer.create({
      relativePath: effect.path,
      expectedAbsent: true,
      content: effect.content,
    });
    if (written.byteHash !== plannedLocal.byteHash) throw new ExecutorError(fixedError("revision-race"));
    result = { local: { byteHash: written.byteHash, semanticHash: null }, remote: null, bridgeId };
  }

  await dependencies.journal.complete(intent.id, completion(dependencies.clock, result));
  return result;
}

async function executePair(
  current: BridgeStateV1,
  pair: PlannedPair,
  dependencies: ExecutorDependencies,
): Promise<PairExecutionResult> {
  if (pair.plan.error !== null) {
    return { ok: false, state: current, writes: 0, error: pair.plan.error };
  }
  const results: EffectResult[] = [];
  let allocatedBridgeId: string | null = null;
  try {
    for (const effect of pair.plan.effects) {
      const result = await executeEffect(effect, pair.input, pair.plan, results, dependencies, allocatedBridgeId);
      results.push(result);
      if (result.bridgeId !== null) allocatedBridgeId = result.bridgeId;
    }
    return {
      ok: true,
      state: applyStateAdvance(current, pair.input, pair.plan, results, dependencies.clock),
      writes: pair.plan.effects.length,
      error: null,
    };
  } catch (caught) {
    const error = caught instanceof ExecutorError ? caught.error : safeErrorFrom(caught);
    return { ok: false, state: current, writes: results.length, error };
  }
}

function countAction(plan: PairPlan, counts: { pushed: number; pulled: number; conflicts: number }): void {
  if (plan.action === "initialize" || plan.action === "push-local") counts.pushed += 1;
  if (plan.action === "pull-notion") counts.pulled += 1;
  if (plan.action === "conflict") counts.conflicts += 1;
}

/** Applies each already-validated pair plan once, never replaying an old effect list. */
export async function executePlans(
  state: Readonly<BridgeStateV1>,
  pairs: readonly PlannedPair[],
  dependencies: ExecutorDependencies,
  initialErrors = 0,
): Promise<ExecutionResult> {
  let next = shallowState(state);
  const mutable = {
    planned: pairs.reduce((total, pair) => total + pair.plan.effects.length, 0),
    writes: 0,
    pushed: 0,
    pulled: 0,
    conflicts: 0,
    errors: initialErrors,
    succeededPairs: 0,
  };
  for (const pair of pairs) {
    const result = await executePair(next, pair, dependencies);
    mutable.writes += result.writes;
    if (!result.ok) {
      mutable.errors += 1;
      continue;
    }
    next = result.state;
    mutable.succeededPairs += 1;
    countAction(pair.plan, mutable);
  }
  return Object.freeze({ state: next, counts: Object.freeze(mutable) });
}
