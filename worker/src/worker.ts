import {
  fromBase64url,
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
  type GraphPublishStateV1,
  type ParsedBridgeConfigV1,
  type ParsedBridgeStateV1,
  type JournalCompletionV1,
  type JournalIntentV1,
} from "@grandbox-bridge/shared";
import { buildGraphProjection, type GraphSourceNote } from "./graph/projection.js";
import { GraphPublisher, type GraphNonceSource } from "./graph/publisher.js";
import { RelayClient, RelayClientError, recoverPendingRelayTokenRotation } from "./relay/client.js";
import { RelayEventSource, type RelayEvent } from "./relay/event-source.js";
import { RelaySnapshotSink } from "./relay/snapshot-sink.js";
import type { ConfigStore } from "./persistence/config-store.js";
import type { JournalStore } from "./persistence/journal-store.js";
import { recoverIncompleteJournal, type RemoteRecoveryObserver } from "./persistence/recovery.js";
import type { StateStore } from "./persistence/state-store.js";
import { safeErrorFrom, localRecoveryObservation, reconcilePairs, type ReconciliationResult } from "./sync/reconcile.js";
import { executePlans, type PlannedPair } from "./sync/executor.js";
import { planPair, validatePlanningBatch } from "./sync/planner.js";
import { observeSafeVaultNoteBytes, scanVaultNotesWithStatus } from "./vault/scanner.js";
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
  readonly createRelayClient?: (input: Readonly<{ baseUrl: string; token: string; clock: Clock }>) => RelayClient;
  readonly nonceSource?: GraphNonceSource;
}

interface LoadedRunContext {
  readonly config: Readonly<ParsedBridgeConfigV1>;
  readonly state: Readonly<ParsedBridgeStateV1>;
  readonly root: CanonicalVaultRoot;
  readonly token: string;
  readonly relay: LoadedRelayContext | null;
}

interface LoadedRelayContext {
  readonly relayToken: string;
  readonly graphKey: Uint8Array;
}

interface RelayRunContext {
  readonly client: RelayClient;
  readonly source: RelayEventSource;
  readonly graphKey: Uint8Array;
}

interface ValidatedClaimedEvents {
  readonly prioritizedPageIds: ReadonlySet<string>;
  /** Only registered relay pages require a matching reconciled pair before acknowledgement. */
  readonly matchedPageIds: ReadonlyMap<string, string>;
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

function safeRelayError(caught: unknown): SafeError | null {
  if (!(caught instanceof RelayClientError)) return null;
  const codes: Readonly<Record<RelayClientError["code"], SafeErrorCode>> = {
    authentication: "authentication-failed",
    authorization: "authorization-failed",
    "state-conflict": "revision-race",
    "rate-limited": "rate-limited",
    network: "network-failed",
    timeout: "timeout",
    "request-too-large": "request-too-large",
    "response-too-large": "response-too-large",
    "invalid-response": "invalid-response",
  };
  return fixedError(codes[caught.code], caught.retryable);
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

function sameDurableState(left: Readonly<BridgeStateV1>, right: Readonly<BridgeStateV1>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summary(
  input: WorkerRunInput,
  startedAt: string,
  counts: Pick<BridgeRunSummary, "planned" | "writes" | "pushed" | "pulled" | "conflicts" | "errors">,
  outcome: BridgeRunSummary["outcome"],
  clock: Clock,
  graphUploads = 0,
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
    graphUploads,
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
  if ((config.relay === null) !== (config.graph === null)) {
    throw new WorkerFailure(fixedError("invalid-config"));
  }
  if (
    (config.graph === null && state.graph !== null) ||
    (config.graph !== null && state.graph !== null && (
      state.graph.graphId !== config.graph.graphId ||
      state.graph.keyId !== config.graph.keyId
    ))
  ) {
    throw new WorkerFailure(fixedError("invalid-state"));
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

const GRAPH_KEY_BYTES = 32;
const FULL_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const PARTIAL_RECONCILIATION_PAIR_LIMIT = 3;
const PARTIAL_RECONCILIATION_CANDIDATE_LIMIT = 3;
const PARTIAL_RECONCILIATION_TRAVERSAL_LIMIT = 128;

function validateRelayToken(value: string | null): string {
  const token = validateCredential(value);
  try {
    if (token.length !== 43 || fromBase64url(token).byteLength !== GRAPH_KEY_BYTES) throw new Error("Invalid relay token");
    return token;
  } catch {
    throw new WorkerFailure(fixedError("credential-unavailable"));
  }
}

function validateGraphKey(value: string | null): Uint8Array {
  const encoded = validateCredential(value);
  try {
    const key = fromBase64url(encoded);
    if (key.byteLength !== GRAPH_KEY_BYTES) throw new Error("Invalid graph key");
    return key;
  } catch {
    throw new WorkerFailure(fixedError("credential-unavailable"));
  }
}

function initialGraphState(graph: NonNullable<ParsedBridgeConfigV1["graph"]>): GraphPublishStateV1 {
  return Object.freeze({
    projectionHash: null,
    graphId: graph.graphId,
    keyId: graph.keyId,
    sequence: 0,
    lastPublishedAt: null,
  });
}

function fullReconciliationDue(lastFullReconciliationAt: string | null, clock: Clock): boolean {
  if (lastFullReconciliationAt === null) return true;
  try {
    const previous = new Date(lastFullReconciliationAt).getTime();
    const now = clock.now().getTime();
    return Number.isFinite(previous) && Number.isFinite(now) && now - previous >= FULL_RECONCILIATION_INTERVAL_MS;
  } catch {
    return true;
  }
}

function relayRegistryIntent(
  installationId: string,
  effectKind: "register-relay-page" | "unregister-relay-page",
  pageId: string,
  uuid: UuidSource,
  clock: Clock,
): JournalIntentV1 {
  return parseJournalIntent({
    schemaVersion: 1,
    id: nextJournalId(uuid),
    installationId,
    effectKind,
    relativePath: null,
    remoteId: pageId,
    allocationId: null,
    expectedByteHash: null,
    expectedSemanticHash: null,
    resultByteHash: null,
    resultSemanticHash: null,
    expectedRemoteEditedAt: null,
    createdAt: safeTimestamp(clock),
  });
}

function relayRegistryCompletion(clock: Clock, pageId: string, bridgeId: string): JournalCompletionV1 {
  return parseJournalCompletion({
    schemaVersion: 1,
    resultByteHash: null,
    resultSemanticHash: null,
    resultRemoteId: pageId,
    allocatedBridgeId: bridgeId,
    observedRemoteEditedAt: null,
    completedAt: safeTimestamp(clock),
  });
}

function isSynchronizedPair(pair: Readonly<ParsedBridgeStateV1["pairs"][string]>): boolean {
  return pair.status === "synced";
}

function isRetainedRelayPair(pair: Readonly<ParsedBridgeStateV1["pairs"][string]>): boolean {
  return pair.status !== "detached";
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
        const claims = Object.entries(state.pairs).filter(([, pair]) => pair.notionPageId === intent.remoteId);
        const claim = claims[0];
        if (claims.length !== 1 || claim === undefined) {
          return Object.freeze({ kind: "unprovable" as const });
        }
        const [persistedKey, persisted] = claim;
        if (
          persistedKey !== persisted.bridgeId ||
          persisted.notionPageId !== intent.remoteId ||
          !UUID_PATTERN.test(persisted.bridgeId) ||
          observed.kind !== "present" ||
          observed.pageId !== intent.remoteId ||
          typeof observed.bridgeId !== "string" ||
          !UUID_PATTERN.test(observed.bridgeId) ||
          observed.bridgeId !== persisted.bridgeId ||
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
    const observed = await observeSafeVaultNoteBytes(root, relativePath);
    return observed.kind === "present" ? observed.bytes : null;
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
      const error = caught instanceof WorkerFailure ? caught.error : safeRelayError(caught) ?? safeErrorFrom(caught, "invalid-config");
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
      const relay = config.relay === null || config.graph === null
        ? null
        : Object.freeze({
            relayToken: validateRelayToken(await this.dependencies.credentials.get("relay-token")),
            graphKey: validateGraphKey(await this.dependencies.credentials.get("graph-key")),
          });
      return Object.freeze({ config, state, root, token, relay });
    } catch (caught) {
      if (caught instanceof WorkerFailure) throw caught;
      throw new WorkerFailure(safeErrorFrom(caught, "invalid-config"));
    }
  }

  private createRelayClient(config: Readonly<ParsedBridgeConfigV1>, token: string): RelayClient {
    if (config.relay === null) throw new WorkerFailure(fixedError("invalid-config"));
    return this.dependencies.createRelayClient?.({
      baseUrl: config.relay.baseUrl,
      token,
      clock: this.dependencies.clock,
    }) ?? new RelayClient({ baseUrl: config.relay.baseUrl, token, clock: this.dependencies.clock });
  }

  private async validateClaimedEvents(
    notion: NotionApi,
    state: Readonly<ParsedBridgeStateV1>,
    events: readonly RelayEvent[],
  ): Promise<ValidatedClaimedEvents> {
    const registeredPages = new Set(
      Object.values(state.pairs)
        .filter(isRetainedRelayPair)
        .map((pair) => pair.notionPageId),
    );
    const prioritizedPages = new Set<string>();
    const matchedPageIds = new Map<string, string>();
    for (const event of events) {
      if (registeredPages.has(event.entityId)) {
        prioritizedPages.add(event.entityId);
        matchedPageIds.set(event.id, event.entityId);
        continue;
      }
      const pageId = await notion.resolveEventPage(event.entityId, 16);
      // Unknown pages are deliberately acknowledged only after the complete
      // reconciliation succeeds; they never authorize a local mutation.
      if (pageId !== null && registeredPages.has(pageId)) {
        prioritizedPages.add(pageId);
        matchedPageIds.set(event.id, pageId);
      }
    }
    return Object.freeze({ prioritizedPageIds: prioritizedPages, matchedPageIds });
  }

  private async graphProjection(
    root: CanonicalVaultRoot,
    config: Readonly<ParsedBridgeConfigV1>,
    state: Readonly<BridgeStateV1>,
    maximumCandidates: number | undefined,
    maximumTraversalEntries: number | undefined,
  ) {
    if (config.graph === null) throw new WorkerFailure(fixedError("invalid-config"));
    const scanned = await scanVaultNotesWithStatus(
      root,
      maximumCandidates === undefined
        ? undefined
        : {
            maximumCandidates,
            ...(maximumTraversalEntries === undefined ? {} : { maximumTraversalEntries }),
          },
    );
    // A partial run never publishes a truncated graph. It defers graph work to
    // the next full reconciliation when the bounded discovery probe overflows.
    if (!scanned.complete) return null;
    const notes: GraphSourceNote[] = scanned.entries.flatMap((entry) => entry.note === undefined
      ? []
      : [{
          path: entry.note.path,
          basename: entry.note.path.split("/").at(-1)?.replace(/\.md$/iu, "") ?? entry.note.path,
          markdown: entry.note.body,
          tags: [...entry.note.tags],
        }]);
    const pairs = new Map(
      Object.values(state.pairs)
        .filter(isSynchronizedPair)
        .map((pair) => [pair.localPath, { notionUrl: `https://www.notion.so/${pair.notionPageId.replaceAll("-", "")}` }] as const),
    );
    return buildGraphProjection(notes, pairs, config.installationId, config.graph.domains);
  }

  private async synchronizeRelayRegistry(
    context: LoadedRunContext,
    relay: RelayRunContext | null,
    nextState: Readonly<BridgeStateV1>,
  ): Promise<void> {
    if (relay === null) return;
    const before = new Map(
      Object.values(context.state.pairs)
        .filter(isRetainedRelayPair)
        .map((pair) => [pair.bridgeId, pair] as const),
    );
    const after = new Map(
      Object.values(nextState.pairs)
        .filter(isSynchronizedPair)
        .map((pair) => [pair.bridgeId, pair] as const),
    );

    for (const [bridgeId, pair] of after) {
      const previous = before.get(bridgeId);
      if (previous !== undefined && previous.notionPageId === pair.notionPageId) continue;
      const intent = relayRegistryIntent(
        context.config.installationId,
        "register-relay-page",
        pair.notionPageId,
        this.dependencies.uuid,
        this.dependencies.clock,
      );
      await this.dependencies.journal.begin(intent);
      await relay.source.register(pair.notionPageId, bridgeId);
      await this.dependencies.journal.complete(intent.id, relayRegistryCompletion(this.dependencies.clock, pair.notionPageId, bridgeId));
    }

    for (const [bridgeId, pair] of before) {
      const current = nextState.pairs[bridgeId];
      if (current === undefined || current.status !== "detached") continue;
      const intent = relayRegistryIntent(
        context.config.installationId,
        "unregister-relay-page",
        pair.notionPageId,
        this.dependencies.uuid,
        this.dependencies.clock,
      );
      await this.dependencies.journal.begin(intent);
      await relay.source.unregister(pair.notionPageId, bridgeId);
      await this.dependencies.journal.complete(intent.id, relayRegistryCompletion(this.dependencies.clock, pair.notionPageId, bridgeId));
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
      await notion.verifyConnection();

      let relay: RelayRunContext | null = null;
      let claimedEvents: readonly RelayEvent[] = [];
      let prioritizedEventPages: ReadonlySet<string> = new Set();
      let matchedEventPages: ReadonlyMap<string, string> = new Map();
      const fullReconciliation = fullReconciliationDue(context.state.lastFullReconciliationAt, this.dependencies.clock);
      if (input.mode === "apply" && context.relay !== null) {
        const rotationRecovery = await recoverPendingRelayTokenRotation({
          credentials: this.dependencies.credentials,
          clients: { create: (token) => this.createRelayClient(context.config, token) },
        });
        if (rotationRecovery === "recovery-required") {
          safeLog(this.dependencies.logger, {
            level: "error",
            event: "recovery-required",
            fields: { installationId: context.config.installationId, errorCode: "recovery-required", retryable: false },
          });
          return summary(input, startedAt, { planned: 0, writes: 0, pushed: 0, pulled: 0, conflicts: 0, errors: 0 }, "recovery-required", this.dependencies.clock);
        }
        const relayToken = rotationRecovery === "clean" || rotationRecovery === "cancelled"
          ? context.relay.relayToken
          : validateRelayToken(await this.dependencies.credentials.get("relay-token"));
        const client = this.createRelayClient(context.config, relayToken);
        const source = new RelayEventSource(client);
        const claim = await source.claim(context.config.installationId, 50);
        claimedEvents = claim.events;
        const validatedEvents = await this.validateClaimedEvents(notion, context.state, claimedEvents);
        prioritizedEventPages = validatedEvents.prioritizedPageIds;
        matchedEventPages = validatedEvents.matchedPageIds;
        relay = Object.freeze({ client, source, graphKey: context.relay.graphKey });
      }

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

      const reconciliationScope = fullReconciliation
        ? {}
        : {
            maximumPairs: PARTIAL_RECONCILIATION_PAIR_LIMIT,
            maximumCandidates: PARTIAL_RECONCILIATION_CANDIDATE_LIMIT,
            maximumTraversalEntries: PARTIAL_RECONCILIATION_TRAVERSAL_LIMIT,
          };
      const reconciled = await reconcilePairs(context.state, {
        root: context.root,
        notion,
        clock: this.dependencies.clock,
        priorityPageIds: prioritizedEventPages,
        ...reconciliationScope,
      });
      return this.finishReconciliation(
        input,
        startedAt,
        context,
        notion,
        reconciled,
        relay,
        claimedEvents,
        matchedEventPages,
        fullReconciliation,
      );
    } catch (caught) {
      const error = caught instanceof WorkerFailure ? caught.error : safeRelayError(caught) ?? safeErrorFrom(caught);
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
    relay: RelayRunContext | null,
    claimedEvents: readonly RelayEvent[],
    matchedEventPages: ReadonlyMap<string, string>,
    fullReconciliation: boolean,
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

    const requiresPreExecutionStateFence =
      planned > 0 || pairs.some((pair) => pair.plan.stateAdvance.kind !== "none");
    let stateFence = requiresPreExecutionStateFence
      ? stateCommitIntent(context.config.installationId, this.dependencies.uuid, this.dependencies.clock)
      : null;
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
    const counts = {
      planned: executed.counts.planned,
      writes: executed.counts.writes,
      pushed: executed.counts.pushed,
      pulled: executed.counts.pulled,
      conflicts: executed.counts.conflicts,
      errors: executed.counts.errors,
    };
    let stateAfterGraph: BridgeStateV1 = executed.state;
    let graphUploads = 0;
    if (relay !== null) {
      try {
        if (context.config.graph === null) throw new WorkerFailure(fixedError("invalid-config"));
        const projection = await this.graphProjection(
          context.root,
          context.config,
          executed.state,
          fullReconciliation ? undefined : PARTIAL_RECONCILIATION_CANDIDATE_LIMIT,
          fullReconciliation ? undefined : PARTIAL_RECONCILIATION_TRAVERSAL_LIMIT,
        );
        if (projection !== null) {
          const sink = new RelaySnapshotSink(relay.client);
          const publisher = this.dependencies.nonceSource === undefined
            ? new GraphPublisher({ sink })
            : new GraphPublisher({ sink, nonceSource: this.dependencies.nonceSource });
          const published = await publisher.publishIfChanged({
            projection,
            state: executed.state.graph ?? initialGraphState(context.config.graph),
            key: relay.graphKey,
            now: safeTimestamp(this.dependencies.clock),
          });
          stateAfterGraph = { ...executed.state, graph: published.state };
          graphUploads = published.uploaded ? 1 : 0;
        }
      } catch {
        // The graph state is intentionally retained. A later run recomputes
        // the same projection and encrypts it with a fresh nonce.
        counts.errors += 1;
      }
    }

    await this.synchronizeRelayRegistry(context, relay, stateAfterGraph);
    const runSummary = summary(
      input,
      startedAt,
      counts,
      outcomeFor(counts, input.mode),
      this.dependencies.clock,
      graphUploads,
    );
    const stateWithoutRun: BridgeStateV1 = {
      ...stateAfterGraph,
      lastFullReconciliationAt: input.mode === "apply" && fullReconciliation && counts.errors === 0
        ? runSummary.completedAt
        : stateAfterGraph.lastFullReconciliationAt,
    };
    const trueSemanticNoop =
      counts.planned === 0 &&
      counts.writes === 0 &&
      counts.pushed === 0 &&
      counts.pulled === 0 &&
      counts.conflicts === 0 &&
      counts.errors === 0 &&
      sameDurableState(context.state, stateWithoutRun);
    const nextState: BridgeStateV1 = trueSemanticNoop
      ? stateWithoutRun
      : { ...stateWithoutRun, lastRun: runSummary };
    if (!sameDurableState(context.state, nextState)) {
      if (stateFence === null) {
        stateFence = stateCommitIntent(context.config.installationId, this.dependencies.uuid, this.dependencies.clock);
        await this.dependencies.journal.begin(stateFence);
      }
      await this.dependencies.state.save(nextState);
    }
    if (stateFence !== null) {
      await this.dependencies.journal.complete(stateFence.id, stateCommitCompletion(this.dependencies.clock));
    }
    if (relay !== null && claimedEvents.length > 0 && counts.errors === 0) {
      const reconciledPages = new Set(
        reconciled.inputs.flatMap((planningInput) => planningInput.prior === null ? [] : [planningInput.prior.notionPageId]),
      );
      const acknowledged = claimedEvents.filter((event) => {
        const matchedPageId = matchedEventPages.get(event.id);
        return matchedPageId === undefined || reconciledPages.has(matchedPageId);
      });
      if (acknowledged.length > 0) {
        await relay.source.acknowledge(context.config.installationId, acknowledged.map((event) => event.id));
      }
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
        graphUploads: runSummary.graphUploads,
      },
    });
    return runSummary;
  }
}
