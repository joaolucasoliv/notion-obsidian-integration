import { constants } from "node:fs";
import { lstat, opendir, open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isAlias,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Node,
} from "yaml";
import {
  LocalNoteParseError,
  MAX_LOCAL_NOTE_BYTES,
  hasCortexFrontmatterKeys,
  parseLocalNote,
  type ParsedLocalNote,
} from "../markdown/frontmatter.js";
import {
  inspectCortexFrontmatter,
  type CortexFrontmatter,
} from "../cortex/frontmatter.js";
import {
  CORTEX_ROOT_DIRECTORY_PATH,
  CORTEX_ROOT_FILE_PATH,
  cortexParentFilePath,
} from "../cortex/path.js";
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

/** Dedicated, reserved-tree scan for the future Cortex reconciler. */
export type ScannedCortexVaultNote =
  | {
      readonly path: string;
      readonly kind: "owned";
      readonly note: ParsedLocalNote;
      readonly cortex: CortexFrontmatter;
    }
  | {
      readonly path: string;
      /** A user-created bare note whose immediate local parent is paired. */
      readonly kind: "candidate";
      readonly note: ParsedLocalNote;
    }
  | {
      readonly path: string;
      /** A bare note without a paired immediate parent; never create remotely from it. */
      readonly kind: "unpaired";
      readonly note: ParsedLocalNote;
    }
  | {
      readonly path: string;
      readonly kind: "invalid";
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

async function collectCortexCandidates(root: CanonicalVaultRoot): Promise<string[]> {
  const candidates: string[] = [];
  if (await explicitPathExists(root, CORTEX_ROOT_FILE_PATH)) {
    candidates.push(CORTEX_ROOT_FILE_PATH);
  }

  const directory = join(root.canonicalRealPath, CORTEX_ROOT_DIRECTORY_PATH);
  try {
    const named = await lstat(directory);
    if (named.isSymbolicLink() || !named.isDirectory() || (await realpath(directory)) !== directory) {
      throw invalidCandidate();
    }
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return candidates;
    throw invalidCandidate();
  }
  await collectAllMarkdownCandidates(root, directory, [CORTEX_ROOT_DIRECTORY_PATH], candidates);
  return candidates;
}

type CortexScanPreliminary =
  | { readonly path: string; readonly kind: "owned"; readonly note: ParsedLocalNote; readonly cortex: CortexFrontmatter }
  | { readonly path: string; readonly kind: "bare"; readonly note: ParsedLocalNote }
  | { readonly path: string; readonly kind: "direct-pair" }
  | { readonly path: string; readonly kind: "invalid"; readonly cortexClaim: boolean };

const CORTEX_OWNERSHIP_KEYS = new Set([
  "cortex_tree",
  "cortex_page_id",
  "cortex_parent_page_id",
  "cortex_root_page_id",
]);

function isCortexOwnershipKey(value: unknown): value is string {
  return typeof value === "string" && CORTEX_OWNERSHIP_KEYS.has(value);
}

interface YamlAnchorDeclaration {
  readonly node: Node;
  /** Null means malformed YAML did not retain enough order information. */
  readonly start: number | null;
}

function sourceStart(node: Node): number | null {
  const start = node.range?.[0];
  return typeof start === "number" && Number.isSafeInteger(start) && start >= 0
    ? start
    : null;
}

function collectYamlAnchors(
  value: unknown,
  anchors: Map<string, YamlAnchorDeclaration[]>,
  seen: Set<Node>,
): void {
  if (isPair(value)) {
    collectYamlAnchors(value.key, anchors, seen);
    collectYamlAnchors(value.value, anchors, seen);
    return;
  }
  if (!isNode(value) || seen.has(value)) return;
  seen.add(value);

  if (!isAlias(value) && typeof value.anchor === "string") {
    const declarations = anchors.get(value.anchor);
    const declaration = { node: value, start: sourceStart(value) };
    if (declarations === undefined) {
      anchors.set(value.anchor, [declaration]);
    } else {
      declarations.push(declaration);
    }
  }
  if (isMap(value)) {
    for (const pair of value.items) collectYamlAnchors(pair, anchors, seen);
  } else if (isSeq(value)) {
    for (const item of value.items) collectYamlAnchors(item, anchors, seen);
  }
}

function resolvePrecedingYamlAnchor(
  alias: Node,
  anchors: ReadonlyMap<string, readonly YamlAnchorDeclaration[]>,
): Node | null {
  if (!isAlias(alias)) return null;
  const aliasStart = sourceStart(alias);
  const declarations = anchors.get(alias.source);
  if (aliasStart === null || declarations === undefined) {
    return null;
  }

  let preceding: YamlAnchorDeclaration | undefined;
  let precedingStart = -1;
  for (const declaration of declarations) {
    const declarationStart = declaration.start;
    if (declarationStart === null) {
      return null;
    }

    if (declarationStart < aliasStart && declarationStart > precedingStart) {
      preceding = declaration;
      precedingStart = declarationStart;
    }
  }
  return preceding?.node ?? null;
}

function hasAstCortexFrontmatterClaim(root: unknown): boolean {
  if (!isMap(root)) return false;
  const anchors = new Map<string, YamlAnchorDeclaration[]>();
  collectYamlAnchors(root, anchors, new Set<Node>());

  return root.items.some((pair) => {
    if (isScalar(pair.key)) return isCortexOwnershipKey(pair.key.value);
    if (!isAlias(pair.key)) return false;
    const resolved = resolvePrecedingYamlAnchor(pair.key, anchors);
    // An unresolved top-level alias in malformed frontmatter is ambiguous;
    // fail closed instead of treating a later declaration as its source.
    return resolved === null || (isScalar(resolved) && isCortexOwnershipKey(resolved.value));
  });
}

/**
 * Parsing failure cannot prove a reserved note is unrelated to Cortex. Inspect
 * only the YAML envelope for an ownership key so malformed claims still poison
 * an otherwise valid owned tree without treating body prose as metadata.
 */
function hasLineAnchoredCortexFrontmatterKey(yaml: string): boolean {
  return /(?:^|\n)(?:cortex_tree|cortex_page_id|cortex_parent_page_id|cortex_root_page_id)[\t ]*:/u.test(yaml);
}

function hasRawCortexFrontmatterClaim(bytes: string): boolean {
  const yamlStart = bytes.startsWith("---\r\n")
    ? 5
    : bytes.startsWith("---\n")
      ? 4
      : -1;
  if (yamlStart < 0) return false;

  const remaining = bytes.slice(yamlStart);
  const closing = /(?:^|\n)---(?=\r?\n|$)/u.exec(remaining);
  const yaml = closing === null
    ? remaining
    : remaining.slice(0, closing.index + (closing[0]?.startsWith("\n") ? 1 : 0));

  let astIncomplete = false;
  try {
    const documents = parseAllDocuments(yaml, {
      customTags: [],
      keepSourceTokens: true,
      logLevel: "error",
      merge: false,
      prettyErrors: false,
      resolveKnownTags: false,
      schema: "core",
      strict: false,
      stringKeys: true,
      uniqueKeys: false,
      version: "1.2",
    });
    if (documents.length === 0) {
      astIncomplete = true;
    }
    for (const document of documents) {
      if (document.errors.length > 0) astIncomplete = true;
      if (hasAstCortexFrontmatterClaim(document.contents)) return true;
    }
  } catch {
    astIncomplete = true;
  }

  return astIncomplete && hasLineAnchoredCortexFrontmatterKey(yaml);
}

/**
 * Cortex ownership is an all-or-nothing local trust boundary. Once a valid
 * owned note is present, do not return any owned or child-candidate result
 * until its whole reserved hierarchy proves internally consistent.
 */
function hasValidOwnedCortexTree(preliminaries: readonly CortexScanPreliminary[]): boolean {
  const owned = preliminaries.filter((entry): entry is Extract<CortexScanPreliminary, { readonly kind: "owned" }> => (
    entry.kind === "owned"
  ));
  if (owned.length === 0) return true;

  // A malformed Cortex claim can otherwise hide a duplicate root or page ID.
  if (preliminaries.some((entry) => entry.kind === "invalid" && entry.cortexClaim)) return false;

  const roots = owned.filter((entry) => entry.path === CORTEX_ROOT_FILE_PATH);
  if (roots.length !== 1) return false;
  const root = roots[0];
  if (
    root === undefined ||
    root.cortex.pageId !== root.cortex.rootPageId ||
    root.cortex.parentPageId !== null
  ) {
    return false;
  }

  const byPageId = new Map<string, Extract<CortexScanPreliminary, { readonly kind: "owned" }>>();
  const byPath = new Map<string, Extract<CortexScanPreliminary, { readonly kind: "owned" }>>();
  for (const entry of owned) {
    if (
      entry.cortex.rootPageId !== root.cortex.pageId ||
      byPageId.has(entry.cortex.pageId) ||
      byPath.has(entry.path)
    ) {
      return false;
    }
    byPageId.set(entry.cortex.pageId, entry);
    byPath.set(entry.path, entry);
  }

  for (const entry of owned) {
    if (entry.path === CORTEX_ROOT_FILE_PATH) continue;
    let parentPath: string;
    try {
      parentPath = cortexParentFilePath(entry.path);
    } catch {
      return false;
    }
    const parent = byPath.get(parentPath);
    if (
      parent === undefined ||
      entry.cortex.parentPageId !== parent.cortex.pageId ||
      entry.cortex.parentPageId === entry.cortex.pageId
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Scans only `The Cortex.md` and `The Cortex/**`. It intentionally keeps
 * completely bare local descendants separate from paired ownership so Task 4
 * can decide whether a new remote child is safe to create.
 */
export async function scanCortexVaultNotes(root: CanonicalVaultRoot): Promise<readonly ScannedCortexVaultNote[]> {
  await assertCanonicalRoot(root);
  const paths = [...new Set(await collectCortexCandidates(root))].sort(compareNames);
  const preliminaries: CortexScanPreliminary[] = [];

  for (const path of paths) {
    let bytes: string;
    try {
      bytes = await readBoundedNote(root, path);
    } catch {
      preliminaries.push({ path, kind: "invalid", cortexClaim: false });
      continue;
    }

    try {
      const note = parseLocalNote(path, bytes);
      const inspected = inspectCortexFrontmatter(note);
      if (inspected.kind === "invalid") {
        preliminaries.push({ path, kind: "invalid", cortexClaim: hasCortexFrontmatterKeys(note.frontmatter) });
      } else if (inspected.kind === "owned") {
        preliminaries.push({ path, kind: "owned", note, cortex: inspected.cortex });
      } else if (note.notionSync) {
        // A legacy direct pair under a Cortex parent must never be promoted
        // into a new Cortex child merely because its filesystem parent is paired.
        preliminaries.push({ path, kind: "direct-pair" });
      } else {
        preliminaries.push({ path, kind: "bare", note });
      }
    } catch {
      preliminaries.push({ path, kind: "invalid", cortexClaim: hasRawCortexFrontmatterClaim(bytes) });
    }
  }

  if (!hasValidOwnedCortexTree(preliminaries)) {
    return preliminaries.map((entry) => ({ path: entry.path, kind: "invalid" }));
  }

  const pairedPaths = new Set(
    preliminaries.filter((entry) => entry.kind === "owned").map((entry) => entry.path),
  );
  return preliminaries.map((entry): ScannedCortexVaultNote => {
    if (entry.kind === "owned") return entry;
    if (entry.kind === "invalid" || entry.kind === "direct-pair") return { path: entry.path, kind: "invalid" };
    try {
      const parentPath = cortexParentFilePath(entry.path);
      return pairedPaths.has(parentPath)
        ? { path: entry.path, kind: "candidate", note: entry.note }
        : { path: entry.path, kind: "unpaired", note: entry.note };
    } catch {
      return { path: entry.path, kind: "unpaired", note: entry.note };
    }
  });
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
