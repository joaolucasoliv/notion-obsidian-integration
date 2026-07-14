import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
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
      readonly eligibility: { readonly eligible: true };
      readonly note: ParsedLocalNote;
    }
  | {
      readonly path: string;
      readonly eligibility: Extract<Eligibility, { readonly eligible: false }>;
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

async function collectMarkdownCandidates(
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
      await collectMarkdownCandidates(root, fullPath, segments, candidates);
      continue;
    }
    if (entry.isFile() && /\.md$/i.test(entry.name)) {
      candidates.push(segments.join("/"));
    }
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

function freezeEntry(entry: ScannedVaultNote): ScannedVaultNote {
  Object.freeze(entry.eligibility);
  return Object.freeze(entry);
}

function invalidFrontmatterEntry(path: string): ScannedVaultNote {
  return freezeEntry({ path, eligibility: { eligible: false, reason: "invalid-frontmatter" } });
}

export async function scanVaultNotes(
  root: CanonicalVaultRoot,
): Promise<readonly ScannedVaultNote[]> {
  await assertCanonicalRoot(root);
  const candidates: string[] = [];
  await collectMarkdownCandidates(root, root.canonicalRealPath, [], candidates);
  candidates.sort(compareNames);

  const scanned: ScannedVaultNote[] = [];
  for (const path of candidates) {
    const pathExclusion = classifyPathExclusion(path);
    if (pathExclusion !== null) {
      scanned.push(freezeEntry({ path, eligibility: pathExclusion }));
      continue;
    }

    let bytes: string;
    try {
      bytes = await readBoundedNote(root, path);
    } catch {
      scanned.push(invalidFrontmatterEntry(path));
      continue;
    }

    const managedState = inspectGithubManagedBytes(bytes);
    if (managedState === "generated") {
      scanned.push(
        freezeEntry({ path, eligibility: { eligible: false, reason: "generated-github" } }),
      );
      continue;
    }
    if (managedState === "invalid") {
      scanned.push(invalidFrontmatterEntry(path));
      continue;
    }

    try {
      const note = parseLocalNote(path, bytes);
      const eligibility = classifyEligibility(note);
      if (eligibility.eligible) {
        scanned.push(freezeEntry({ path, eligibility, note }));
      } else {
        scanned.push(freezeEntry({ path, eligibility, note }));
      }
    } catch (caught) {
      if (!(caught instanceof LocalNoteParseError)) {
        throw caught;
      }
      scanned.push(invalidFrontmatterEntry(path));
    }
  }

  return Object.freeze(scanned);
}
