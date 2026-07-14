import {
  sha256Hex,
  type ManagedPropertiesSnapshot,
  type PairIdentityRef,
  type PairPlan,
  type PairPlanningInput,
  type PairStateAdvance,
  type PairStateV1,
  type PairStatus,
  type PlannedEffect,
  type PlanningBatchValidation,
  type RemoteRevisionRef,
  type SafeError,
} from "@grandbox-bridge/shared";
import {
  ConflictArtifactError,
  conflictArtifactPath,
  renderConflictArtifact,
} from "./conflicts.js";

const MAX_RELATIVE_PATH_BYTES = 1_024;
const MAX_TITLE_BYTES = 1_024;
const MAX_URL_BYTES = 2_048;
const MAX_MARKDOWN_BYTES = 1_048_576;
const MAX_TAG_COUNT = 128;
const MAX_TAG_BYTES = 256;
const MAX_UNSUPPORTED_KIND_BYTES = 128;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PAIR_STATUSES = new Set<PairStatus>([
  "synced",
  "conflict",
  "detached",
  "missing-local",
  "missing-notion",
  "error",
]);

const INVALID_INPUT_ERROR: Readonly<SafeError> = Object.freeze({
  code: "invalid-response",
  retryable: false,
});
const IDENTITY_ERROR: Readonly<SafeError> = Object.freeze({
  code: "identity-collision",
  retryable: false,
});
const UNSUPPORTED_ERROR: Readonly<SafeError> = Object.freeze({
  code: "unsupported-content",
  retryable: false,
});
const CONVERSION_ERROR: Readonly<SafeError> = Object.freeze({
  code: "conversion-failed",
  retryable: false,
});

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
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

function isStrictTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (match === null || !isStrictCalendarDay(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[5] === "Z") return true;
  const offset = /([+-])(\d{2}):(\d{2})$/u.exec(match[5] as string);
  return offset !== null && Number(offset[2]) <= 23 && Number(offset[3]) <= 59;
}

function isPairStatus(value: unknown): value is PairStatus {
  return typeof value === "string" && PAIR_STATUSES.has(value as PairStatus);
}

function isTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    byteLength(value) <= MAX_TITLE_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
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

function isCanonicalTags(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_TAG_COUNT) return false;
  let previous: string | null = null;
  for (const tag of value) {
    if (
      typeof tag !== "string" ||
      tag.length === 0 ||
      tag.trim() !== tag ||
      byteLength(tag) > MAX_TAG_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(tag) ||
      (previous !== null && compareCodePoints(previous, tag) >= 0)
    ) {
      return false;
    }
    previous = tag;
  }
  return true;
}

function isSemantic(value: unknown): value is { readonly bodyMarkdown: string; readonly tags: readonly string[] } {
  return (
    hasExactKeys(value, ["bodyMarkdown", "tags"]) &&
    typeof value.bodyMarkdown === "string" &&
    byteLength(value.bodyMarkdown) <= MAX_MARKDOWN_BYTES &&
    isCanonicalTags(value.tags)
  );
}

function isUnsupportedKinds(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_TAG_COUNT) return false;
  const seen = new Set<string>();
  for (const kind of value) {
    if (
      typeof kind !== "string" ||
      kind.length === 0 ||
      byteLength(kind) > MAX_UNSUPPORTED_KIND_BYTES ||
      !/^[a-z0-9-]+$/u.test(kind) ||
      seen.has(kind)
    ) {
      return false;
    }
    seen.add(kind);
  }
  return true;
}

function canonicalPageId(value: string): string | null {
  const compact = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(compact)) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function pageIdFromValidatedUrl(value: unknown): string | null {
  if (typeof value !== "string" || byteLength(value) > MAX_URL_BYTES || /[\u0000-\u0020\u007f\\]/u.test(value)) {
    return null;
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
      return null;
    }
    const match = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(parsed.pathname);
    return match === null ? null : canonicalPageId(match[1] as string);
  } catch {
    return null;
  }
}

function isLocalObservation(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "missing") {
    return hasExactKeys(value, ["kind", "path"]) && isSafeRelativePath(value.path);
  }
  if (value.kind === "malformed") {
    return (
      hasExactKeys(value, ["kind", "path", "reason"]) &&
      isSafeRelativePath(value.path) &&
      (value.reason === "invalid-frontmatter" || value.reason === "conversion-failed")
    );
  }
  return (
    value.kind === "present" &&
    hasExactKeys(value, ["kind", "path", "title", "bridgeId", "byteHash", "eligible", "semantic", "semanticHash"]) &&
    isSafeRelativePath(value.path) &&
    isTitle(value.title) &&
    (value.bridgeId === null || isCanonicalUuid(value.bridgeId)) &&
    isHash(value.byteHash) &&
    typeof value.eligible === "boolean" &&
    isSemantic(value.semantic) &&
    isHash(value.semanticHash)
  );
}

function isNotionObservation(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "missing") {
    return hasExactKeys(value, ["kind", "pageId"]) && (value.pageId === null || isCanonicalUuid(value.pageId));
  }
  if (
    value.kind !== "present" ||
    !hasExactKeys(value, [
      "kind",
      "pageId",
      "bridgeId",
      "editedAt",
      "pageUrl",
      "sourceMarkdown",
      "complete",
      "unsupportedKinds",
      "semantic",
      "semanticHash",
      "managed",
    ]) ||
    !isCanonicalUuid(value.pageId) ||
    (value.bridgeId !== null && !isCanonicalUuid(value.bridgeId)) ||
    !isStrictTimestamp(value.editedAt) ||
    pageIdFromValidatedUrl(value.pageUrl) === null ||
    typeof value.sourceMarkdown !== "string" ||
    byteLength(value.sourceMarkdown) > MAX_MARKDOWN_BYTES ||
    typeof value.complete !== "boolean" ||
    !isUnsupportedKinds(value.unsupportedKinds) ||
    !isSemantic(value.semantic) ||
    !isHash(value.semanticHash) ||
    !hasExactKeys(value.managed, ["title", "obsidianPath", "status"]) ||
    !isTitle(value.managed.title) ||
    !isSafeRelativePath(value.managed.obsidianPath) ||
    !isPairStatus(value.managed.status)
  ) {
    return false;
  }
  return true;
}

function isPairState(value: unknown): value is Readonly<PairStateV1> {
  return (
    hasExactKeys(value, [
      "bridgeId",
      "localPath",
      "notionPageId",
      "status",
      "lastLocalSemanticHash",
      "lastNotionSemanticHash",
      "lastCommonSemanticHash",
      "lastCommonLocalByteHash",
      "lastNotionEditedAt",
      "lastSyncedAt",
    ]) &&
    isCanonicalUuid(value.bridgeId) &&
    isSafeRelativePath(value.localPath) &&
    isCanonicalUuid(value.notionPageId) &&
    isPairStatus(value.status) &&
    isHash(value.lastLocalSemanticHash) &&
    isHash(value.lastNotionSemanticHash) &&
    isHash(value.lastCommonSemanticHash) &&
    isHash(value.lastCommonLocalByteHash) &&
    isStrictTimestamp(value.lastNotionEditedAt) &&
    isStrictTimestamp(value.lastSyncedAt)
  );
}

function isPreparation(value: unknown): boolean {
  if (!hasExactKeys(value, ["allocationId", "conflictDate", "push", "pull"])) return false;
  if (value.allocationId !== null && !isHash(value.allocationId)) return false;
  if (value.conflictDate !== null && !isStrictCalendarDay(value.conflictDate)) return false;
  if (
    value.push !== null &&
    (!hasExactKeys(value.push, ["notionMarkdown", "unsupportedKinds"]) ||
      typeof value.push.notionMarkdown !== "string" ||
      byteLength(value.push.notionMarkdown) > MAX_MARKDOWN_BYTES ||
      !isUnsupportedKinds(value.push.unsupportedKinds))
  ) {
    return false;
  }
  if (
    value.pull !== null &&
    (!hasExactKeys(value.pull, ["nextBytes", "nextByteHash"]) ||
      typeof value.pull.nextBytes !== "string" ||
      byteLength(value.pull.nextBytes) > MAX_MARKDOWN_BYTES ||
      !isHash(value.pull.nextByteHash))
  ) {
    return false;
  }
  return true;
}

function semanticEqual(
  left: { readonly bodyMarkdown: string; readonly tags: readonly string[] },
  right: { readonly bodyMarkdown: string; readonly tags: readonly string[] },
): boolean {
  return left.bodyMarkdown === right.bodyMarkdown && left.tags.length === right.tags.length && left.tags.every((tag, index) => tag === right.tags[index]);
}

function isPreparationConsistent(input: PairPlanningInput): boolean {
  const allocationRequired =
    input.local.kind === "present" &&
    input.local.eligible &&
    input.notion.kind === "missing" &&
    input.prior === null &&
    input.local.bridgeId === null;
  if (allocationRequired !== (input.prepared.allocationId !== null)) return false;

  if (input.local.kind === "present" && input.notion.kind === "present") {
    const sameSemantic = semanticEqual(input.local.semantic, input.notion.semantic);
    if ((input.local.semanticHash === input.notion.semanticHash) !== sameSemantic) return false;
  }

  const isNewConflict =
    input.prior !== null &&
    input.prior.status !== "conflict" &&
    input.local.kind === "present" &&
    input.local.eligible &&
    input.notion.kind === "present" &&
    input.notion.complete &&
    input.notion.unsupportedKinds.length === 0 &&
    input.prepared.push !== null &&
    input.prepared.push.unsupportedKinds.length === 0 &&
    input.local.semanticHash !== input.prior.lastCommonSemanticHash &&
    input.notion.semanticHash !== input.prior.lastCommonSemanticHash &&
    input.local.semanticHash !== input.notion.semanticHash;
  return isNewConflict === (input.prepared.conflictDate !== null);
}

function isPlanningInput(value: unknown): value is PairPlanningInput {
  if (!hasExactKeys(value, ["local", "notion", "prior", "prepared"])) return false;
  if (!isLocalObservation(value.local) || !isNotionObservation(value.notion) || !isPreparation(value.prepared)) return false;
  if (value.prior !== null && !isPairState(value.prior)) return false;
  return isPreparationConsistent(value as unknown as PairPlanningInput);
}

function hasIdentityMismatch(input: PairPlanningInput): boolean {
  if (
    input.notion.kind === "present" &&
    pageIdFromValidatedUrl(input.notion.pageUrl) !== input.notion.pageId
  ) {
    return true;
  }
  if (input.prior !== null) {
    if (input.local.kind === "present" && input.local.bridgeId !== input.prior.bridgeId) return true;
    if (input.local.kind === "missing" && input.local.path !== input.prior.localPath) return true;
    if (
      input.notion.kind === "present" &&
      (input.notion.pageId !== input.prior.notionPageId || input.notion.bridgeId !== input.prior.bridgeId)
    ) {
      return true;
    }
    if (input.notion.kind === "missing" && input.notion.pageId !== null && input.notion.pageId !== input.prior.notionPageId) {
      return true;
    }
  }
  return (
    input.local.kind === "present" &&
    input.notion.kind === "present" &&
    input.local.bridgeId !== null &&
    input.notion.bridgeId !== null &&
    input.local.bridgeId !== input.notion.bridgeId
  );
}

function copyIdentity(identity: PairIdentityRef): PairIdentityRef {
  return identity.kind === "existing"
    ? Object.freeze({ kind: "existing" as const, bridgeId: identity.bridgeId })
    : Object.freeze({ kind: "allocate-on-apply" as const, allocationId: identity.allocationId });
}

function existingIdentity(bridgeId: string): PairIdentityRef {
  return Object.freeze({ kind: "existing" as const, bridgeId });
}

function allocationIdentity(allocationId: string): PairIdentityRef {
  return Object.freeze({ kind: "allocate-on-apply" as const, allocationId });
}

function copyTags(tags: readonly string[]): readonly string[] {
  return Object.freeze([...tags]);
}

function copyState(state: Readonly<PairStateV1>): Readonly<PairStateV1> {
  return Object.freeze({ ...state });
}

function observedRevision(editedAt: string): RemoteRevisionRef {
  return Object.freeze({ kind: "observed" as const, editedAt });
}

function effectRevision(effectIndex: number): RemoteRevisionRef {
  return Object.freeze({ kind: "effect-result" as const, effectIndex });
}

function observationEvidence() {
  return Object.freeze({ kind: "observation" as const });
}

function effectEvidence(effectIndex: number) {
  return Object.freeze({ kind: "effect-result" as const, effectIndex });
}

function noneAdvance(): PairStateAdvance {
  return Object.freeze({ kind: "none" as const });
}

function preserveAdvance(
  prior: Readonly<PairStateV1>,
  status: PairStatus,
  localPath: string,
  notionRevision: ReturnType<typeof observationEvidence> | ReturnType<typeof effectEvidence> | null,
): PairStateAdvance {
  return Object.freeze({
    kind: "preserve-common" as const,
    base: copyState(prior),
    status,
    localPath,
    notionRevision,
  });
}

function establishAdvance(
  identity: PairIdentityRef,
  localPath: string,
  semanticHash: string,
  localEvidence: ReturnType<typeof observationEvidence> | ReturnType<typeof effectEvidence>,
  notionEvidence: ReturnType<typeof observationEvidence> | ReturnType<typeof effectEvidence>,
): PairStateAdvance {
  return Object.freeze({
    kind: "establish-common" as const,
    identity: copyIdentity(identity),
    localPath,
    semanticHash,
    localEvidence,
    notionEvidence,
  });
}

function makePlan(
  action: PairPlan["action"],
  reason: PairPlan["reason"],
  identity: PairIdentityRef | null,
  effects: readonly PlannedEffect[],
  error: SafeError | null,
  stateAdvance: PairStateAdvance,
): PairPlan {
  return Object.freeze({
    action,
    reason,
    identity: identity === null ? null : copyIdentity(identity),
    effects: Object.freeze([...effects]),
    error,
    stateAdvance,
  });
}

function invalidPlan(): PairPlan {
  return makePlan("error", "invalid-input", null, [], INVALID_INPUT_ERROR, noneAdvance());
}

function identityPlan(): PairPlan {
  return makePlan("error", "identity-mismatch", null, [], IDENTITY_ERROR, noneAdvance());
}

function unsupportedPlan(reason: "unsupported-local" | "unsupported-notion"): PairPlan {
  return makePlan("error", reason, null, [], UNSUPPORTED_ERROR, noneAdvance());
}

function conversionPlan(reason: "malformed-local" | "conflict-artifact-too-large"): PairPlan {
  return makePlan("error", reason, null, [], CONVERSION_ERROR, noneAdvance());
}

function observedProperties(input: Extract<PairPlanningInput["notion"], { readonly kind: "present" }>): ManagedPropertiesSnapshot {
  return Object.freeze({
    title: input.managed.title,
    obsidianPath: input.managed.obsidianPath,
    tags: copyTags(input.semantic.tags),
    status: input.managed.status,
  });
}

function targetProperties(
  local: Extract<PairPlanningInput["local"], { readonly kind: "present" }>,
  tags: readonly string[],
  status: PairStatus,
): ManagedPropertiesSnapshot {
  return Object.freeze({
    title: local.title,
    obsidianPath: local.path,
    tags: copyTags(tags),
    status,
  });
}

function sameProperties(left: ManagedPropertiesSnapshot, right: ManagedPropertiesSnapshot): boolean {
  return (
    left.title === right.title &&
    left.obsidianPath === right.obsidianPath &&
    left.status === right.status &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag, index) => tag === right.tags[index])
  );
}

function propertyEffect(
  pageId: string,
  expected: ManagedPropertiesSnapshot,
  next: ManagedPropertiesSnapshot,
  expectedRevision: RemoteRevisionRef,
): PlannedEffect {
  return Object.freeze({
    kind: "update-notion-properties" as const,
    pageId,
    expected,
    next,
    expectedRevision,
  });
}

function statusEffect(
  pageId: string,
  expectedStatus: PairStatus,
  nextStatus: PairStatus,
  expectedRevision: RemoteRevisionRef,
): PlannedEffect {
  return Object.freeze({
    kind: "set-notion-status" as const,
    pageId,
    expectedStatus,
    nextStatus,
    expectedRevision,
  });
}

function planMissingLocal(input: PairPlanningInput): PairPlan {
  if (input.prior === null) return invalidPlan();
  const identity = existingIdentity(input.prior.bridgeId);
  if (input.notion.kind !== "present") {
    return makePlan(
      "missing-local",
      "local-missing",
      identity,
      [],
      null,
      preserveAdvance(input.prior, "missing-local", input.prior.localPath, null),
    );
  }
  const effects: PlannedEffect[] = [];
  let notionEvidence: ReturnType<typeof observationEvidence> | ReturnType<typeof effectEvidence> = observationEvidence();
  if (input.notion.managed.status !== "missing-local") {
    effects.push(statusEffect(input.notion.pageId, input.notion.managed.status, "missing-local", observedRevision(input.notion.editedAt)));
    notionEvidence = effectEvidence(0);
  }
  return makePlan(
    "missing-local",
    "local-missing",
    identity,
    effects,
    null,
    preserveAdvance(input.prior, "missing-local", input.prior.localPath, notionEvidence),
  );
}

function planDetached(input: PairPlanningInput, local: Extract<PairPlanningInput["local"], { readonly kind: "present" }>): PairPlan {
  const identity = input.prior === null ? (local.bridgeId === null ? null : existingIdentity(local.bridgeId)) : existingIdentity(input.prior.bridgeId);
  if (input.prior === null || input.notion.kind !== "present") {
    return makePlan("detached", "not-eligible", identity, [], null, noneAdvance());
  }
  const effects: PlannedEffect[] = [];
  let notionEvidence: ReturnType<typeof observationEvidence> | ReturnType<typeof effectEvidence> = observationEvidence();
  if (input.notion.managed.status !== "detached") {
    effects.push(statusEffect(input.notion.pageId, input.notion.managed.status, "detached", observedRevision(input.notion.editedAt)));
    notionEvidence = effectEvidence(0);
  }
  return makePlan(
    "detached",
    "not-eligible",
    identity,
    effects,
    null,
    preserveAdvance(input.prior, "detached", local.path, notionEvidence),
  );
}

function planMissingNotion(
  input: PairPlanningInput,
  local: Extract<PairPlanningInput["local"], { readonly kind: "present" }>,
): PairPlan {
  if (input.prior === null) return invalidPlan();
  return makePlan(
    "missing-notion",
    "notion-missing",
    existingIdentity(input.prior.bridgeId),
    [],
    null,
    preserveAdvance(input.prior, "missing-notion", local.path, null),
  );
}

function planInitialization(
  input: PairPlanningInput,
  local: Extract<PairPlanningInput["local"], { readonly kind: "present" }>,
): PairPlan {
  if (input.prepared.push === null) return invalidPlan();
  if (input.prepared.push.unsupportedKinds.length > 0) return unsupportedPlan("unsupported-local");
  const identity = local.bridgeId === null
    ? input.prepared.allocationId === null
      ? null
      : allocationIdentity(input.prepared.allocationId)
    : existingIdentity(local.bridgeId);
  if (identity === null) return invalidPlan();
  const effects: PlannedEffect[] = [];
  if (identity.kind === "allocate-on-apply") {
    effects.push(Object.freeze({
      kind: "initialize-pair" as const,
      identity: copyIdentity(identity),
      path: local.path,
      expectedByteHash: local.byteHash,
    }));
  }
  effects.push(Object.freeze({
    kind: "create-notion-page" as const,
    identity: copyIdentity(identity),
    title: local.title,
    obsidianPath: local.path,
    tags: copyTags(local.semantic.tags),
    markdown: input.prepared.push.notionMarkdown,
    status: "synced" as const,
  }));
  return makePlan(
    "initialize",
    "first-pair",
    identity,
    effects,
    null,
    establishAdvance(identity, local.path, local.semanticHash, observationEvidence(), effectEvidence(effects.length - 1)),
  );
}

function planEqualSemantics(
  input: PairPlanningInput,
  local: Extract<PairPlanningInput["local"], { readonly kind: "present" }>,
  notion: Extract<PairPlanningInput["notion"], { readonly kind: "present" }>,
): PairPlan {
  const identity = existingIdentity(input.prior?.bridgeId ?? local.bridgeId ?? "");
  if (input.prior === null || local.bridgeId === null) return identityPlan();
  const expected = observedProperties(notion);
  const next = targetProperties(local, local.semantic.tags, "synced");
  const propertiesChanged = !sameProperties(expected, next);
  const converged = local.semanticHash !== input.prior.lastCommonSemanticHash;
  if (!propertiesChanged) {
    if (!converged) return makePlan("noop", "unchanged", identity, [], null, noneAdvance());
    return makePlan(
      "noop",
      "converged",
      identity,
      [],
      null,
      establishAdvance(identity, local.path, local.semanticHash, observationEvidence(), observationEvidence()),
    );
  }
  const effects = [propertyEffect(notion.pageId, expected, next, observedRevision(notion.editedAt))];
  if (!converged) {
    return makePlan(
      "push-local",
      "metadata-drift",
      identity,
      effects,
      null,
      preserveAdvance(input.prior, "synced", local.path, effectEvidence(0)),
    );
  }
  return makePlan(
    "push-local",
    "converged",
    identity,
    effects,
    null,
    establishAdvance(identity, local.path, local.semanticHash, observationEvidence(), effectEvidence(0)),
  );
}

function planPush(
  input: PairPlanningInput,
  local: Extract<PairPlanningInput["local"], { readonly kind: "present" }>,
  notion: Extract<PairPlanningInput["notion"], { readonly kind: "present" }>,
): PairPlan {
  if (input.prior === null || local.bridgeId === null || input.prepared.push === null) return invalidPlan();
  const identity = existingIdentity(input.prior.bridgeId);
  const effects: PlannedEffect[] = [];
  let expectedRevision = observedRevision(notion.editedAt);
  if (input.prepared.push.notionMarkdown !== notion.sourceMarkdown) {
    effects.push(Object.freeze({
      kind: "update-notion-body-exact" as const,
      pageId: notion.pageId,
      oldMarkdown: notion.sourceMarkdown,
      newMarkdown: input.prepared.push.notionMarkdown,
      expectedRevision,
    }));
    expectedRevision = effectRevision(effects.length - 1);
  }
  const expected = observedProperties(notion);
  const next = targetProperties(local, local.semantic.tags, "synced");
  if (!sameProperties(expected, next)) {
    effects.push(propertyEffect(notion.pageId, expected, next, expectedRevision));
  }
  if (effects.length === 0) return invalidPlan();
  const remoteEffectIndex = effects.length - 1;
  return makePlan(
    "push-local",
    "local-changed",
    identity,
    effects,
    null,
    establishAdvance(identity, local.path, local.semanticHash, observationEvidence(), effectEvidence(remoteEffectIndex)),
  );
}

function planPull(
  input: PairPlanningInput,
  local: Extract<PairPlanningInput["local"], { readonly kind: "present" }>,
  notion: Extract<PairPlanningInput["notion"], { readonly kind: "present" }>,
): PairPlan {
  if (input.prior === null || local.bridgeId === null || input.prepared.pull === null) return invalidPlan();
  const identity = existingIdentity(input.prior.bridgeId);
  const effects: PlannedEffect[] = [Object.freeze({
    kind: "write-local" as const,
    path: local.path,
    expectedByteHash: local.byteHash,
    nextBytes: input.prepared.pull.nextBytes,
    expectedNextByteHash: input.prepared.pull.nextByteHash,
  })];
  const expected = observedProperties(notion);
  const next = targetProperties(local, notion.semantic.tags, "synced");
  let notionEvidence: ReturnType<typeof observationEvidence> | ReturnType<typeof effectEvidence> = observationEvidence();
  if (!sameProperties(expected, next)) {
    effects.push(propertyEffect(notion.pageId, expected, next, observedRevision(notion.editedAt)));
    notionEvidence = effectEvidence(effects.length - 1);
  }
  return makePlan(
    "pull-notion",
    "notion-changed",
    identity,
    effects,
    null,
    establishAdvance(identity, local.path, notion.semanticHash, effectEvidence(0), notionEvidence),
  );
}

function planConflict(
  input: PairPlanningInput,
  local: Extract<PairPlanningInput["local"], { readonly kind: "present" }>,
  notion: Extract<PairPlanningInput["notion"], { readonly kind: "present" }>,
): PairPlan {
  if (input.prior === null || input.prepared.conflictDate === null) return invalidPlan();
  const identity = existingIdentity(input.prior.bridgeId);
  let path: string;
  let content: string;
  try {
    const artifactInput = {
      bridgeId: input.prior.bridgeId,
      conflictDate: input.prepared.conflictDate,
      localPath: local.path,
      localTitle: local.title,
      notionPageUrl: notion.pageUrl,
      localSemantic: local.semantic,
      notionSemantic: notion.semantic,
    };
    path = conflictArtifactPath(artifactInput);
    content = renderConflictArtifact(artifactInput);
  } catch (caught) {
    if (caught instanceof ConflictArtifactError && caught.kind === "too-large") {
      return conversionPlan("conflict-artifact-too-large");
    }
    return invalidPlan();
  }
  const effects: PlannedEffect[] = [
    Object.freeze({ kind: "create-conflict" as const, path, expectedAbsent: true as const, content }),
    statusEffect(notion.pageId, notion.managed.status, "conflict", observedRevision(notion.editedAt)),
  ];
  return makePlan(
    "conflict",
    "concurrent-change",
    identity,
    effects,
    null,
    preserveAdvance(input.prior, "conflict", local.path, effectEvidence(1)),
  );
}

export function planPair(input: PairPlanningInput): PairPlan {
  try {
    if (!isPlanningInput(input)) return invalidPlan();
    if (hasIdentityMismatch(input)) return identityPlan();

    if (input.local.kind === "malformed") return conversionPlan("malformed-local");
    if (input.local.kind === "missing") return planMissingLocal(input);
    if (!input.local.eligible) return planDetached(input, input.local);

    if (input.notion.kind === "missing") {
      return input.prior === null ? planInitialization(input, input.local) : planMissingNotion(input, input.local);
    }
    if (input.prior === null) return identityPlan();
    if (!input.notion.complete || input.notion.unsupportedKinds.length > 0) return unsupportedPlan("unsupported-notion");
    if (input.prepared.push !== null && input.prepared.push.unsupportedKinds.length > 0) return unsupportedPlan("unsupported-local");
    if (input.prior.status === "conflict") {
      return makePlan("conflict", "conflict-paused", existingIdentity(input.prior.bridgeId), [], null, noneAdvance());
    }

    if (input.local.semanticHash === input.notion.semanticHash) {
      return planEqualSemantics(input, input.local, input.notion);
    }

    const localChanged = input.local.semanticHash !== input.prior.lastCommonSemanticHash;
    const notionChanged = input.notion.semanticHash !== input.prior.lastCommonSemanticHash;
    if (localChanged && notionChanged) return planConflict(input, input.local, input.notion);
    if (localChanged) return planPush(input, input.local, input.notion);
    if (notionChanged) return planPull(input, input.local, input.notion);
    return planEqualSemantics(input, input.local, input.notion);
  } catch {
    return invalidPlan();
  }
}

function claim(value: unknown, isValid: (candidate: unknown) => boolean): string | null {
  return isValid(value) && typeof value === "string" ? value : null;
}

function valuesFrom(input: unknown, key: string): unknown[] {
  return isRecord(input) && Object.hasOwn(input, key) ? [input[key]] : [];
}

function batchCollision(inputs: readonly PairPlanningInput[]): boolean {
  const bridges = new Map<string, number>();
  const paths = new Map<string, number>();
  const pages = new Map<string, number>();
  const allocations = new Map<string, number>();
  const register = (table: Map<string, number>, value: string | null, index: number): boolean => {
    if (value === null) return false;
    const owner = table.get(value);
    if (owner !== undefined && owner !== index) return true;
    table.set(value, index);
    return false;
  };

  for (const [index, input] of inputs.entries()) {
    const root = input as unknown;
    const local = valuesFrom(root, "local")[0];
    const notion = valuesFrom(root, "notion")[0];
    const prior = valuesFrom(root, "prior")[0];
    const prepared = valuesFrom(root, "prepared")[0];
    const bridgeClaims = [
      ...valuesFrom(local, "bridgeId"),
      ...valuesFrom(notion, "bridgeId"),
      ...valuesFrom(prior, "bridgeId"),
    ].map((value) => claim(value, isCanonicalUuid)).filter((value): value is string => value !== null);
    if (new Set(bridgeClaims).size > 1) return true;
    if (register(bridges, bridgeClaims[0] ?? null, index)) return true;

    const pageClaims = [
      ...valuesFrom(notion, "pageId"),
      ...valuesFrom(prior, "notionPageId"),
    ].map((value) => claim(value, isCanonicalUuid)).filter((value): value is string => value !== null);
    if (new Set(pageClaims).size > 1) return true;
    if (register(pages, pageClaims[0] ?? null, index)) return true;

    const pathClaims = [
      ...valuesFrom(local, "path"),
      ...valuesFrom(prior, "localPath"),
    ].map((value) => claim(value, isSafeRelativePath)).filter((value): value is string => value !== null);
    for (const path of new Set(pathClaims)) {
      if (register(paths, path, index)) return true;
    }

    const allocation = claim(valuesFrom(prepared, "allocationId")[0], isHash);
    if (register(allocations, allocation, index)) return true;
  }
  return false;
}

export function validatePlanningBatch(inputs: readonly PairPlanningInput[]): PlanningBatchValidation {
  try {
    if (!Array.isArray(inputs) || batchCollision(inputs)) {
      return Object.freeze({ ok: false as const, reason: "identity-collision" as const, error: IDENTITY_ERROR });
    }
    return Object.freeze({ ok: true as const });
  } catch {
    return Object.freeze({ ok: false as const, reason: "identity-collision" as const, error: IDENTITY_ERROR });
  }
}

export async function deriveAllocationId(normalizedPath: string, observedByteHash: string): Promise<string> {
  if (!isSafeRelativePath(normalizedPath) || !isHash(observedByteHash)) {
    throw new Error("Invalid allocation input");
  }
  return sha256Hex(`grandbox-bridge:pair-allocation:v1\0${normalizedPath}\0${observedByteHash}`);
}
