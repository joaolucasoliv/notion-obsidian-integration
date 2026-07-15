import {
  parseJournalCompletion,
  parseJournalIntent,
  type BridgeRunSummary,
  type BridgeStateV1,
  type Clock,
  type CredentialStore,
  type NotionApi,
  type SafeError,
  type SafeErrorCode,
  type SafeLogger,
  type UuidSource,
  type ParsedBridgeConfigV1,
  type ParsedBridgeStateV1,
  type JournalCompletionV1,
  type JournalIntentV1,
} from "@grandbox-bridge/shared";
import type { ConfigStore } from "./persistence/config-store.js";
import type { JournalStore } from "./persistence/journal-store.js";
import { recoverIncompleteJournal, type RemoteRecoveryObserver } from "./persistence/recovery.js";
import type { StateStore } from "./persistence/state-store.js";
import { safeErrorFrom, localRecoveryObservation, reconcilePairs, type ReconciliationResult } from "./sync/reconcile.js";
import { executePlans, type PlannedPair } from "./sync/executor.js";
import { planPair, validatePlanningBatch } from "./sync/planner.js";
import { scanVaultNotes } from "./vault/scanner.js";
import { type CanonicalVaultRoot } from "./vault/safety.js";
import { AtomicVaultWriter, type VaultWriter } from "./vault/writer.js";
import { semanticHash } from "./markdown/normalize.js";

export type WorkerRunInput = {
  readonly mode: "preview" | "apply";
  readonly reason: "manual" | "obsidian-event" | "schedule" | "reconciliation";
};

export interface BridgeWorker {
  run(input: WorkerRunInput): Promise<BridgeRunSummary>;
}

export interface WorkerLock {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export interface WorkerDependencies {
  readonly config: ConfigStore;
  readonly state: StateStore;
  readonly credentials: CredentialStore;
  readonly journal: JournalStore;
  readonly lock: WorkerLock;
  readonly clock: Clock;
  readonly uuid: UuidSource;
  readonly logger?: SafeLogger;
  readonly canonicalizeVault: (config: Readonly<ParsedBridgeConfigV1>) => Promise<CanonicalVaultRoot>;
  readonly createNotionApi: (
    token: string,
    context: Readonly<{ config: Readonly<ParsedBridgeConfigV1>; state: Readonly<ParsedBridgeStateV1>; root: CanonicalVaultRoot }>,
  ) => Promise<NotionApi> | NotionApi;
  readonly createWriter?: (root: CanonicalVaultRoot) => VaultWriter;
}

interface LoadedRunContext {
  readonly config: Readonly<ParsedBridgeConfigV1>;
  readonly state: Readonly<ParsedBridgeStateV1>;
  readonly root: CanonicalVaultRoot;
  readonly token: string;
}

class WorkerFailure extends Error {
  public constructor(public readonly error: SafeError) {
    super("Worker failure");
    this.name = "WorkerFailure";
  }
}

function fixedError(code: SafeErrorCode, retryable = false): SafeError {
  return Object.freeze({ code, retryable });
}

function safeTimestamp(clock: Clock): string {
  try {
    const value = clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Invalid clock");
    return value.toISOString();
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

function nextJournalId(uuid: UuidSource): string {
  try {
    const value = uuid.randomUUID();
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("Invalid UUID");
    return value;
  } catch {
    throw new WorkerFailure(fixedError("internal-error"));
  }
}

function stateCommitIntent(installationId: string, uuid: UuidSource, clock: Clock): JournalIntentV1 {
  return parseJournalIntent({
    schemaVersion: 1,
    id: nextJournalId(uuid),
    installationId,
    effectKind: "commit-state",
    relativePath: null,
    remoteId: null,
    allocationId: null,
    expectedByteHash: null,
    expectedSemanticHash: null,
    resultByteHash: null,
    resultSemanticHash: null,
    expectedRemoteEditedAt: null,
    createdAt: safeTimestamp(clock),
  });
}

function stateCommitCompletion(clock: Clock): JournalCompletionV1 {
  return parseJournalCompletion({
    schemaVersion: 1,
    resultByteHash: null,
    resultSemanticHash: null,
    resultRemoteId: null,
    allocatedBridgeId: null,
    observedRemoteEditedAt: null,
    completedAt: safeTimestamp(clock),
  });
}

function summary(
  input: WorkerRunInput,
  startedAt: string,
  counts: Pick<BridgeRunSummary, "planned" | "writes" | "pushed" | "pulled" | "conflicts" | "errors">,
  outcome: BridgeRunSummary["outcome"],
  clock: Clock,
): BridgeRunSummary {
  return Object.freeze({
    mode: input.mode,
    outcome,
    planned: counts.planned,
    writes: counts.writes,
    pushed: counts.pushed,
    pulled: counts.pulled,
    conflicts: counts.conflicts,
    errors: counts.errors,
    graphUploads: 0,
    startedAt,
    completedAt: safeTimestamp(clock),
  });
}

function failedSummary(input: WorkerRunInput, startedAt: string, clock: Clock): BridgeRunSummary {
  return summary(input, startedAt, { planned: 0, writes: 0, pushed: 0, pulled: 0, conflicts: 0, errors: 1 }, "failed", clock);
}

function safeLog(logger: SafeLogger | undefined, entry: Parameters<SafeLogger["write"]>[0]): void {
  try {
    logger?.write(entry);
  } catch {
    // Diagnostics must never turn a safe worker result into a raw exception.
  }
}

function validateContext(config: Readonly<ParsedBridgeConfigV1>, state: Readonly<ParsedBridgeStateV1>): void {
  if (
    config.installationId !== state.installationId ||
    config.notion === null ||
    config.vaultRoot.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(config.vaultFingerprint)
  ) {
    throw new WorkerFailure(fixedError("invalid-config"));
  }
}

function validateRoot(config: Readonly<ParsedBridgeConfigV1>, root: CanonicalVaultRoot): void {
  if (
    root.vaultFingerprint !== config.vaultFingerprint ||
    typeof root.canonicalRealPath !== "string" ||
    typeof root.filesystemDeviceId !== "string"
  ) {
    throw new WorkerFailure(fixedError("unsafe-path"));
  }
}

function validateCredential(value: string | null): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 8_192 || /[\r\n\0]/u.test(value)) {
    throw new WorkerFailure(fixedError("credential-unavailable"));
  }
  return value;
}

function outcomeFor(
  counts: Pick<BridgeRunSummary, "planned" | "writes" | "pushed" | "pulled" | "conflicts" | "errors">,
  mode: WorkerRunInput["mode"],
): BridgeRunSummary["outcome"] {
  if (counts.errors > 0) {
    return counts.writes > 0 || counts.pushed > 0 || counts.pulled > 0 || counts.conflicts > 0 ? "partial" : "failed";
  }
  if (counts.conflicts > 0) return "conflict";
  if (mode === "preview") return counts.planned === 0 ? "noop" : "success";
  if (counts.writes === 0) return "noop";
  return "success";
}

function asRemoteRecoveryObserver(
  notion: NotionApi,
  clock: Clock,
  state: Readonly<Pick<ParsedBridgeStateV1, "pairs">>,
): RemoteRecoveryObserver {
  return {
    classify: async (intent) => {
      if (
        intent.effectKind === "create-notion-page" ||
        intent.effectKind === "update-notion-properties" ||
        intent.effectKind === "set-notion-status" ||
        intent.remoteId === null
      ) {
        return Object.freeze({ kind: "unprovable" as const });
      }
      try {
        const observed = await notion.retrievePage(intent.remoteId);
        if (intent.effectKind !== "update-notion-body-exact") return Object.freeze({ kind: "unprovable" as const });
        const persisted = Object.values(state.pairs).find((pair) => pair.notionPageId === intent.remoteId);
        if (
          observed.kind !== "present" ||
          observed.pageId !== intent.remoteId ||
          typeof observed.bridgeId !== "string" ||
          !UUID_PATTERN.test(observed.bridgeId) ||
          (persisted !== undefined && observed.bridgeId !== persisted.bridgeId) ||
          !observed.complete ||
          !Array.isArray(observed.unsupportedKinds) ||
          observed.unsupportedKinds.length !== 0 ||
          !HASH_PATTERN.test(observed.semanticHash)
        ) {
          return Object.freeze({ kind: "unprovable" as const });
        }
        const computedSemanticHash = await semanticHash(observed.semantic);
        if (computedSemanticHash !== observed.semanticHash) {
          return Object.freeze({ kind: "unprovable" as const });
        }
        const completedAt = safeTimestamp(clock);
        const evidence = {
          schemaVersion: 1 as const,
          resultByteHash: null,
          resultSemanticHash: computedSemanticHash,
          resultRemoteId: observed.pageId,
          allocatedBridgeId: null,
          observedRemoteEditedAt: observed.editedAt,
          completedAt,
        };
        if (intent.resultSemanticHash !== null && computedSemanticHash === intent.resultSemanticHash) {
          return Object.freeze({ kind: "post" as const, evidence });
        }
        if (intent.expectedSemanticHash !== null && computedSemanticHash === intent.expectedSemanticHash) {
          return Object.freeze({ kind: "pre" as const, evidence });
        }
        return Object.freeze({ kind: "unprovable" as const });
      } catch {
        return Object.freeze({ kind: "unprovable" as const });
      }
    },
  };
}

async function readCurrentLocal(root: CanonicalVaultRoot, relativePath: string): Promise<string | null> {
  try {
    const scanned = await scanVaultNotes(root);
    const entry = scanned.find((candidate) => candidate.path === relativePath);
    return entry !== undefined && "note" in entry && entry.note !== undefined ? entry.note.bytes : null;
  } catch {
    return null;
  }
}

export class GrandboxBridgeWorker implements BridgeWorker {
  public constructor(private readonly dependencies: WorkerDependencies) {}

  public async run(input: WorkerRunInput): Promise<BridgeRunSummary> {
    const startedAt = safeTimestamp(this.dependencies.clock);
    try {
      await this.loadContext();
    } catch (caught) {
      const error = caught instanceof WorkerFailure ? caught.error : safeErrorFrom(caught, "invalid-config");
      safeLog(this.dependencies.logger, {
        level: "error",
        event: "run-failed",
        fields: { mode: input.mode, reason: input.reason, outcome: "failed", errorCode: error.code, retryable: error.retryable },
      });
      return failedSummary(input, startedAt, this.dependencies.clock);
    }

    try {
      return await this.dependencies.lock.runExclusive(async () => this.runLocked(input, startedAt));
    } catch (caught) {
      const error = safeErrorFrom(caught, "active-lock");
      safeLog(this.dependencies.logger, {
        level: "error",
        event: "run-failed",
        fields: { mode: input.mode, reason: input.reason, outcome: "failed", errorCode: error.code, retryable: error.retryable },
      });
      return failedSummary(input, startedAt, this.dependencies.clock);
    }
  }

  private async loadContext(): Promise<LoadedRunContext> {
    try {
      const config = await this.dependencies.config.load();
      const state = await this.dependencies.state.load();
      validateContext(config, state);
      const root = await this.dependencies.canonicalizeVault(config);
      validateRoot(config, root);
      const token = validateCredential(await this.dependencies.credentials.get("notion-token"));
      return Object.freeze({ config, state, root, token });
    } catch (caught) {
      if (caught instanceof WorkerFailure) throw caught;
      throw new WorkerFailure(safeErrorFrom(caught, "invalid-config"));
    }
  }

  private async runLocked(input: WorkerRunInput, startedAt: string): Promise<BridgeRunSummary> {
    let context: LoadedRunContext;
    try {
      context = await this.loadContext();
      if (input.mode === "preview" && await this.previewHasIncompleteJournal()) {
        return summary(input, startedAt, { planned: 0, writes: 0, pushed: 0, pulled: 0, conflicts: 0, errors: 0 }, "recovery-required", this.dependencies.clock);
      }
      const notion = await this.dependencies.createNotionApi(context.token, {
        config: context.config,
        state: context.state,
        root: context.root,
      });
      if (input.mode === "apply") {
        const recovery = await recoverIncompleteJournal({
          journal: this.dependencies.journal,
          localObserver: { observe: async (intent) => intent.relativePath === null
            ? Object.freeze({ kind: "missing" as const })
            : localRecoveryObservation(context.root, intent.relativePath) },
          remoteObserver: asRemoteRecoveryObserver(notion, this.dependencies.clock, context.state),
          now: () => safeTimestamp(this.dependencies.clock),
        });
        if (recovery.status === "recovery-required") {
          safeLog(this.dependencies.logger, {
            level: "error",
            event: "recovery-required",
            fields: { installationId: context.config.installationId, errorCode: "recovery-required", retryable: false },
          });
          return summary(input, startedAt, { planned: 0, writes: 0, pushed: 0, pulled: 0, conflicts: 0, errors: 0 }, "recovery-required", this.dependencies.clock);
        }
      }

      await notion.verifyConnection();
      const reconciled = await reconcilePairs(context.state, {
        root: context.root,
        notion,
        clock: this.dependencies.clock,
      });
      return this.finishReconciliation(input, startedAt, context, notion, reconciled);
    } catch (caught) {
      const error = caught instanceof WorkerFailure ? caught.error : safeErrorFrom(caught);
      safeLog(this.dependencies.logger, {
        level: "error",
        event: "run-failed",
        fields: { mode: input.mode, reason: input.reason, outcome: "failed", errorCode: error.code, retryable: error.retryable },
      });
      return failedSummary(input, startedAt, this.dependencies.clock);
    }
  }

  private async previewHasIncompleteJournal(): Promise<boolean> {
    try {
      const pending = await this.dependencies.journal.incomplete();
      return !Array.isArray(pending) || pending.length > 0;
    } catch {
      return true;
    }
  }

  private async finishReconciliation(
    input: WorkerRunInput,
    startedAt: string,
    context: LoadedRunContext,
    notion: NotionApi,
    reconciled: ReconciliationResult,
  ): Promise<BridgeRunSummary> {
    const validation = validatePlanningBatch(reconciled.inputs);
    if (!validation.ok) {
      return summary(
        input,
        startedAt,
        { planned: 0, writes: 0, pushed: 0, pulled: 0, conflicts: 0, errors: reconciled.failures.length + 1 },
        "failed",
        this.dependencies.clock,
      );
    }
    const pairs: PlannedPair[] = reconciled.inputs.map((planningInput) => Object.freeze({ input: planningInput, plan: planPair(planningInput) }));
    const planned = pairs.reduce((total, pair) => total + pair.plan.effects.length, 0);
    const planningErrors = pairs.filter((pair) => pair.plan.error !== null).length + reconciled.failures.length;
    if (input.mode === "preview") {
      const counts = { planned, writes: 0, pushed: 0, pulled: 0, conflicts: 0, errors: planningErrors };
      return summary(input, startedAt, counts, outcomeFor(counts, input.mode), this.dependencies.clock);
    }

    const stateFence = planned === 0 ? null : stateCommitIntent(context.config.installationId, this.dependencies.uuid, this.dependencies.clock);
    if (stateFence !== null) {
      await this.dependencies.journal.begin(stateFence);
    }
    const executed = await executePlans(context.state, pairs, {
      installationId: context.config.installationId,
      notionConfig: context.config.notion as NonNullable<ParsedBridgeConfigV1["notion"]>,
      journal: this.dependencies.journal,
      notion,
      writer: this.dependencies.createWriter?.(context.root) ?? new AtomicVaultWriter(context.root),
      uuid: this.dependencies.uuid,
      clock: this.dependencies.clock,
      readLocalBytes: async (relativePath) => readCurrentLocal(context.root, relativePath),
    }, reconciled.failures.length);
    const counts = executed.counts;
    const runSummary = summary(input, startedAt, counts, outcomeFor(counts, input.mode), this.dependencies.clock);
    const nextState: BridgeStateV1 = {
      ...executed.state,
      lastFullReconciliationAt: input.reason === "reconciliation" && counts.errors === 0
        ? runSummary.completedAt
        : executed.state.lastFullReconciliationAt,
      lastRun: runSummary,
    };
    await this.dependencies.state.save(nextState);
    if (stateFence !== null) {
      await this.dependencies.journal.complete(stateFence.id, stateCommitCompletion(this.dependencies.clock));
    }
    safeLog(this.dependencies.logger, {
      level: "info",
      event: "run-completed",
      fields: {
        installationId: context.config.installationId,
        mode: input.mode,
        outcome: runSummary.outcome,
        planned: runSummary.planned,
        writes: runSummary.writes,
        pushed: runSummary.pushed,
        pulled: runSummary.pulled,
        conflicts: runSummary.conflicts,
        errors: runSummary.errors,
        graphUploads: 0,
      },
    });
    return runSummary;
  }
}
