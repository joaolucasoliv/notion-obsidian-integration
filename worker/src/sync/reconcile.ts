import { basename } from "node:path";
import {
  SAFE_ERROR_CODES,
  sha256Hex,
  type Clock,
  type NotionApi,
  type NotionObservation,
  type PairPlanningInput,
  type PairStateV1,
  type SafeError,
  type SafeErrorCode,
} from "@grandbox-bridge/shared";
import { parseLocalNote, type ParsedLocalNote } from "../markdown/frontmatter.js";
import { fromNotionMarkdown, toNotionMarkdown, type LinkMapping } from "../markdown/notion-mapping.js";
import { normalizeLocal, semanticHash } from "../markdown/normalize.js";
import { parseMarkdown } from "../markdown/parse.js";
import { renderLocalNote } from "../markdown/render.js";
import { observeSafeVaultNoteBytes, scanVaultNotes, type ScannedVaultNote } from "../vault/scanner.js";
import type { CanonicalVaultRoot } from "../vault/safety.js";
import { deriveAllocationId } from "./planner.js";

export interface ReconciliationFailure {
  readonly error: SafeError;
}

export interface ReconciliationResult {
  readonly inputs: readonly PairPlanningInput[];
  readonly failures: readonly ReconciliationFailure[];
}

export interface ReconciliationDependencies {
  readonly root: CanonicalVaultRoot;
  readonly notion: NotionApi;
  readonly clock: Clock;
  readonly scan?: (root: CanonicalVaultRoot) => Promise<readonly ScannedVaultNote[]>;
}

export class ReconciliationError extends Error {
  public constructor(public readonly error: SafeError) {
    super("Reconciliation failed");
    this.name = "ReconciliationError";
  }
}

interface LocalCandidate {
  readonly observation: Extract<PairPlanningInput["local"], { readonly kind: "present" }>;
  readonly note: ParsedLocalNote;
}

interface StateCandidate {
  readonly prior: Readonly<PairStateV1>;
  readonly local: PairPlanningInput["local"];
  readonly localNote: ParsedLocalNote | null;
  readonly notion: NotionObservation;
}

const SAFE_CODES = new Set<string>(SAFE_ERROR_CODES);

function fixedError(code: SafeErrorCode, retryable = false): SafeError {
  return Object.freeze({ code, retryable });
}

export function safeErrorFrom(caught: unknown, fallback: SafeErrorCode = "internal-error"): SafeError {
  if (caught instanceof ReconciliationError) return caught.error;
  if (
    typeof caught === "object" &&
    caught !== null &&
    "code" in caught &&
    typeof caught.code === "string" &&
    SAFE_CODES.has(caught.code)
  ) {
    return fixedError(caught.code as SafeErrorCode, "retryable" in caught && caught.retryable === true);
  }
  return fixedError(fallback);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function titleForPath(path: string): string {
  const name = basename(path);
  const title = name.replace(/\.md$/iu, "");
  if (title.length === 0) {
    throw new Error("Invalid local title");
  }
  return title;
}

function canonicalNotionUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replaceAll("-", "")}`;
}

function emptyPreparation(): PairPlanningInput["prepared"] {
  return Object.freeze({ allocationId: null, conflictDate: null, push: null, pull: null });
}

function localFromScanned(entry: ScannedVaultNote): LocalCandidate | null {
  if (!("note" in entry) || entry.note === undefined) {
    return null;
  }
  const note = entry.note;
  const semantic = normalizeLocal(parseMarkdown(note.body), note.tags);
  return {
    note,
    observation: Object.freeze({
      kind: "present" as const,
      path: note.path,
      title: titleForPath(note.path),
      bridgeId: note.bridgeId,
      byteHash: "",
      eligible: entry.eligibility.eligible,
      semantic,
      semanticHash: "",
    }),
  };
}

async function finalizeLocal(candidate: LocalCandidate): Promise<LocalCandidate> {
  const byteHash = await sha256Hex(candidate.note.bytes);
  const semanticValue = await semanticHash(candidate.observation.semantic);
  return Object.freeze({
    note: candidate.note,
    observation: Object.freeze({ ...candidate.observation, byteHash, semanticHash: semanticValue }),
  });
}

function utcDate(clock: Clock): string {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ReconciliationError(fixedError("internal-error"));
  }
  const year = String(value.getUTCFullYear()).padStart(4, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function needsConflictDate(
  local: PairPlanningInput["local"],
  notion: NotionObservation,
  prior: Readonly<PairStateV1> | null,
): boolean {
  return (
    prior !== null &&
    local.kind === "present" &&
    local.eligible &&
    notion.kind === "present" &&
    notion.complete &&
    notion.unsupportedKinds.length === 0 &&
    local.semanticHash !== prior.lastCommonSemanticHash &&
    notion.semanticHash !== prior.lastCommonSemanticHash &&
    local.semanticHash !== notion.semanticHash
  );
}

function linkMapping(candidates: readonly StateCandidate[]): LinkMapping {
  const byLocalTarget = new Map<string, { readonly bridgeId: string; readonly notionPageUrl: string }>();
  const byNotionPageId = new Map<string, { readonly bridgeId: string; readonly localTarget: string }>();
  for (const candidate of candidates) {
    const observedUrl = candidate.notion.kind === "present" ? candidate.notion.pageUrl : canonicalNotionUrl(candidate.prior.notionPageId);
    byLocalTarget.set(candidate.prior.localPath, {
      bridgeId: candidate.prior.bridgeId,
      notionPageUrl: observedUrl,
    });
    byNotionPageId.set(candidate.prior.notionPageId, {
      bridgeId: candidate.prior.bridgeId,
      localTarget: candidate.prior.localPath,
    });
  }
  return Object.freeze({ byLocalTarget, byNotionPageId });
}

async function preparationFor(
  local: PairPlanningInput["local"],
  localNote: ParsedLocalNote | null,
  notion: NotionObservation,
  prior: Readonly<PairStateV1> | null,
  links: LinkMapping,
  clock: Clock,
): Promise<PairPlanningInput["prepared"]> {
  if (local.kind !== "present") return emptyPreparation();

  const push = toNotionMarkdown(local.semantic, links);
  let pull: PairPlanningInput["prepared"]["pull"] = null;
  if (notion.kind === "present" && localNote !== null) {
    const mapped = fromNotionMarkdown(notion.sourceMarkdown, links, notion.semantic.tags);
    const nextBytes = renderLocalNote(localNote, mapped.semantic);
    pull = Object.freeze({ nextBytes, nextByteHash: await sha256Hex(nextBytes) });
  }

  const allocationId =
    prior === null &&
    notion.kind === "missing" &&
    local.eligible &&
    local.bridgeId === null
      ? await deriveAllocationId(local.path, local.byteHash)
      : null;
  return Object.freeze({
    allocationId,
    conflictDate: needsConflictDate(local, notion, prior) ? utcDate(clock) : null,
    push: Object.freeze({ notionMarkdown: push.markdown, unsupportedKinds: Object.freeze([...push.unsupportedKinds]) }),
    pull,
  });
}

function malformed(path: string, reason: "invalid-frontmatter" | "conversion-failed"): PairPlanningInput["local"] {
  return Object.freeze({ kind: "malformed", path, reason });
}

async function observationForState(
  pair: Readonly<PairStateV1>,
  entry: ScannedVaultNote | undefined,
  notion: NotionApi,
): Promise<StateCandidate | ReconciliationFailure> {
  let local: PairPlanningInput["local"];
  let localNote: ParsedLocalNote | null = null;
  if (entry === undefined) {
    local = Object.freeze({ kind: "missing", path: pair.localPath });
  } else {
    try {
      const candidate = localFromScanned(entry);
      if (candidate === null) {
        local = malformed(pair.localPath, "invalid-frontmatter");
      } else {
        const finalized = await finalizeLocal(candidate);
        local = finalized.observation;
        localNote = finalized.note;
      }
    } catch {
      local = malformed(pair.localPath, "conversion-failed");
    }
  }

  try {
    const observed = await notion.retrievePage(pair.notionPageId);
    const remote = observed.kind === "missing"
      ? Object.freeze({ kind: "missing" as const, pageId: pair.notionPageId })
      : observed;
    return Object.freeze({ prior: pair, local, localNote, notion: remote });
  } catch (caught) {
    const error = safeErrorFrom(caught, "network-failed");
    if (error.code === "not-found") {
      return Object.freeze({
        prior: pair,
        local,
        localNote,
        notion: Object.freeze({ kind: "missing" as const, pageId: pair.notionPageId }),
      });
    }
    return Object.freeze({ error });
  }
}

function asFailure(value: StateCandidate | ReconciliationFailure): value is ReconciliationFailure {
  return "error" in value;
}

function assertStateIdentity(state: Readonly<Record<string, Readonly<PairStateV1>>>): void {
  const localPaths = new Set<string>();
  const remotePages = new Set<string>();
  for (const [key, pair] of Object.entries(state)) {
    if (
      key !== pair.bridgeId ||
      localPaths.has(pair.localPath) ||
      remotePages.has(pair.notionPageId)
    ) {
      throw new ReconciliationError(fixedError("identity-collision"));
    }
    localPaths.add(pair.localPath);
    remotePages.add(pair.notionPageId);
  }
}

/**
 * Turns scanner and exact-ID Notion observations into deterministic planning inputs.
 * It intentionally reports pair-local failures without retaining source content.
 */
export async function reconcilePairs(
  state: Readonly<{ readonly pairs: Record<string, Readonly<PairStateV1>> }>,
  dependencies: ReconciliationDependencies,
): Promise<ReconciliationResult> {
  try {
    assertStateIdentity(state.pairs);
    const scanned = await (dependencies.scan ?? scanVaultNotes)(dependencies.root);
    const byPath = new Map<string, ScannedVaultNote>();
    for (const entry of scanned) {
      if (byPath.has(entry.path)) {
        throw new ReconciliationError(fixedError("identity-collision"));
      }
      byPath.set(entry.path, entry);
    }

    const priors = Object.values(state.pairs).sort((left, right) => {
      const byPath = compareStrings(left.localPath, right.localPath);
      return byPath === 0 ? compareStrings(left.bridgeId, right.bridgeId) : byPath;
    });
    const stateCandidates: StateCandidate[] = [];
    const failures: ReconciliationFailure[] = [];
    for (const pair of priors) {
      const observed = await observationForState(pair, byPath.get(pair.localPath), dependencies.notion);
      if (asFailure(observed)) {
        failures.push(observed);
      } else {
        stateCandidates.push(observed);
      }
    }

    const links = linkMapping(stateCandidates);
    const inputs: PairPlanningInput[] = [];
    for (const candidate of stateCandidates) {
      let local = candidate.local;
      let prepared = emptyPreparation();
      try {
        prepared = await preparationFor(local, candidate.localNote, candidate.notion, candidate.prior, links, dependencies.clock);
      } catch {
        local = malformed(candidate.prior.localPath, "conversion-failed");
      }
      inputs.push(Object.freeze({ local, notion: candidate.notion, prior: candidate.prior, prepared }));
    }

    const pairedPaths = new Set(priors.map((pair) => pair.localPath));
    for (const entry of scanned) {
      if (
        !pairedPaths.has(entry.path) &&
        !entry.eligibility.eligible &&
        entry.eligibility.reason === "invalid-frontmatter"
      ) {
        // A malformed unpaired note is never promoted into state or a remote page,
        // but it remains an independently reportable pair-scoped safe failure.
        failures.push(Object.freeze({ error: fixedError("conversion-failed") }));
      }
    }
    const fresh = [...scanned]
      .filter((entry) => entry.eligibility.eligible && !pairedPaths.has(entry.path))
      .sort((left, right) => compareStrings(left.path, right.path));
    for (const entry of fresh) {
      try {
        const candidate = localFromScanned(entry);
        if (candidate === null) continue;
        const finalized = await finalizeLocal(candidate);
        const notion = Object.freeze({ kind: "missing" as const, pageId: null });
        const prepared = await preparationFor(finalized.observation, finalized.note, notion, null, links, dependencies.clock);
        inputs.push(Object.freeze({ local: finalized.observation, notion, prior: null, prepared }));
      } catch {
        inputs.push(Object.freeze({
          local: malformed(entry.path, "conversion-failed"),
          notion: Object.freeze({ kind: "missing" as const, pageId: null }),
          prior: null,
          prepared: emptyPreparation(),
        }));
      }
    }

    inputs.sort((left, right) => {
      const leftPath = left.local.path;
      const rightPath = right.local.path;
      const byPath = compareStrings(leftPath, rightPath);
      if (byPath !== 0) return byPath;
      const leftId = left.prior?.bridgeId ?? (left.local.kind === "present" ? left.local.bridgeId ?? "" : "");
      const rightId = right.prior?.bridgeId ?? (right.local.kind === "present" ? right.local.bridgeId ?? "" : "");
      return compareStrings(leftId, rightId);
    });
    return Object.freeze({ inputs: Object.freeze(inputs), failures: Object.freeze(failures) });
  } catch (caught) {
    if (caught instanceof ReconciliationError) throw caught;
    throw new ReconciliationError(safeErrorFrom(caught));
  }
}

/** A decoder link mapping must only contain persisted, internally consistent state pairs. */
export function persistedLinkMapping(state: Readonly<{ readonly pairs: Record<string, Readonly<PairStateV1>> }>): LinkMapping {
  assertStateIdentity(state.pairs);
  return linkMapping(
    Object.values(state.pairs)
      .sort((left, right) => compareStrings(left.bridgeId, right.bridgeId))
      .map((prior) => ({
        prior,
        local: Object.freeze({ kind: "missing" as const, path: prior.localPath }),
        localNote: null,
        notion: Object.freeze({ kind: "missing" as const, pageId: prior.notionPageId }),
      })),
  );
}

/** Re-validates a local recovery target without exposing its bytes outside this module. */
export async function localRecoveryObservation(
  root: CanonicalVaultRoot,
  relativePath: string,
): Promise<
  | { readonly kind: "missing" }
  | { readonly kind: "present"; readonly byteHash: string; readonly semanticHash: string | null; readonly bridgeId: string | null }
> {
  const observed = await observeSafeVaultNoteBytes(root, relativePath);
  if (observed.kind === "missing") return observed;
  const byteHash = await sha256Hex(observed.bytes);
  try {
    const note = parseLocalNote(relativePath, observed.bytes);
    const semantic = normalizeLocal(parseMarkdown(note.body), note.tags);
    return Object.freeze({ kind: "present" as const, byteHash, semanticHash: await semanticHash(semantic), bridgeId: note.bridgeId });
  } catch {
    return Object.freeze({ kind: "present" as const, byteHash, semanticHash: null, bridgeId: null });
  }
}
