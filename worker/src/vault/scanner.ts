import { constants } from "node:fs";
import { lstat, opendir, open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  LocalNoteParseError,
  MAX_LOCAL_NOTE_BYTES,
  parseLocalNote,
  type ParsedLocalNote,
} from "../markdown/frontmatter.js";
import {
  classifyEligibility,
  classifyPathExclusion,
  inspectGithubManagedBytes,
  type Eligibility,
} from "./eligibility.js";
import { resolveSafeVaultPath, type CanonicalVaultRoot } from "./safety.js";

export type ScannedVaultNote =
  | {
      readonly path: string;
      readonly eligibility: Extract<Eligibility, { eligible: true }>;
      readonly note: ParsedLocalNote;
    }
  | {
      readonly path: string;
      readonly eligibility: Extract<Eligibility, { eligible: false }>;
      readonly note?: ParsedLocalNote;
    };

class CandidateReadError extends Error {
  public constructor() {
    super("Invalid vault note");
    this.name = "CandidateReadError";
  }
}

function invalidCandidate(): CandidateReadError {
  return new CandidateReadError();
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isTechnicalSegment(segment: string): boolean {
  return segment.startsWith(".") || segment.toLowerCase() === "templates";
}

function safeRelativeSegments(relativePath: string): readonly string[] {
  const segments = relativePath.split("/");
  if (
    relativePath.length === 0 ||
    Buffer.byteLength(relativePath, "utf8") > 1_024 ||
    relativePath.startsWith("/") ||
    /^[A-Za-z]:/u.test(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    /[\r\n]/u.test(relativePath) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw invalidCandidate();
  }
  return segments;
}

function isSameIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

async function assertCanonicalRoot(root: CanonicalVaultRoot): Promise<void> {
  try {
    const canonical = await realpath(root.canonicalRealPath);
    const rootStats = await stat(canonical);
    if (
      canonical !== root.canonicalRealPath ||
      !rootStats.isDirectory() ||
      String(rootStats.dev) !== root.filesystemDeviceId ||
      !/^[0-9a-f]{64}$/.test(root.vaultFingerprint)
    ) {
      throw invalidCandidate();
    }
  } catch {
    throw invalidCandidate();
  }
}

async function collectAllMarkdownCandidates(
  root: CanonicalVaultRoot,
  directory: string,
  parentSegments: readonly string[],
  candidates: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw invalidCandidate();
  }
  entries.sort((left, right) => compareNames(left.name, right.name));

  for (const entry of entries) {
    const segments = [...parentSegments, entry.name];
    const fullPath = join(root.canonicalRealPath, ...segments);

    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (isTechnicalSegment(entry.name)) {
        continue;
      }
      try {
        const directoryStats = await lstat(fullPath);
        const canonicalDirectory = await realpath(fullPath);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() || canonicalDirectory !== fullPath) {
          continue;
        }
      } catch {
        continue;
      }
      await collectAllMarkdownCandidates(root, fullPath, segments, candidates);
      continue;
    }
    if (entry.isFile() && /\.md$/i.test(entry.name)) {
      candidates.push(segments.join("/"));
    }
  }
}

interface TraversalBudget {
  readonly maximumCandidates: number;
  remainingEntries: number;
}

/**
 * Partial scans stream directory entries and stop before descending further
 * once their global traversal or candidate budget is exhausted. The resulting
 * selection need not be lexicographic; callers use `complete` to defer any
 * decision that would require proving an unseen note absent.
 */
async function collectBoundedMarkdownCandidates(
  root: CanonicalVaultRoot,
  directory: string,
  parentSegments: readonly string[],
  candidates: string[],
  budget: TraversalBudget,
): Promise<boolean> {
  let handle;
  try {
    handle = await opendir(directory, { bufferSize: 1 });
  } catch {
    throw invalidCandidate();
  }
  try {
    for (;;) {
      if (budget.remainingEntries <= 0 || candidates.length >= budget.maximumCandidates) return false;
      let entry;
      try {
        entry = await handle.read();
      } catch {
        throw invalidCandidate();
      }
      if (entry === null) return true;
      budget.remainingEntries -= 1;
      const segments = [...parentSegments, entry.name];
      const fullPath = join(root.canonicalRealPath, ...segments);

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isTechnicalSegment(entry.name)) continue;
        try {
          const directoryStats = await lstat(fullPath);
          const canonicalDirectory = await realpath(fullPath);
          if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() || canonicalDirectory !== fullPath) continue;
        } catch {
          continue;
        }
        if (!(await collectBoundedMarkdownCandidates(root, fullPath, segments, candidates, budget))) return false;
        continue;
      }
      if (entry.isFile() && /\.md$/i.test(entry.name)) candidates.push(segments.join("/"));
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBoundedNote(root: CanonicalVaultRoot, relativePath: string): Promise<string> {
  let safePath: string;
  try {
    safePath = await resolveSafeVaultPath(root, relativePath, "existing-file");
  } catch {
    throw invalidCandidate();
  }

  let handle;
  try {
    handle = await open(safePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    const named = await lstat(safePath);
    if (
      !opened.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      !isSameIdentity(opened, named) ||
      opened.size < 0 ||
      opened.size > MAX_LOCAL_NOTE_BYTES
    ) {
      throw invalidCandidate();
    }
    await resolveSafeVaultPath(root, relativePath, "existing-file");

    const buffer = Buffer.alloc(MAX_LOCAL_NOTE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    if (offset > MAX_LOCAL_NOTE_BYTES) {
      throw invalidCandidate();
    }

    const afterRead = await handle.stat();
    const namedAfterRead = await lstat(safePath);
    if (
      !afterRead.isFile() ||
      !namedAfterRead.isFile() ||
      namedAfterRead.isSymbolicLink() ||
      !isSameIdentity(opened, afterRead) ||
      !isSameIdentity(opened, namedAfterRead) ||
      afterRead.size !== offset ||
      afterRead.size !== opened.size ||
      afterRead.mtimeMs !== opened.mtimeMs
    ) {
      throw invalidCandidate();
    }
    await resolveSafeVaultPath(root, relativePath, "existing-file");

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw invalidCandidate();
    }
  } catch (caught) {
    if (caught instanceof CandidateReadError) {
      throw caught;
    }
    throw invalidCandidate();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export type SafeVaultNoteBytes =
  | { readonly kind: "missing" }
  | { readonly kind: "present"; readonly bytes: string };

/**
 * Classifies one journal target without collapsing an unsafe path/root into
 * absence.  An explicit absence is retryable for a conflict create; an unsafe
 * tree is deliberately left as an error for recovery to fail closed.
 */
export async function observeSafeVaultNoteBytes(
  root: CanonicalVaultRoot,
  relativePath: string,
): Promise<SafeVaultNoteBytes> {
  const segments = safeRelativeSegments(relativePath);
  await assertCanonicalRoot(root);
  let current = root.canonicalRealPath;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
        return Object.freeze({ kind: "missing" as const });
      }
      throw invalidCandidate();
    }
    if (entry.isSymbolicLink() || (index < segments.length - 1 && !entry.isDirectory()) || (index === segments.length - 1 && !entry.isFile())) {
      throw invalidCandidate();
    }
  }
  return Object.freeze({ kind: "present" as const, bytes: await readBoundedNote(root, relativePath) });
}

function freezeEntry(entry: ScannedVaultNote): ScannedVaultNote {
  return Object.freeze(entry);
}

function invalidFrontmatterEntry(path: string): ScannedVaultNote {
  return freezeEntry({ path, eligibility: { eligible: false, reason: "invalid-frontmatter" } });
}

export interface VaultScanOptions {
  /** Caps discovered Markdown candidates; explicit paths remain independently bounded by their caller. */
  readonly maximumCandidates?: number;
  /** Caps streamed directory entries during a partial discovery walk. */
  readonly maximumTraversalEntries?: number;
  /** Known state paths that must be observed even when discovery is capped. */
  readonly includePaths?: readonly string[];
}

export interface VaultScanResult {
  readonly entries: readonly ScannedVaultNote[];
  /** False means discovery stopped at a caller-supplied traversal or candidate budget. */
  readonly complete: boolean;
}

function maximumCandidates(options: Readonly<VaultScanOptions> | undefined): number {
  const value = options?.maximumCandidates;
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) throw invalidCandidate();
  return value;
}

function maximumTraversalEntries(options: Readonly<VaultScanOptions> | undefined): number | undefined {
  const value = options?.maximumTraversalEntries;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw invalidCandidate();
  return value;
}

function includedPaths(options: Readonly<VaultScanOptions> | undefined): readonly string[] {
  const values = options?.includePaths;
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 1_000) throw invalidCandidate();
  const paths = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") throw invalidCandidate();
    const segments = safeRelativeSegments(value);
    if (!/\.md$/iu.test(segments.at(-1) ?? "")) throw invalidCandidate();
    paths.add(segments.join("/"));
  }
  return [...paths].sort(compareNames);
}

async function explicitPathExists(root: CanonicalVaultRoot, path: string): Promise<boolean> {
  try {
    return (await observeSafeVaultNoteBytes(root, path)).kind === "present";
  } catch {
    // Keep an unsafe existing target in the candidate set so it is reported as
    // invalid instead of being silently reclassified as a missing local note.
    return true;
  }
}

async function scanCandidate(root: CanonicalVaultRoot, path: string): Promise<ScannedVaultNote> {
  const pathExclusion = classifyPathExclusion(path);
  if (pathExclusion !== null) {
    return freezeEntry({ path, eligibility: pathExclusion });
  }

  let bytes: string;
  try {
    bytes = await readBoundedNote(root, path);
  } catch {
    return invalidFrontmatterEntry(path);
  }

  const managedState = inspectGithubManagedBytes(bytes);
  if (managedState === "generated") {
    return freezeEntry({ path, eligibility: { eligible: false, reason: "generated-github" } });
  }
  if (managedState === "invalid") {
    return invalidFrontmatterEntry(path);
  }

  try {
    const note = parseLocalNote(path, bytes);
    const eligibility = classifyEligibility(note);
    if (eligibility.eligible) return freezeEntry({ path, eligibility, note });
    return freezeEntry({ path, eligibility, note });
  } catch (caught) {
    if (!(caught instanceof LocalNoteParseError)) throw caught;
    return invalidFrontmatterEntry(path);
  }
}

export async function scanVaultNotesWithStatus(
  root: CanonicalVaultRoot,
  options?: Readonly<VaultScanOptions>,
): Promise<VaultScanResult> {
  await assertCanonicalRoot(root);
  const explicit = includedPaths(options);
  const candidates: string[] = [];
  const candidateLimit = maximumCandidates(options);
  const traversalLimit = maximumTraversalEntries(options);
  const bounded = options?.maximumCandidates !== undefined || traversalLimit !== undefined;
  let complete = true;
  if (bounded) {
    complete = await collectBoundedMarkdownCandidates(
      root,
      root.canonicalRealPath,
      [],
      candidates,
      { maximumCandidates: candidateLimit, remainingEntries: traversalLimit ?? 100_000 },
    );
  } else {
    await collectAllMarkdownCandidates(root, root.canonicalRealPath, [], candidates);
  }
  const paths = new Set(candidates);
  for (const path of explicit) {
    if (await explicitPathExists(root, path)) paths.add(path);
  }

  const scanned: ScannedVaultNote[] = [];
  for (const path of [...paths].sort(compareNames)) {
    scanned.push(await scanCandidate(root, path));
  }

  return Object.freeze({ entries: Object.freeze(scanned), complete });
}

export async function scanVaultNotes(
  root: CanonicalVaultRoot,
  options?: Readonly<VaultScanOptions>,
): Promise<readonly ScannedVaultNote[]> {
  return (await scanVaultNotesWithStatus(root, options)).entries;
}
