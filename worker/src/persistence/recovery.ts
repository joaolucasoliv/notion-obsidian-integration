import {
  parseJournalCompletion,
  parseJournalIntent,
  type JournalCompletionV1,
  type JournalIntentV1,
} from "@grandbox-bridge/shared";
import type { JournalStore } from "./journal-store.js";

const MAX_RECOVERY_OPERATIONS = 1_024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface RemoteRecoveryObserver {
  classify(intent: JournalIntentV1): Promise<
    | { readonly kind: "pre"; readonly evidence: JournalCompletionV1 }
    | { readonly kind: "post"; readonly evidence: JournalCompletionV1 }
    | { readonly kind: "unprovable" }
  >;
}

export interface LocalRecoveryObserver {
  observe(intent: JournalIntentV1): Promise<
    | { readonly kind: "missing" }
    | {
      readonly kind: "present";
      readonly byteHash: string;
      readonly semanticHash: string | null;
      readonly bridgeId?: string | null;
    }
  >;
}

/**
 * Cortex effects carry a richer, cross-provider postcondition than the legacy
 * pair journal.  Keep their recovery proof isolated so a legacy observer can
 * never accidentally classify a Cortex mutation as complete.
 */
export interface CortexRecoveryObserver {
  classify(intent: JournalIntentV1): Promise<
    | { readonly kind: "pre"; readonly evidence: JournalCompletionV1 }
    | { readonly kind: "post"; readonly evidence: JournalCompletionV1 }
    | { readonly kind: "attention" }
  >;
  markAttention(intent: JournalIntentV1): Promise<void>;
}

export type RecoveryStatus = "clean" | "reconciled" | "retryable" | "recovery-required";

export interface RecoveryResult {
  readonly status: RecoveryStatus;
  readonly processed: number;
  readonly reconciled: number;
  readonly retryable: number;
  readonly blockedId: string | null;
  readonly blockedPath: string | null;
  readonly blockedExpectedByteHash: string | null;
  readonly blockedResultByteHash: string | null;
}

export interface RecoveryDependencies {
  readonly journal: JournalStore;
  readonly localObserver: LocalRecoveryObserver;
  readonly remoteObserver: RemoteRecoveryObserver;
  /** Optional until the Cortex executor wires its recovery observer. */
  readonly cortexObserver?: CortexRecoveryObserver;
  readonly now?: () => string;
}

type ResolvedKind = "reconciled" | "retryable";

const CORTEX_EFFECT_KINDS = new Set<JournalIntentV1["effectKind"]>([
  "create-cortex-page",
  "update-cortex-body",
  "update-cortex-title",
  "move-cortex-page",
  "create-cortex-local",
  "write-cortex-local",
  "move-cortex-subtree",
  "create-cortex-conflict",
  "advance-cortex-state",
]);

function safeResult(
  status: RecoveryStatus,
  processed: number,
  reconciled: number,
  retryable: number,
  blocked: JournalIntentV1 | null = null,
): RecoveryResult {
  return Object.freeze({
    status,
    processed,
    reconciled,
    retryable,
    blockedId: blocked?.id ?? null,
    blockedPath: blocked?.relativePath ?? null,
    blockedExpectedByteHash: blocked?.expectedByteHash ?? null,
    blockedResultByteHash: blocked?.resultByteHash ?? null,
  });
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validHashOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && HASH_PATTERN.test(value));
}

function parseLocalObservation(input: unknown):
  | { readonly kind: "missing" }
  | {
    readonly kind: "present";
    readonly byteHash: string;
    readonly semanticHash: string | null;
    readonly bridgeId: string | null;
  } {
  if (isExactObject(input, ["kind"]) && input.kind === "missing") {
    return Object.freeze({ kind: "missing" });
  }
  if (
    (isExactObject(input, ["kind", "byteHash", "semanticHash"]) ||
      isExactObject(input, ["kind", "byteHash", "semanticHash", "bridgeId"])) &&
    input.kind === "present" &&
    typeof input.byteHash === "string" &&
    HASH_PATTERN.test(input.byteHash) &&
    validHashOrNull(input.semanticHash) &&
    (input.bridgeId === undefined || input.bridgeId === null || (typeof input.bridgeId === "string" && UUID_PATTERN.test(input.bridgeId)))
  ) {
    return Object.freeze({
      kind: "present",
      byteHash: input.byteHash,
      semanticHash: input.semanticHash,
      bridgeId: input.bridgeId ?? null,
    });
  }
  throw new Error("Invalid local recovery observation");
}

function observedLocalCompletion(
  byteHash: string | null,
  semanticHash: string | null,
  completedAt: string,
  allocatedBridgeId: string | null = null,
): JournalCompletionV1 {
  return parseJournalCompletion({
    schemaVersion: 1,
    resultByteHash: byteHash,
    resultSemanticHash: semanticHash,
    resultRemoteId: null,
    allocatedBridgeId,
    observedRemoteEditedAt: null,
    completedAt,
  });
}

function parseRemoteClassification(
  input: unknown,
): { readonly kind: "pre" | "post"; readonly evidence: JournalCompletionV1 } | { readonly kind: "unprovable" } {
  if (isExactObject(input, ["kind"]) && input.kind === "unprovable") {
    return Object.freeze({ kind: "unprovable" });
  }
  if (
    isExactObject(input, ["kind", "evidence"]) &&
    (input.kind === "pre" || input.kind === "post")
  ) {
    return Object.freeze({ kind: input.kind, evidence: parseJournalCompletion(input.evidence) });
  }
  throw new Error("Invalid remote recovery observation");
}

function parseCortexClassification(
  input: unknown,
): { readonly kind: "pre" | "post"; readonly evidence: JournalCompletionV1 } | { readonly kind: "attention" } {
  if (isExactObject(input, ["kind"]) && input.kind === "attention") {
    return Object.freeze({ kind: "attention" });
  }
  if (
    isExactObject(input, ["kind", "evidence"]) &&
    (input.kind === "pre" || input.kind === "post")
  ) {
    return Object.freeze({ kind: input.kind, evidence: parseJournalCompletion(input.evidence) });
  }
  throw new Error("Invalid Cortex recovery observation");
}

export function isCortexJournalIntent(intent: JournalIntentV1): boolean {
  return CORTEX_EFFECT_KINDS.has(intent.effectKind) && intent.cortex !== undefined && intent.cortex !== null;
}

function isStateFence(intent: JournalIntentV1): boolean {
  return intent.effectKind === "commit-state" || intent.effectKind === "advance-cortex-state";
}

async function classifyLocal(
  intent: JournalIntentV1,
  observer: LocalRecoveryObserver,
  completedAt: string,
): Promise<{ readonly kind: ResolvedKind; readonly evidence: JournalCompletionV1 } | null> {
  if (
    intent.relativePath === null ||
    intent.resultByteHash === null ||
    ((intent.effectKind === "initialize-pair" || intent.effectKind === "write-local") && intent.expectedByteHash === null) ||
    (intent.effectKind === "create-conflict" &&
      (intent.expectedByteHash !== null || intent.expectedSemanticHash !== null))
  ) {
    return null;
  }
  const observation = parseLocalObservation(await observer.observe(intent));
  if (observation.kind === "present" && observation.byteHash === intent.resultByteHash) {
    const allocatedBridgeId = intent.effectKind === "initialize-pair" ? observation.bridgeId : null;
    if (intent.effectKind === "initialize-pair" && allocatedBridgeId === null) {
      return null;
    }
    return Object.freeze({
      kind: "reconciled",
      evidence: observedLocalCompletion(observation.byteHash, observation.semanticHash, completedAt, allocatedBridgeId),
    });
  }
  if (
    ((intent.effectKind === "write-local" || intent.effectKind === "initialize-pair") &&
      observation.kind === "present" &&
      observation.byteHash === intent.expectedByteHash) ||
    (intent.effectKind === "create-conflict" && observation.kind === "missing")
  ) {
    return Object.freeze({
      kind: "retryable",
      evidence: observedLocalCompletion(
        observation.kind === "present" ? observation.byteHash : null,
        observation.kind === "present" ? observation.semanticHash : null,
        completedAt,
      ),
    });
  }
  return null;
}

function completionTime(now: (() => string) | undefined): string {
  const value = now === undefined ? new Date().toISOString() : now();
  if (typeof value !== "string") {
    throw new Error("Invalid recovery clock");
  }
  return value;
}

export async function recoverIncompleteJournal(dependencies: RecoveryDependencies): Promise<RecoveryResult> {
  let pending: readonly JournalIntentV1[];
  try {
    pending = await dependencies.journal.incomplete();
    if (!Array.isArray(pending) || pending.length > MAX_RECOVERY_OPERATIONS) {
      return safeResult("recovery-required", 0, 0, 0);
    }
  } catch {
    return safeResult("recovery-required", 0, 0, 0);
  }

  const intents: JournalIntentV1[] = [];
  const seenIds = new Set<string>();
  try {
    for (const pendingIntent of pending) {
      const parsed = parseJournalIntent(pendingIntent);
      if (seenIds.has(parsed.id)) {
        return safeResult("recovery-required", 0, 0, 0, parsed);
      }
      seenIds.add(parsed.id);
      intents.push(parsed);
    }
  } catch {
    return safeResult("recovery-required", 0, 0, 0);
  }
  intents.sort((left, right) => {
    if (isStateFence(left) && !isStateFence(right)) return 1;
    if (!isStateFence(left) && isStateFence(right)) return -1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  let processed = 0;
  let reconciled = 0;
  let retryable = 0;
  for (const intent of intents) {
    try {
      if (intent.effectKind === "commit-state") {
        return safeResult("recovery-required", processed, reconciled, retryable, intent);
      }
      let resolved: { readonly kind: ResolvedKind; readonly evidence: JournalCompletionV1 } | null;
      if (isCortexJournalIntent(intent)) {
        if (dependencies.cortexObserver === undefined) {
          return safeResult("recovery-required", processed, reconciled, retryable, intent);
        }
        const classification = parseCortexClassification(await dependencies.cortexObserver.classify(intent));
        if (classification.kind === "attention") {
          await dependencies.cortexObserver.markAttention(intent);
          return safeResult("recovery-required", processed, reconciled, retryable, intent);
        }
        resolved = Object.freeze({
          kind: classification.kind === "post" ? "reconciled" : "retryable",
          evidence: classification.evidence,
        });
      } else if (
        intent.effectKind === "initialize-pair" ||
        intent.effectKind === "write-local" ||
        intent.effectKind === "create-conflict"
      ) {
        resolved = await classifyLocal(intent, dependencies.localObserver, completionTime(dependencies.now));
      } else {
        const classification = parseRemoteClassification(await dependencies.remoteObserver.classify(intent));
        if (classification.kind === "unprovable") {
          return safeResult("recovery-required", processed, reconciled, retryable, intent);
        }
        resolved = Object.freeze({
          kind: classification.kind === "post" ? "reconciled" : "retryable",
          evidence: classification.evidence,
        });
      }
      if (resolved === null) {
        return safeResult("recovery-required", processed, reconciled, retryable, intent);
      }
      await dependencies.journal.complete(intent.id, resolved.evidence);
      processed += 1;
      if (resolved.kind === "reconciled") {
        reconciled += 1;
      } else {
        retryable += 1;
      }
    } catch {
      return safeResult("recovery-required", processed, reconciled, retryable, intent);
    }
  }

  if (processed === 0) {
    return safeResult("clean", 0, 0, 0);
  }
  return safeResult(retryable > 0 ? "retryable" : "reconciled", processed, reconciled, retryable);
}
