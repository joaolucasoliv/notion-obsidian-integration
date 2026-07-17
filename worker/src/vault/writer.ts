import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  sha256Hex,
  type CortexTreeTransactionPlan,
  type CortexTreeTransactionRecovery,
  type CortexTreeTransactionResult,
} from "@grandbox-bridge/shared";
import {
  CORTEX_ROOT_DIRECTORY_PATH,
  CORTEX_ROOT_FILE_PATH,
} from "../cortex/path.js";
import { MAX_LOCAL_NOTE_BYTES } from "../markdown/frontmatter.js";
import {
  createCortexTreeTransactionManifest,
  parseCortexTreeTransactionManifest,
  parseCortexTreeTransactionPlan,
  type CortexTreeTransactionManifest,
  type CortexTreeTransactionManifestMember,
  type CortexTreeTransactionMoveOperation,
  type CortexTreeTransactionPendingMember,
  type CortexTreeTransactionRollbackPending,
  type CortexTreeTransactionRollbackPendingMember,
} from "./cortex-transaction.js";
import type { CanonicalVaultRoot } from "./safety.js";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_RELATIVE_PATH_BYTES = 1_024;
const MAX_CORTEX_MOVE_LOCK_OWNER_BYTES = 1_024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CORTEX_MOVE_LOCK_SEGMENTS = [".obsidian", "grandbox-bridge", "cortex-move.lock"] as const;
const CORTEX_MOVE_LOCK_OWNER_FILENAME = "owner.json";
const CORTEX_TRANSACTION_ROOT_SEGMENTS = [".obsidian", "grandbox-bridge", "cortex-transactions"] as const;
const CORTEX_TRANSACTION_MANIFEST_FILENAME = "manifest.json";
const MAX_CORTEX_TRANSACTION_MANIFEST_BYTES = 4 * 1024 * 1024;

export interface VaultWriter {
  write(input: {
    readonly relativePath: string;
    readonly expectedByteHash: string;
    readonly content: string;
  }): Promise<Readonly<{ byteHash: string }>>;
  create(input: {
    readonly relativePath: string;
    readonly expectedAbsent: true;
    readonly content: string;
  }): Promise<Readonly<{ byteHash: string }>>;
  moveCortexSubtree(input: CortexSubtreeMoveInput): Promise<Readonly<{ byteHash: string }>>;
}

/**
 * Separate from VaultWriter until the manifest-backed implementation lands.
 * Keeping this capability separate preserves direct-pair writers and current
 * fakes while Task 2 supplies AtomicVaultWriter's concrete implementation.
 */
export interface CortexTreeTransactionWriter {
  applyCortexTreeTransaction(plan: CortexTreeTransactionPlan): Promise<CortexTreeTransactionResult>;
  recoverCortexTreeTransactions(): Promise<CortexTreeTransactionRecovery>;
}

/** Matches the immutable local fields already carried by a Cortex move intent. */
export interface CortexSubtreeMoveInput {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly expectedSourceByteHash: string;
}

/** Narrow test-only synchronization hooks; no runtime configuration consumes these. */
export interface AtomicVaultWriterTestHooks {
  readonly beforeWriteRename?: (paths: Readonly<{ targetPath: string; temporaryPath: string }>) => Promise<void>;
  readonly beforeFinalWriteTargetCheck?: (paths: Readonly<{ targetPath: string; temporaryPath: string }>) => Promise<void>;
  readonly beforeCreateFinalize?: (
    paths: Readonly<{ parentPath: string; targetPath: string; temporaryPath: string }>,
  ) => Promise<void>;
  readonly beforeCortexMoveRename?: (paths: Readonly<{
    sourcePath: string;
    targetPath: string;
    sourceDirectoryPath: string;
    targetDirectoryPath: string;
  }>) => Promise<void>;
  readonly beforeCortexMoveTargetReservation?: (paths: Readonly<{
    sourcePath: string;
    targetPath: string;
    sourceDirectoryPath: string;
    targetDirectoryPath: string;
  }>) => Promise<void>;
  readonly beforeCortexMoveCompanionReservation?: (paths: Readonly<{
    sourcePath: string;
    targetPath: string;
    sourceDirectoryPath: string;
    targetDirectoryPath: string;
  }>) => Promise<void>;
  readonly beforeCortexMoveDirectoryRename?: (paths: Readonly<{
    sourcePath: string;
    targetPath: string;
    sourceDirectoryPath: string;
    targetDirectoryPath: string;
  }>) => Promise<void>;
  readonly syncDirectory?: (directoryPath: string, sync: () => Promise<void>) => Promise<void>;
  readonly syncFile?: (filePath: string, sync: () => Promise<void>) => Promise<void>;
  readonly afterCortexTransactionManifestPersist?: (state: Readonly<{
    transactionId: string;
    phase: "prepared" | "publishing" | "rolling-back" | "committed" | "finalized";
    completedMemberIds: readonly string[];
  }>) => Promise<void>;
  readonly beforeCortexTransactionMember?: (state: Readonly<{
    transactionId: string;
    memberId: string;
    completedMemberIds: readonly string[];
  }>) => Promise<void>;
  readonly afterCortexTransactionMemberPublish?: (state: Readonly<{
    transactionId: string;
    memberId: string;
    completedMemberIds: readonly string[];
  }>) => Promise<void>;
  readonly afterCortexTransactionMember?: (state: Readonly<{
    transactionId: string;
    memberId: string;
    completedMemberIds: readonly string[];
  }>) => Promise<void>;
  readonly beforeCortexTransactionRollback?: (state: Readonly<{
    transactionId: string;
    completedMemberIds: readonly string[];
  }>) => Promise<void>;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface ExistingTarget {
  readonly targetPath: string;
  readonly parentPath: string;
  readonly identity: FileIdentity;
}

interface ReadEvidence extends ExistingTarget {
  readonly byteHash: string;
  readonly content: string;
}

interface TemporaryFile {
  readonly path: string;
  readonly identity: FileIdentity;
}

interface ExistingDirectory {
  readonly directoryPath: string;
  readonly parentPath: string;
  readonly identity: FileIdentity;
}

interface CortexMovePaths {
  readonly sourceFileSegments: readonly string[];
  readonly targetFileSegments: readonly string[];
  readonly sourceDirectorySegments: readonly string[];
  readonly targetDirectorySegments: readonly string[];
}

interface CortexMoveLockOwner {
  readonly schemaVersion: 1;
  readonly ownerToken: string;
  readonly startedAt: string;
}

interface CortexMoveLock {
  readonly directory: ExistingDirectory;
  readonly ownerRecordPath: string;
  readonly ownerToken: string;
}

interface CortexTransactionManifestLocation {
  readonly directory: ExistingDirectory;
  readonly manifestPath: string;
  readonly manifestIdentity: FileIdentity;
  readonly manifestContent: string;
}

interface PrivateTextEvidence {
  readonly path: string;
  readonly parentPath: string;
  readonly identity: FileIdentity;
  readonly content: string;
}

interface CortexPendingMemberPreparation {
  readonly location: CortexTransactionManifestLocation;
  readonly manifest: CortexTreeTransactionManifest;
}

interface CortexPendingRollback {
  readonly restoredWrite: Readonly<{ memberId: string; relativePath: string; identity: FileIdentity }> | null;
  readonly location: CortexTransactionManifestLocation;
  readonly manifest: CortexTreeTransactionManifest;
}

/** Only the legacy direct mover uses these volatile hooks. */
interface CortexDirectMoveWal {
  beforeCompanionReservation(): Promise<void>;
  beforeCompanionRename(reservation: ExistingDirectory): Promise<void>;
  beforeSourceUnlink(): Promise<void>;
}

interface CortexTransactionMemberApplyResult {
  readonly postIdentity: CortexTransactionPostIdentity;
  readonly location: CortexTransactionManifestLocation;
  readonly manifest: CortexTreeTransactionManifest;
}

interface CortexRollbackMemberPreparation {
  readonly location: CortexTransactionManifestLocation;
  readonly manifest: CortexTreeTransactionManifest;
}

type CortexTransactionPostIdentity =
  | Readonly<{ file: Readonly<{ dev: string; ino: string }> }>
  | Readonly<{
    targetFile: Readonly<{ dev: string; ino: string }>;
    targetDirectory: Readonly<{ dev: string; ino: string }> | null;
  }>;

type CortexPendingRecoveryState = "none" | "old" | "published" | "target-linked" | "private-reserved" | "companion-reserved" | "companion-moved";
type CortexPendingWriteMember = Extract<CortexTreeTransactionPendingMember, { kind: "write" }>;
type CortexPendingCreateMember = Extract<CortexTreeTransactionPendingMember, { kind: "create" }>;
type CortexPendingMoveMember = Extract<CortexTreeTransactionPendingMember, { kind: "move" }>;
type CortexRollbackPending = CortexTreeTransactionRollbackPending | CortexTreeTransactionRollbackPendingMember;
type CortexMoveLayout = Extract<CortexPendingRecoveryState, "old" | "published" | "target-linked" | "private-reserved" | "companion-reserved" | "companion-moved">;
type CortexManifestMoveOwner = "forward" | "reverse";

interface CortexManifestMoveExecution {
  readonly location: CortexTransactionManifestLocation;
  readonly manifest: CortexTreeTransactionManifest;
  readonly postIdentity: Extract<CortexTransactionPostIdentity, { readonly targetFile: Readonly<{ dev: string; ino: string }> }> | null;
}

interface CortexManifestMoveLayoutEvidence {
  readonly layout: CortexMoveLayout;
  readonly paths: CortexMovePaths;
  readonly sourceFile: ReadEvidence | null;
  readonly targetFile: ReadEvidence | null;
  readonly sourceDirectory: ExistingDirectory | null;
  readonly targetDirectory: ExistingDirectory | null;
  readonly privateReservation: ExistingDirectory | null;
}

/**
 * A reverse executor can also consume a legacy completed-move identity.  That
 * record predates private reservation identity evidence, so it is never
 * re-serialized as a new WAL operation; it is only used to classify an
 * already-published legacy layout before a reverse checkpoint.
 */
interface CortexMoveExecutionOperation {
  readonly direction: CortexTreeTransactionMoveOperation["direction"];
  readonly stage: CortexTreeTransactionMoveOperation["stage"];
  readonly sourceFileIdentity: Readonly<{ dev: string; ino: string }>;
  readonly targetFileIdentity: Readonly<{ dev: string; ino: string }>;
  readonly sourceCompanionIdentity: Readonly<{ dev: string; ino: string }> | null;
  readonly targetCompanionIdentity: Readonly<{ dev: string; ino: string }> | null;
  readonly reservationIdentity: Readonly<{ dev: string; ino: string }> | null;
}

type CortexMoveLockErrorCode = "active-lock" | "recovery-required";

class CortexMoveLockError extends Error {
  public readonly retryable = false;

  public constructor(public readonly code: CortexMoveLockErrorCode) {
    super("Vault writer failed");
    this.name = "CortexMoveLockError";
  }
}

function vaultWriterError(): Error {
  return new Error("Vault writer failed");
}

function cortexMoveLockError(code: CortexMoveLockErrorCode): CortexMoveLockError {
  return new CortexMoveLockError(code);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isBeneath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw vaultWriterError();
  }
}

function validateRelativePath(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    throw vaultWriterError();
  }
  const segments = value.split("/");
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_RELATIVE_PATH_BYTES ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    /[\r\n]/.test(value) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw vaultWriterError();
  }
  return segments;
}

function validateCortexMovePath(value: unknown): Readonly<{ filePath: string; fileSegments: readonly string[]; directorySegments: readonly string[] }> {
  const fileSegments = validateRelativePath(value);
  const filePath = fileSegments.join("/");
  const fileName = fileSegments.at(-1);
  if (
    filePath === CORTEX_ROOT_FILE_PATH ||
    !filePath.startsWith(`${CORTEX_ROOT_DIRECTORY_PATH}/`) ||
    fileName === undefined ||
    !fileName.endsWith(".md") ||
    fileName.length <= 3
  ) {
    throw vaultWriterError();
  }
  const directoryName = fileName.slice(0, -3);
  if (directoryName === "." || directoryName === ".." || directoryName.length === 0) {
    throw vaultWriterError();
  }
  return {
    filePath,
    fileSegments,
    directorySegments: [...fileSegments.slice(0, -1), directoryName],
  };
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function parseCortexMoveLockOwner(value: unknown): CortexMoveLockOwner | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const owner = value as Record<string, unknown>;
  if (
    Object.keys(owner).length !== 3 ||
    owner.schemaVersion !== 1 ||
    typeof owner.ownerToken !== "string" ||
    !UUID_PATTERN.test(owner.ownerToken) ||
    typeof owner.startedAt !== "string" ||
    owner.startedAt.length > 64
  ) {
    return null;
  }
  const startedAt = new Date(owner.startedAt);
  if (!Number.isFinite(startedAt.getTime()) || startedAt.toISOString() !== owner.startedAt) return null;
  return Object.freeze({ schemaVersion: 1, ownerToken: owner.ownerToken, startedAt: owner.startedAt });
}

function cortexMovePaths(input: CortexSubtreeMoveInput): CortexMovePaths {
  if (typeof input !== "object" || input === null) throw vaultWriterError();
  assertHash(input.expectedSourceByteHash);
  const source = validateCortexMovePath(input.sourcePath);
  const target = validateCortexMovePath(input.targetPath);
  if (
    source.filePath === target.filePath ||
    pathsOverlap(source.directorySegments.join("/"), target.directorySegments.join("/"))
  ) {
    throw vaultWriterError();
  }
  return {
    sourceFileSegments: source.fileSegments,
    targetFileSegments: target.fileSegments,
    sourceDirectorySegments: source.directorySegments,
    targetDirectorySegments: target.directorySegments,
  };
}

function encodeContent(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw vaultWriterError();
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > MAX_LOCAL_NOTE_BYTES) {
    throw vaultWriterError();
  }
  try {
    if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) {
      throw vaultWriterError();
    }
  } catch {
    throw vaultWriterError();
  }
  return bytes;
}

export class AtomicVaultWriter implements VaultWriter, CortexTreeTransactionWriter {
  public constructor(
    private readonly root: CanonicalVaultRoot,
    private readonly testHooks: AtomicVaultWriterTestHooks = {},
  ) {}

  public async write(input: {
    readonly relativePath: string;
    readonly expectedByteHash: string;
    readonly content: string;
  }): Promise<Readonly<{ byteHash: string }>> {
    let temporary: TemporaryFile | undefined;
    try {
      const segments = validateRelativePath(input.relativePath);
      assertHash(input.expectedByteHash);
      const content = encodeContent(input.content);
      const nextByteHash = await sha256Hex(input.content);
      const baseline = await this.readExisting(segments);
      if (baseline.byteHash !== input.expectedByteHash) {
        throw vaultWriterError();
      }

      temporary = await this.createPrivateTemporary(baseline.parentPath, basename(baseline.targetPath), content);
      await this.testHooks.beforeWriteRename?.({
        targetPath: baseline.targetPath,
        temporaryPath: temporary.path,
      });

      const immediatelyBeforeRename = await this.readExisting(segments);
      if (
        immediatelyBeforeRename.byteHash !== input.expectedByteHash ||
        !sameIdentity(baseline.identity, immediatelyBeforeRename.identity)
      ) {
        throw vaultWriterError();
      }
      await this.testHooks.beforeFinalWriteTargetCheck?.({
        targetPath: baseline.targetPath,
        temporaryPath: temporary.path,
      });
      await this.assertOwnedTemporary(temporary);
      const finalBaseline = await this.readExisting(segments);
      if (
        finalBaseline.byteHash !== input.expectedByteHash ||
        !sameIdentity(baseline.identity, finalBaseline.identity)
      ) {
        throw vaultWriterError();
      }
      await rename(temporary.path, finalBaseline.targetPath);
      temporary = undefined;
      await this.syncDirectory(baseline.parentPath);

      const observed = await this.readExisting(segments);
      if (observed.byteHash !== nextByteHash) {
        throw vaultWriterError();
      }
      return Object.freeze({ byteHash: observed.byteHash });
    } catch {
      if (temporary !== undefined) {
        await this.removeOwnedTemporary(temporary).catch(() => undefined);
      }
      throw vaultWriterError();
    }
  }

  public async create(input: {
    readonly relativePath: string;
    readonly expectedAbsent: true;
    readonly content: string;
  }): Promise<Readonly<{ byteHash: string }>> {
    let temporary: TemporaryFile | undefined;
    try {
      if (input.expectedAbsent !== true) {
        throw vaultWriterError();
      }
      const segments = validateRelativePath(input.relativePath);
      const content = encodeContent(input.content);
      const nextByteHash = await sha256Hex(input.content);
      const target = await this.ensureAbsentTarget(segments);
      temporary = await this.createPrivateTemporary(target.parentPath, basename(target.targetPath), content);
      await this.testHooks.beforeCreateFinalize?.({
        parentPath: target.parentPath,
        targetPath: target.targetPath,
        temporaryPath: temporary.path,
      });

      const immediatelyBeforeFinalize = await this.assertAbsentTarget(segments);
      await this.assertOwnedTemporary(temporary);
      await link(temporary.path, immediatelyBeforeFinalize.targetPath);
      const linked = await this.assertExistingTarget(segments);
      if (!sameIdentity(temporary.identity, linked.identity)) {
        throw vaultWriterError();
      }
      await this.syncDirectory(immediatelyBeforeFinalize.parentPath);
      await unlink(temporary.path);
      temporary = undefined;
      await this.syncDirectory(immediatelyBeforeFinalize.parentPath);

      const observed = await this.readExisting(segments);
      if (observed.byteHash !== nextByteHash) {
        throw vaultWriterError();
      }
      return Object.freeze({ byteHash: observed.byteHash });
    } catch {
      if (temporary !== undefined) {
        await this.removeOwnedTemporary(temporary).catch(() => undefined);
      }
      throw vaultWriterError();
    }
  }

  /**
   * Moves `Page.md` and its optional `Page/` descendants as one journal-ready
   * local intent. POSIX cannot rename both siblings atomically, so a normal
   * second-step failure is rolled back before the method reports failure.
   */
  public async moveCortexSubtree(input: CortexSubtreeMoveInput): Promise<Readonly<{ byteHash: string }>> {
    return this.moveCortexSubtreeWithLock(input);
  }

  private async moveCortexSubtreeWhileLocked(
    input: CortexSubtreeMoveInput,
    lock: CortexMoveLock,
    moveWal?: CortexDirectMoveWal,
  ): Promise<Readonly<{ byteHash: string }>> {
    return this.moveCortexSubtreeWithLock(input, lock, moveWal);
  }

  private async moveCortexSubtreeWithLock(
    input: CortexSubtreeMoveInput,
    heldLock?: CortexMoveLock,
    moveWal?: CortexDirectMoveWal,
  ): Promise<Readonly<{ byteHash: string }>> {
    let lock: CortexMoveLock | undefined = heldLock;
    const acquiredLock = heldLock === undefined;
    let paths: CortexMovePaths | undefined;
    let sourceFile: ReadEvidence | undefined;
    let sourceDirectory: ExistingDirectory | null = null;
    let targetFileReserved = false;
    let targetDirectoryReservation: ExistingDirectory | undefined;
    let directoryMoved = false;
    let sourceFileRemoved = false;
    let result: Readonly<{ byteHash: string }> | undefined;
    let operationFailure: Error | undefined;
    try {
      lock = heldLock ?? await this.acquireCortexMoveLock();
      if (!(await this.ownsCortexMoveLock(lock))) throw cortexMoveLockError("recovery-required");
      paths = cortexMovePaths(input);
      sourceFile = await this.readExisting(paths.sourceFileSegments);
      if (sourceFile.byteHash !== input.expectedSourceByteHash) throw vaultWriterError();
      sourceDirectory = await this.optionalExistingDirectory(paths.sourceDirectorySegments);
      await this.assertAbsentTarget(paths.targetFileSegments);
      await this.assertAbsentTarget(paths.targetDirectorySegments);

      const hookPaths = {
        sourcePath: sourceFile.targetPath,
        targetPath: this.targetPaths(paths.targetFileSegments).targetPath,
        sourceDirectoryPath: this.targetPaths(paths.sourceDirectorySegments).targetPath,
        targetDirectoryPath: this.targetPaths(paths.targetDirectorySegments).targetPath,
      };
      await this.testHooks.beforeCortexMoveRename?.(hookPaths);

      const finalSource = await this.readExisting(paths.sourceFileSegments);
      if (
        finalSource.byteHash !== input.expectedSourceByteHash ||
        !sameIdentity(finalSource.identity, sourceFile.identity)
      ) {
        throw vaultWriterError();
      }
      if (sourceDirectory !== null) {
        const finalDirectory = await this.readExistingDirectory(paths.sourceDirectorySegments);
        if (!sameIdentity(finalDirectory.identity, sourceDirectory.identity)) throw vaultWriterError();
      }
      const targetFile = await this.assertAbsentTarget(paths.targetFileSegments);
      await this.assertAbsentTarget(paths.targetDirectorySegments);
      await this.testHooks.beforeCortexMoveTargetReservation?.(hookPaths);
      await link(finalSource.targetPath, targetFile.targetPath);
      targetFileReserved = true;
      await this.syncDirectory(targetFile.parentPath);

      const observed = await this.readExisting(paths.targetFileSegments);
      if (observed.byteHash !== input.expectedSourceByteHash || !sameIdentity(observed.identity, sourceFile.identity)) {
        throw vaultWriterError();
      }

      await moveWal?.beforeCompanionReservation();
      await this.testHooks.beforeCortexMoveCompanionReservation?.(hookPaths);
      const finalSourceDirectory = await this.optionalExistingDirectory(paths.sourceDirectorySegments);
      if (sourceDirectory === null) {
        if (finalSourceDirectory !== null) throw vaultWriterError();
        await this.testHooks.beforeCortexMoveDirectoryRename?.(hookPaths);
        if (await this.optionalExistingDirectory(paths.sourceDirectorySegments) !== null) throw vaultWriterError();
        await this.assertAbsentTarget(paths.targetDirectorySegments);
      } else {
        if (
          finalSourceDirectory === null ||
          !sameIdentity(finalSourceDirectory.identity, sourceDirectory.identity)
        ) {
          throw vaultWriterError();
        }
        targetDirectoryReservation = await this.reserveAbsentDirectory(paths.targetDirectorySegments);
        await this.syncDirectory(targetDirectoryReservation.parentPath);
        await moveWal?.beforeCompanionRename(targetDirectoryReservation);
        await this.testHooks.beforeCortexMoveDirectoryRename?.(hookPaths);

        const immediatelyBeforeDirectoryMove = await this.readExistingDirectory(paths.sourceDirectorySegments);
        if (!sameIdentity(immediatelyBeforeDirectoryMove.identity, sourceDirectory.identity)) throw vaultWriterError();
        await this.assertOwnedEmptyDirectoryReservation(targetDirectoryReservation);
        await rename(immediatelyBeforeDirectoryMove.directoryPath, targetDirectoryReservation.directoryPath);
        directoryMoved = true;
        await this.syncDirectory(immediatelyBeforeDirectoryMove.parentPath);
        await this.syncDirectory(targetDirectoryReservation.parentPath);
      }

      const finalTarget = await this.readExisting(paths.targetFileSegments);
      if (finalTarget.byteHash !== input.expectedSourceByteHash || !sameIdentity(finalTarget.identity, sourceFile.identity)) {
        throw vaultWriterError();
      }
      if (sourceDirectory !== null) {
        const observedDirectory = await this.readExistingDirectory(paths.targetDirectorySegments);
        if (!sameIdentity(observedDirectory.identity, sourceDirectory.identity)) throw vaultWriterError();
        if (await this.optionalExistingDirectory(paths.sourceDirectorySegments) !== null) throw vaultWriterError();
      } else {
        if (await this.optionalExistingDirectory(paths.sourceDirectorySegments) !== null) throw vaultWriterError();
        await this.assertAbsentTarget(paths.targetDirectorySegments);
      }

      const sourceBeforeCommit = await this.readExisting(paths.sourceFileSegments);
      if (
        sourceBeforeCommit.byteHash !== input.expectedSourceByteHash ||
        !sameIdentity(sourceBeforeCommit.identity, sourceFile.identity)
      ) {
        throw vaultWriterError();
      }
      await moveWal?.beforeSourceUnlink();
      await unlink(sourceBeforeCommit.targetPath);
      sourceFileRemoved = true;
      await this.syncDirectory(sourceBeforeCommit.parentPath);
      result = Object.freeze({ byteHash: finalTarget.byteHash });
    } catch (caught) {
      if (paths !== undefined && sourceFile !== undefined) {
        await this.rollbackCortexSubtreeMove({
          paths,
          sourceFile,
          sourceDirectory,
          targetFileReserved,
          targetDirectoryReservation,
          directoryMoved,
          sourceFileRemoved,
        }).catch(() => undefined);
      }
      operationFailure = caught instanceof CortexMoveLockError ? caught : vaultWriterError();
    }

    if (lock !== undefined && acquiredLock) {
      await this.releaseCortexMoveLock(lock);
    }
    if (operationFailure !== undefined) throw operationFailure;
    if (result === undefined) throw vaultWriterError();
    return result;
  }

  public async applyCortexTreeTransaction(plan: CortexTreeTransactionPlan): Promise<CortexTreeTransactionResult> {
    const parsed = await parseCortexTreeTransactionPlan(plan);
    const initial = await this.createPreparedCortexTransactionManifest(parsed);
    const lock = await this.acquireCortexMoveLock();
    let result: CortexTreeTransactionResult;
    try {
      result = await this.applyCortexTreeTransactionWhileLocked(parsed, initial, lock);
    } catch {
      result = this.cortexTransactionResult(initial, "recovery-required");
    }
    try {
      await this.releaseCortexMoveLock(lock);
    } catch {
      return this.cortexTransactionResult(initial, "recovery-required");
    }
    return result;
  }

  public async recoverCortexTreeTransactions(): Promise<CortexTreeTransactionRecovery> {
    const lock = await this.acquireCortexMoveLock();
    try {
      const root = await this.optionalCortexTransactionRoot();
      if (root === null) return Object.freeze({ transactions: Object.freeze([]) });

      const entries = await readdir(root.directoryPath, { withFileTypes: true });
      const transactions: CortexTreeTransactionResult[] = [];
      for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID_PATTERN.test(entry.name)) {
          throw cortexMoveLockError("recovery-required");
        }
        let manifest: CortexTreeTransactionManifest | undefined;
        try {
          const location = await this.readCortexTransactionLocation(entry.name);
          manifest = await this.readCortexTransactionManifest(location);
          transactions.push(await this.recoverCortexTransactionWhileLocked(location, manifest, lock));
        } catch {
          transactions.push(manifest === undefined
            ? this.unknownCortexTransactionRecovery(entry.name)
            : this.cortexTransactionResult(manifest, "recovery-required"));
        }
      }
      return Object.freeze({ transactions: Object.freeze(transactions) });
    } finally {
      await this.releaseCortexMoveLock(lock);
    }
  }

  private async applyCortexTreeTransactionWhileLocked(
    plan: CortexTreeTransactionPlan,
    prepared: CortexTreeTransactionManifest,
    lock: CortexMoveLock,
  ): Promise<CortexTreeTransactionResult> {
    let location: CortexTransactionManifestLocation | undefined;
    let manifest = prepared;
    try {
      await this.assertCortexMoveLockOwnership(lock);
      const preimages = await this.captureCortexTransactionPreimages(plan);
      const directory = await this.createCortexTransactionDirectory(plan.transactionId);
      for (const [memberId, content] of preimages) {
        await this.createPrivateTextArtifact(directory, `${memberId}.preimage`, content);
      }
      location = await this.createCortexTransactionManifest(directory, manifest);
      manifest = await this.manifestWithPhase(manifest, "publishing", manifest.completedMemberIds);
      location = await this.persistCortexTransactionManifest(location, manifest);

      for (let index = 0; index < plan.members.length; index += 1) {
        const member = plan.members[index]!;
        await this.assertCortexMoveLockOwnership(lock);
        if (location === undefined) throw vaultWriterError();
        const preparation = await this.prepareCortexTransactionMemberWhileLocked(location, manifest, member, lock);
        location = preparation.location;
        manifest = preparation.manifest;
        await this.testHooks.beforeCortexTransactionMember?.({
          transactionId: plan.transactionId,
          memberId: member.memberId,
          completedMemberIds: manifest.completedMemberIds,
        });
        const applied = await this.applyCortexTransactionMemberWhileLocked(member, manifest, location, lock);
        location = applied.location;
        manifest = applied.manifest;
        await this.testHooks.afterCortexTransactionMemberPublish?.({
          transactionId: plan.transactionId,
          memberId: member.memberId,
          completedMemberIds: manifest.completedMemberIds,
        });
        manifest = await this.manifestWithCompletion(manifest, member.memberId, applied.postIdentity);
        location = await this.persistCortexTransactionManifest(location, manifest);
        await this.testHooks.afterCortexTransactionMember?.({
          transactionId: plan.transactionId,
          memberId: member.memberId,
          completedMemberIds: manifest.completedMemberIds,
        });
      }
      return this.cortexTransactionResult(manifest, "committed");
    } catch {
      if (location !== undefined) {
        try {
          location = await this.readCortexTransactionLocation(manifest.transactionId);
          manifest = await this.readCortexTransactionManifest(location);
        } catch {
          // The failure below remains fail-closed if the newest durable checkpoint cannot be reread.
        }
      }
      if (location === undefined) return this.cortexTransactionResult(manifest, "recovery-required");
      await this.testHooks.beforeCortexTransactionRollback?.({
        transactionId: manifest.transactionId,
        completedMemberIds: manifest.completedMemberIds,
      }).catch(() => undefined);
      if (await this.rollbackCortexTransactionManifestWhileLocked(location, manifest, lock)) {
        return this.cortexTransactionResult(manifest, "rolled-back");
      }
      return this.cortexTransactionResult(manifest, "recovery-required");
    }
  }

  private async recoverCortexTransactionWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    lock: CortexMoveLock,
  ): Promise<CortexTreeTransactionResult> {
    await this.assertCortexMoveLockOwnership(lock);
    if (manifest.phase === "committed" || manifest.phase === "finalized") {
      return (await this.verifyCortexTransactionPostconditions(manifest, location))
        ? this.cortexTransactionResult(manifest, "committed")
        : this.cortexTransactionResult(manifest, "recovery-required");
    }
    if (manifest.phase === "prepared" && !(await this.verifyCortexTransactionPreconditions(manifest, location))) {
      return this.cortexTransactionResult(manifest, "recovery-required");
    }
    if (await this.rollbackCortexTransactionManifestWhileLocked(location, manifest, lock)) {
      return this.cortexTransactionResult(manifest, "rolled-back");
    }
    return this.cortexTransactionResult(manifest, "recovery-required");
  }

  private cortexTransactionResult(
    manifest: CortexTreeTransactionManifest,
    status: CortexTreeTransactionResult["status"],
  ): CortexTreeTransactionResult {
    return Object.freeze({
      transactionId: manifest.transactionId,
      rootPageId: manifest.rootPageId,
      manifestDigest: manifest.manifestDigest,
      status,
      completedMemberIds: Object.freeze(status === "rolled-back" ? [] : [...manifest.completedMemberIds]),
      error: status === "recovery-required" ? Object.freeze({ code: "recovery-required" as const, retryable: false }) : null,
    });
  }

  private unknownCortexTransactionRecovery(transactionId: string): CortexTreeTransactionResult {
    return Object.freeze({
      transactionId,
      rootPageId: "",
      manifestDigest: "",
      status: "recovery-required",
      completedMemberIds: Object.freeze([]),
      error: Object.freeze({ code: "recovery-required" as const, retryable: false }),
    });
  }

  private async createPreparedCortexTransactionManifest(
    plan: CortexTreeTransactionPlan,
  ): Promise<CortexTreeTransactionManifest> {
    return createCortexTreeTransactionManifest({
      schemaVersion: 1,
      transactionId: plan.transactionId,
      rootPageId: plan.rootPageId,
      participantIds: plan.participantIds,
      phase: "prepared",
      completedMemberIds: [],
      pendingMember: null,
      rollbackPending: null,
      members: plan.members.map((member) => {
        if (member.kind === "write") {
          return {
            memberId: member.memberId,
            kind: member.kind,
            relativePath: member.relativePath,
            expectedByteHash: member.expectedByteHash,
            resultByteHash: member.resultByteHash,
            preimageFile: `${member.memberId}.preimage`,
          };
        }
        if (member.kind === "create") {
          return {
            memberId: member.memberId,
            kind: member.kind,
            relativePath: member.relativePath,
            expectedAbsent: true,
            resultByteHash: member.resultByteHash,
            preimageFile: null,
          };
        }
        return {
          memberId: member.memberId,
          kind: member.kind,
          sourcePath: member.sourcePath,
          targetPath: member.targetPath,
          expectedSourceByteHash: member.expectedSourceByteHash,
          resultByteHash: member.expectedSourceByteHash,
          preimageFile: `${member.memberId}.preimage`,
        };
      }),
    });
  }

  private async captureCortexTransactionPreimages(plan: CortexTreeTransactionPlan): Promise<ReadonlyMap<string, string>> {
    const preimages = new Map<string, string>();
    for (let index = 0; index < plan.members.length; index += 1) {
      const member = plan.members[index]!;
      if (member.kind === "create") {
        await this.assertAbsentTarget(validateRelativePath(member.relativePath));
        continue;
      }
      if (member.kind === "move") {
        await this.assertCortexTransactionMemberPrecondition(member);
        const source = await this.readExisting(cortexMovePaths({
          sourcePath: member.sourcePath,
          targetPath: member.targetPath,
          expectedSourceByteHash: member.expectedSourceByteHash,
        }).sourceFileSegments);
        if (source.byteHash !== member.expectedSourceByteHash) throw vaultWriterError();
        preimages.set(member.memberId, source.content);
        continue;
      }
      const source = await this.readCortexWritePreimageSource(plan.members, index, member.relativePath);
      if (source.byteHash !== member.expectedByteHash) throw vaultWriterError();
      preimages.set(member.memberId, source.content);
    }
    return preimages;
  }

  private async readCortexWritePreimageSource(
    members: readonly (CortexTreeTransactionPlan["members"][number] | CortexTreeTransactionManifestMember)[],
    index: number,
    relativePath: string,
  ): Promise<ReadEvidence> {
    try {
      return await this.readExisting(validateRelativePath(relativePath));
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw vaultWriterError();
      const sourcePath = this.cortexPreMoveSourcePath(members, index, relativePath);
      if (sourcePath === null) throw vaultWriterError();
      return this.readExisting(validateRelativePath(sourcePath));
    }
  }

  private cortexPreMoveSourcePath(
    members: readonly (CortexTreeTransactionPlan["members"][number] | CortexTreeTransactionManifestMember)[],
    index: number,
    relativePath: string,
  ): string | null {
    for (let prior = index - 1; prior >= 0; prior -= 1) {
      const member = members[prior]!;
      if (member.kind !== "move") continue;
      if (relativePath === member.targetPath) return member.sourcePath;
      const targetDirectory = member.targetPath.slice(0, -3);
      const sourceDirectory = member.sourcePath.slice(0, -3);
      if (relativePath.startsWith(`${targetDirectory}/`)) {
        return `${sourceDirectory}${relativePath.slice(targetDirectory.length)}`;
      }
    }
    return null;
  }

  private async assertCortexTransactionMemberPrecondition(
    member: CortexTreeTransactionPlan["members"][number],
  ): Promise<void> {
    if (member.kind === "write") {
      const current = await this.readExisting(validateRelativePath(member.relativePath));
      if (current.byteHash !== member.expectedByteHash) throw vaultWriterError();
      return;
    }
    if (member.kind === "create") {
      if (member.expectedAbsent !== true) throw vaultWriterError();
      await this.assertAbsentTarget(validateRelativePath(member.relativePath));
      return;
    }
    const paths = cortexMovePaths({
      sourcePath: member.sourcePath,
      targetPath: member.targetPath,
      expectedSourceByteHash: member.expectedSourceByteHash,
    });
    const source = await this.readExisting(paths.sourceFileSegments);
    if (source.byteHash !== member.expectedSourceByteHash) throw vaultWriterError();
    await this.optionalExistingDirectory(paths.sourceDirectorySegments);
    await this.assertAbsentTarget(paths.targetFileSegments);
    await this.assertAbsentTarget(paths.targetDirectorySegments);
  }

  private async assertCortexPendingMemberPrecondition(
    member: CortexTreeTransactionPlan["members"][number],
    pending: CortexTreeTransactionPendingMember,
  ): Promise<void> {
    if (pending.memberId !== member.memberId || pending.kind !== member.kind) throw vaultWriterError();
    if (member.kind === "write") {
      if (pending.kind !== "write") throw vaultWriterError();
      const current = await this.readExisting(validateRelativePath(member.relativePath));
      if (
        current.byteHash !== member.expectedByteHash ||
        !this.matchesCortexIdentity(pending.preIdentity, current.identity)
      ) {
        throw vaultWriterError();
      }
      return;
    }
    if (member.kind === "create") {
      if (pending.kind !== "create") throw vaultWriterError();
      if (pending.preIdentity !== null || member.expectedAbsent !== true) throw vaultWriterError();
      await this.assertAbsentTarget(validateRelativePath(member.relativePath));
      return;
    }
    if (pending.kind !== "move") throw vaultWriterError();
    const operation = this.cortexMoveOperationFromPending(pending);
    if (operation === null || operation.direction !== "forward" || operation.stage !== "pre-link") {
      throw vaultWriterError();
    }
    const paths = cortexMovePaths({
      sourcePath: member.sourcePath,
      targetPath: member.targetPath,
      expectedSourceByteHash: member.expectedSourceByteHash,
    });
    const source = await this.readExisting(paths.sourceFileSegments);
    const sourceDirectory = await this.optionalExistingDirectory(paths.sourceDirectorySegments);
    if (
      source.byteHash !== member.expectedSourceByteHash ||
      !this.matchesCortexIdentity(operation.sourceFileIdentity, source.identity) ||
      (operation.sourceCompanionIdentity === null
        ? sourceDirectory !== null
        : sourceDirectory === null || !this.matchesCortexIdentity(operation.sourceCompanionIdentity, sourceDirectory.identity))
    ) {
      throw vaultWriterError();
    }
    await this.assertAbsentTarget(paths.targetFileSegments);
    await this.assertAbsentTarget(paths.targetDirectorySegments);
  }

  private async prepareCortexTransactionMemberWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    member: CortexTreeTransactionPlan["members"][number],
    lock: CortexMoveLock,
  ): Promise<CortexPendingMemberPreparation> {
    if (manifest.phase !== "publishing" || manifest.pendingMember !== null) throw vaultWriterError();
    await this.assertCortexMoveLockOwnership(lock);
    await this.assertCortexTransactionMemberPrecondition(member);

    if (member.kind === "move") {
      const paths = cortexMovePaths({
        sourcePath: member.sourcePath,
        targetPath: member.targetPath,
        expectedSourceByteHash: member.expectedSourceByteHash,
      });
      const source = await this.readExisting(paths.sourceFileSegments);
      const sourceDirectory = await this.optionalExistingDirectory(paths.sourceDirectorySegments);
      if (source.byteHash !== member.expectedSourceByteHash) throw vaultWriterError();
      const pending = this.forwardCortexMovePendingMember(member.memberId, source.identity, sourceDirectory?.identity ?? null);
      const pendingManifest = await this.manifestWithPending(manifest, pending);
      return Object.freeze({
        manifest: pendingManifest,
        location: await this.persistCortexTransactionManifest(location, pendingManifest),
      });
    }

    let reserved: CortexPendingWriteMember | CortexPendingCreateMember;
    if (member.kind === "write") {
      const current = await this.readExisting(validateRelativePath(member.relativePath));
      if (current.byteHash !== member.expectedByteHash) {
        throw vaultWriterError();
      }
      reserved = Object.freeze({
        memberId: member.memberId,
        kind: "write",
        state: "reserved",
        preIdentity: this.cortexIdentity(current.identity),
        postIdentity: null,
      });
    } else {
      reserved = Object.freeze({
        memberId: member.memberId,
        kind: "create",
        state: "reserved",
        preIdentity: null,
        postIdentity: null,
      });
    }
    let pendingManifest = await this.manifestWithPending(manifest, reserved);
    let pendingLocation = await this.persistCortexTransactionManifest(location, pendingManifest);
    await this.assertCortexMoveLockOwnership(lock);
    await this.assertCortexPendingMemberPrecondition(member, reserved);
    const staged = await this.createPrivateTextArtifact(
      pendingLocation.directory,
      this.cortexPendingArtifactName(member.memberId),
      member.content,
    );
    const ready: CortexTreeTransactionPendingMember = reserved.kind === "write"
      ? Object.freeze({
        ...reserved,
        state: "ready",
        postIdentity: Object.freeze({ file: this.cortexIdentity(staged.identity) }),
      })
      : Object.freeze({
        ...reserved,
        state: "ready",
        postIdentity: Object.freeze({ file: this.cortexIdentity(staged.identity) }),
      });
    pendingManifest = await this.manifestWithPending(manifest, ready);
    pendingLocation = await this.persistCortexTransactionManifest(pendingLocation, pendingManifest);
    return Object.freeze({ manifest: pendingManifest, location: pendingLocation });
  }

  private async applyCortexTransactionMemberWhileLocked(
    member: CortexTreeTransactionPlan["members"][number],
    manifest: CortexTreeTransactionManifest,
    location: CortexTransactionManifestLocation,
    lock: CortexMoveLock,
  ): Promise<CortexTransactionMemberApplyResult> {
    const pending = manifest.pendingMember;
    if (
      pending === null ||
      pending.memberId !== member.memberId ||
      pending.kind !== member.kind ||
      (pending.kind !== "move" && (pending.state !== "ready" || pending.postIdentity === null))
    ) {
      throw vaultWriterError();
    }
    await this.assertCortexMoveLockOwnership(lock);
    await this.assertCortexPendingMemberPrecondition(member, pending);
    if (member.kind === "write") {
      if (pending.kind !== "write" || pending.postIdentity === null || !("file" in pending.postIdentity)) {
        throw vaultWriterError();
      }
      const pendingPostIdentity = pending.postIdentity;
      const staged = await this.readPrivateTextArtifact(
        location.directory,
        this.cortexPendingArtifactName(member.memberId),
        MAX_LOCAL_NOTE_BYTES,
      );
      if (
        await sha256Hex(staged.content) !== member.resultByteHash ||
        !this.matchesCortexIdentity(pendingPostIdentity.file, staged.identity)
      ) {
        throw vaultWriterError();
      }
      const baseline = await this.readExisting(validateRelativePath(member.relativePath));
      if (
        baseline.byteHash !== member.expectedByteHash ||
        !this.matchesCortexIdentity(pending.preIdentity, baseline.identity)
      ) {
        throw vaultWriterError();
      }
      await rename(staged.path, baseline.targetPath);
      await this.syncDirectory(staged.parentPath);
      await this.syncDirectory(baseline.parentPath);
      const observed = await this.readExisting(validateRelativePath(member.relativePath));
      if (
        observed.byteHash !== member.resultByteHash ||
        !this.matchesCortexIdentity(pendingPostIdentity.file, observed.identity)
      ) {
        throw vaultWriterError();
      }
      await this.assertCortexMoveLockOwnership(lock);
      return Object.freeze({
        postIdentity: Object.freeze({ file: this.cortexIdentity(observed.identity) }),
        location,
        manifest,
      });
    }
    if (member.kind === "create") {
      if (pending.kind !== "create" || pending.postIdentity === null || !("file" in pending.postIdentity)) {
        throw vaultWriterError();
      }
      const pendingPostIdentity = pending.postIdentity;
      const staged = await this.readPrivateTextArtifact(
        location.directory,
        this.cortexPendingArtifactName(member.memberId),
        MAX_LOCAL_NOTE_BYTES,
      );
      if (
        await sha256Hex(staged.content) !== member.resultByteHash ||
        !this.matchesCortexIdentity(pendingPostIdentity.file, staged.identity)
      ) {
        throw vaultWriterError();
      }
      const target = await this.assertAbsentTarget(validateRelativePath(member.relativePath));
      await link(staged.path, target.targetPath);
      await this.syncDirectory(target.parentPath);
      const observed = await this.readExisting(validateRelativePath(member.relativePath));
      if (
        observed.byteHash !== member.resultByteHash ||
        !this.matchesCortexIdentity(pendingPostIdentity.file, observed.identity)
      ) {
        throw vaultWriterError();
      }
      await unlink(staged.path);
      await this.syncDirectory(staged.parentPath);
      await this.assertCortexMoveLockOwnership(lock);
      return Object.freeze({
        postIdentity: Object.freeze({ file: this.cortexIdentity(observed.identity) }),
        location,
        manifest,
      });
    }
    if (pending.kind !== "move") throw vaultWriterError();
    const operation = this.cortexMoveOperationFromPending(pending);
    if (operation === null || operation.direction !== "forward") throw vaultWriterError();
    const executed = await this.executeCortexManifestMoveWhileLocked(location, manifest, "forward", operation, lock);
    if (executed.postIdentity === null) throw vaultWriterError();
    return Object.freeze({
      postIdentity: executed.postIdentity,
      location: executed.location,
      manifest: executed.manifest,
    });
  }

  private async manifestWithPhase(
    manifest: CortexTreeTransactionManifest,
    phase: CortexTreeTransactionManifest["phase"],
    completedMemberIds: readonly string[],
  ): Promise<CortexTreeTransactionManifest> {
    return createCortexTreeTransactionManifest({
      schemaVersion: manifest.schemaVersion,
      transactionId: manifest.transactionId,
      rootPageId: manifest.rootPageId,
      participantIds: manifest.participantIds,
      phase,
      completedMemberIds,
      pendingMember: manifest.pendingMember,
      ...this.cortexRollbackWalFields(manifest, "preserve"),
      members: manifest.members,
    });
  }

  private async manifestWithRollingBack(
    manifest: CortexTreeTransactionManifest,
    restoredWrite: CortexPendingRollback["restoredWrite"] = null,
  ): Promise<CortexTreeTransactionManifest> {
    if (
      (manifest.phase !== "prepared" && manifest.phase !== "publishing" && manifest.phase !== "committed") ||
      this.activeCortexRollbackPending(manifest) !== null
    ) {
      throw vaultWriterError();
    }
    const members = restoredWrite === null
      ? manifest.members
      : manifest.members.map((member) => {
        if (member.memberId !== restoredWrite.memberId) return member;
        if (member.kind !== "write" || member.relativePath !== restoredWrite.relativePath || member.postIdentity !== undefined) {
          throw vaultWriterError();
        }
        return {
          ...member,
          rollbackRestoredIdentity: { file: this.cortexIdentity(restoredWrite.identity) },
        };
      });
    return createCortexTreeTransactionManifest({
      schemaVersion: manifest.schemaVersion,
      transactionId: manifest.transactionId,
      rootPageId: manifest.rootPageId,
      participantIds: manifest.participantIds,
      phase: "rolling-back",
      completedMemberIds: manifest.completedMemberIds,
      pendingMember: null,
      ...this.cortexRollbackWalFields(manifest, "clear"),
      members,
    });
  }

  private async manifestWithRollbackPending(
    manifest: CortexTreeTransactionManifest,
    rollbackPending: CortexTreeTransactionRollbackPendingMember,
  ): Promise<CortexTreeTransactionManifest> {
    const current = manifest.members[manifest.completedMemberIds.length - 1];
    if (
      manifest.phase !== "rolling-back" ||
      manifest.pendingMember !== null ||
      this.activeCortexRollbackPending(manifest) !== null ||
      current === undefined ||
      current.memberId !== rollbackPending.memberId ||
      current.kind !== rollbackPending.kind ||
      current.postIdentity === undefined
    ) {
      throw vaultWriterError();
    }
    return createCortexTreeTransactionManifest({
      schemaVersion: manifest.schemaVersion,
      transactionId: manifest.transactionId,
      rootPageId: manifest.rootPageId,
      participantIds: manifest.participantIds,
      phase: "rolling-back",
      completedMemberIds: manifest.completedMemberIds,
      pendingMember: null,
      // This is a fresh reverse intent, not legacy recovery.  It must always
      // use the expanded WAL even if the transaction began before this field
      // was introduced; legacy records are only read and resumed below.
      rollbackPendingMember: rollbackPending,
      members: manifest.members,
    });
  }

  private async manifestWithRollbackProgress(
    manifest: CortexTreeTransactionManifest,
  ): Promise<CortexTreeTransactionManifest> {
    const rollbackPending = this.activeCortexRollbackPending(manifest);
    const currentIndex = manifest.completedMemberIds.length - 1;
    const current = manifest.members[currentIndex];
    if (
      manifest.phase !== "rolling-back" ||
      manifest.pendingMember !== null ||
      rollbackPending === null ||
      current === undefined ||
      current.memberId !== rollbackPending.memberId ||
      current.kind !== rollbackPending.kind ||
      current.postIdentity === undefined
    ) {
      throw vaultWriterError();
    }
    const restoredMoveIndex = current.kind === "write" && rollbackPending.kind === "write"
      ? this.latestCompletedCortexMoveForTarget(manifest, currentIndex, current.relativePath)
      : -1;
    const members = manifest.members.map((member, index) => {
      if (index === restoredMoveIndex) {
        if (member.kind !== "move" || member.postIdentity === undefined || rollbackPending.kind !== "write") {
          throw vaultWriterError();
        }
        // A later write may have replaced a moved page with a different
        // inode.  Once that write is restored, the completed move's durable
        // target evidence must follow the restored inode so its expanded
        // reverse WAL can remain identity-exact.
        return Object.freeze({
          ...member,
          postIdentity: Object.freeze({
            ...member.postIdentity,
            targetFile: rollbackPending.intendedOldIdentity.file,
          }),
        });
      }
      if (index !== currentIndex) return member;
      if (member.kind === "write") {
        if (rollbackPending.kind !== "write") throw vaultWriterError();
        const { postIdentity: _postIdentity, rollbackRestoredIdentity: _restored, ...withoutPostIdentity } = member;
        return {
          ...withoutPostIdentity,
          rollbackRestoredIdentity: { file: rollbackPending.intendedOldIdentity.file },
        };
      }
      const { postIdentity: _postIdentity, ...withoutPostIdentity } = member;
      return withoutPostIdentity;
    });
    return createCortexTreeTransactionManifest({
      schemaVersion: manifest.schemaVersion,
      transactionId: manifest.transactionId,
      rootPageId: manifest.rootPageId,
      participantIds: manifest.participantIds,
      phase: "rolling-back",
      completedMemberIds: manifest.completedMemberIds.slice(0, -1),
      pendingMember: null,
      ...this.cortexRollbackWalFields(manifest, "clear"),
      members,
    });
  }

  private latestCompletedCortexMoveForTarget(
    manifest: CortexTreeTransactionManifest,
    beforeIndex: number,
    targetPath: string,
  ): number {
    for (let index = beforeIndex - 1; index >= 0; index -= 1) {
      const member = manifest.members[index]!;
      if (member.kind === "move" && member.targetPath === targetPath && member.postIdentity !== undefined) {
        return index;
      }
    }
    return -1;
  }

  private async manifestWithPending(
    manifest: CortexTreeTransactionManifest,
    pendingMember: CortexTreeTransactionPendingMember,
  ): Promise<CortexTreeTransactionManifest> {
    const nextMember = manifest.members[manifest.completedMemberIds.length];
    if (
      manifest.phase !== "publishing" ||
      manifest.pendingMember !== null ||
      nextMember === undefined ||
      nextMember.memberId !== pendingMember.memberId ||
      nextMember.kind !== pendingMember.kind
    ) {
      throw vaultWriterError();
    }
    return createCortexTreeTransactionManifest({
      schemaVersion: manifest.schemaVersion,
      transactionId: manifest.transactionId,
      rootPageId: manifest.rootPageId,
      participantIds: manifest.participantIds,
      phase: "publishing",
      completedMemberIds: manifest.completedMemberIds,
      pendingMember,
      ...this.cortexRollbackWalFields(manifest, "clear"),
      members: manifest.members,
    });
  }

  private async manifestWithMoveOperation(
    manifest: CortexTreeTransactionManifest,
    operation: CortexTreeTransactionMoveOperation,
  ): Promise<CortexTreeTransactionManifest> {
    const pending = manifest.pendingMember;
    if (
      manifest.phase !== "publishing" ||
      pending === null ||
      pending.kind !== "move" ||
      this.cortexMoveOperationFromPending(pending) === null
    ) {
      throw vaultWriterError();
    }
    return createCortexTreeTransactionManifest({
      schemaVersion: manifest.schemaVersion,
      transactionId: manifest.transactionId,
      rootPageId: manifest.rootPageId,
      participantIds: manifest.participantIds,
      phase: "publishing",
      completedMemberIds: manifest.completedMemberIds,
      pendingMember: this.cortexMovePendingMember(pending.memberId, operation),
      ...this.cortexRollbackWalFields(manifest, "clear"),
      members: manifest.members,
    });
  }

  private async manifestWithRollbackMoveOperation(
    manifest: CortexTreeTransactionManifest,
    operation: CortexTreeTransactionMoveOperation,
  ): Promise<CortexTreeTransactionManifest> {
    const rollback = this.activeCortexRollbackPending(manifest);
    if (
      manifest.phase !== "rolling-back" ||
      manifest.pendingMember !== null ||
      rollback === null ||
      rollback.kind !== "move"
    ) {
      throw vaultWriterError();
    }
    const replacement: CortexTreeTransactionRollbackPendingMember = Object.freeze({
      memberId: rollback.memberId,
      kind: "move",
      moveOperation: operation,
    });
    return createCortexTreeTransactionManifest({
      schemaVersion: manifest.schemaVersion,
      transactionId: manifest.transactionId,
      rootPageId: manifest.rootPageId,
      participantIds: manifest.participantIds,
      phase: "rolling-back",
      completedMemberIds: manifest.completedMemberIds,
      pendingMember: null,
      ...this.cortexRollbackWalFields(manifest, "replace", replacement),
      members: manifest.members,
    });
  }

  private async manifestWithCompletion(
    manifest: CortexTreeTransactionManifest,
    memberId: string,
    postIdentity: CortexTransactionPostIdentity,
  ): Promise<CortexTreeTransactionManifest> {
    const index = manifest.members.findIndex((member) => member.memberId === memberId);
    const pending = manifest.pendingMember;
    const moveOperation = pending !== null && pending.kind === "move"
      ? this.cortexMoveOperationFromPending(pending)
      : null;
    if (
      index < 0 ||
      index !== manifest.completedMemberIds.length ||
      manifest.completedMemberIds.includes(memberId) ||
      pending === null ||
      pending.memberId !== memberId ||
      (pending.kind === "move"
        ? moveOperation === null || moveOperation.direction !== "forward" || moveOperation.stage !== "source-unlinked"
        : pending.state !== "ready" || pending.postIdentity === null)
    ) {
      throw vaultWriterError();
    }
    const members = manifest.members.map((member) => {
      if (member.memberId !== memberId) return member;
      if (member.kind === "move") {
        if (
          pending.kind !== "move" ||
          !("targetFile" in postIdentity) ||
          moveOperation === null ||
          !this.sameCortexIdentityEvidence(moveOperation.targetFileIdentity, postIdentity.targetFile) ||
          !this.sameNullableCortexIdentityEvidence(moveOperation.targetCompanionIdentity, postIdentity.targetDirectory)
        ) {
          throw vaultWriterError();
        }
        return Object.freeze({
          ...member,
          postIdentity: Object.freeze({
            targetFile: moveOperation.targetFileIdentity,
            targetDirectory: moveOperation.targetCompanionIdentity,
          }),
        });
      }
      const pendingPostIdentity = (pending.kind === "write" || pending.kind === "create")
        ? pending.postIdentity
        : null;
      if (
        (pending.kind !== "write" && pending.kind !== "create") ||
        pendingPostIdentity === null ||
        !("file" in postIdentity) ||
        !("file" in pendingPostIdentity) ||
        !this.sameCortexIdentityEvidence(pendingPostIdentity.file, postIdentity.file)
      ) {
        throw vaultWriterError();
      }
      return Object.freeze({ ...member, postIdentity: Object.freeze({ file: pendingPostIdentity.file }) });
    });
    const completedMemberIds = [...manifest.completedMemberIds, memberId];
    return createCortexTreeTransactionManifest({
      schemaVersion: manifest.schemaVersion,
      transactionId: manifest.transactionId,
      rootPageId: manifest.rootPageId,
      participantIds: manifest.participantIds,
      phase: completedMemberIds.length === members.length ? "committed" : "publishing",
      completedMemberIds,
      pendingMember: null,
      ...this.cortexRollbackWalFields(manifest, "clear"),
      members,
    });
  }

  /**
   * Keep the single durable rollback-WAL spelling already present in a
   * manifest.  Task 1 made the expanded spelling parseable before the writer
   * migrates rollback execution; silently serializing both would invalidate
   * the manifest and, worse, make recovery ambiguous.
   */
  private cortexRollbackWalFields(
    manifest: CortexTreeTransactionManifest,
    mode: "preserve" | "clear" | "replace",
    replacement?: CortexRollbackPending,
  ): Record<string, unknown> {
    const hasLegacy = Object.prototype.propertyIsEnumerable.call(manifest, "rollbackPending");
    const hasExpanded = Object.prototype.propertyIsEnumerable.call(manifest, "rollbackPendingMember");
    if (hasLegacy && hasExpanded) throw vaultWriterError();
    if (mode === "preserve") {
      if (hasExpanded) return { rollbackPendingMember: manifest.rollbackPendingMember };
      return hasLegacy ? { rollbackPending: manifest.rollbackPending } : {};
    }
    if (mode === "clear") {
      if (hasExpanded) return { rollbackPendingMember: null };
      return hasLegacy ? { rollbackPending: null } : {};
    }
    if (replacement === undefined) throw vaultWriterError();
    if (this.cortexRollbackMoveOperation(replacement) !== null || hasExpanded) {
      return { rollbackPendingMember: replacement };
    }
    return { rollbackPending: replacement };
  }

  private activeCortexRollbackPending(
    manifest: CortexTreeTransactionManifest,
  ): CortexRollbackPending | null {
    const hasLegacy = Object.prototype.propertyIsEnumerable.call(manifest, "rollbackPending");
    const hasExpanded = Object.prototype.propertyIsEnumerable.call(manifest, "rollbackPendingMember");
    if (hasLegacy && hasExpanded) throw vaultWriterError();
    if (hasExpanded) return manifest.rollbackPendingMember;
    return manifest.rollbackPending;
  }

  private cortexRollbackMoveOperation(
    rollback: CortexRollbackPending,
  ): CortexTreeTransactionMoveOperation | null {
    if (rollback.kind !== "move" || !("moveOperation" in rollback)) return null;
    return rollback.moveOperation;
  }

  private cortexPendingRollback(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    restoredWrite: CortexPendingRollback["restoredWrite"] = null,
  ): CortexPendingRollback {
    return Object.freeze({ location, manifest, restoredWrite });
  }

  private forwardCortexMovePendingMember(
    memberId: string,
    sourceFileIdentity: FileIdentity,
    sourceCompanionIdentity: FileIdentity | null,
  ): CortexTreeTransactionPendingMember {
    const sourceFile = this.cortexIdentity(sourceFileIdentity);
    const sourceCompanion = sourceCompanionIdentity === null ? null : this.cortexIdentity(sourceCompanionIdentity);
    return this.cortexMovePendingMember(memberId, Object.freeze({
      direction: "forward",
      stage: "pre-link",
      sourceFileIdentity: sourceFile,
      targetFileIdentity: sourceFile,
      sourceCompanionIdentity: sourceCompanion,
      targetCompanionIdentity: sourceCompanion,
      reservationIdentity: null,
    }));
  }

  /**
   * The public compatibility type still describes legacy move members.  The
   * parser is the authority for persisted manifests, so keep this narrow cast
   * at the one construction boundary instead of leaking legacy fields into a
   * new WAL operation.
   */
  private cortexMovePendingMember(
    memberId: string,
    operation: CortexTreeTransactionMoveOperation,
  ): CortexTreeTransactionPendingMember {
    if (!UUID_PATTERN.test(memberId)) throw vaultWriterError();
    return Object.freeze({
      memberId,
      kind: "move",
      moveOperation: Object.freeze({ ...operation }),
    }) as unknown as CortexTreeTransactionPendingMember;
  }

  private cortexMoveOperationFromPending(
    pending: CortexTreeTransactionPendingMember,
  ): CortexTreeTransactionMoveOperation | null {
    if (pending.kind !== "move") return null;
    const candidate = (pending as unknown as { readonly moveOperation?: unknown }).moveOperation;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
    const operation = candidate as Partial<CortexTreeTransactionMoveOperation>;
    if (
      (operation.direction !== "forward" && operation.direction !== "reverse") ||
      (operation.stage !== "pre-link" &&
        operation.stage !== "target-linked" &&
        operation.stage !== "companion-reserve" &&
        operation.stage !== "companion-reserved" &&
        operation.stage !== "companion-moved" &&
        operation.stage !== "source-unlinked") ||
      operation.sourceFileIdentity === undefined ||
      operation.targetFileIdentity === undefined ||
      operation.sourceCompanionIdentity === undefined ||
      operation.targetCompanionIdentity === undefined ||
      operation.reservationIdentity === undefined
    ) {
      return null;
    }
    return operation as CortexTreeTransactionMoveOperation;
  }

  private cortexMoveOperationWithStage(
    operation: CortexTreeTransactionMoveOperation,
    stage: CortexTreeTransactionMoveOperation["stage"],
    reservationIdentity: FileIdentity | Readonly<{ dev: string; ino: string }> | null,
  ): CortexTreeTransactionMoveOperation {
    const nextReservationIdentity: Readonly<{ dev: string; ino: string }> | null = reservationIdentity === null
      ? null
      : typeof reservationIdentity.dev === "number"
        ? this.cortexIdentity(reservationIdentity as FileIdentity)
        : Object.freeze({
          dev: reservationIdentity.dev as string,
          ino: reservationIdentity.ino as string,
        });
    return Object.freeze({
      ...operation,
      stage,
      reservationIdentity: nextReservationIdentity,
    });
  }

  private cortexReverseMoveOperationWithStage(
    operation: CortexMoveExecutionOperation,
    stage: Extract<CortexTreeTransactionMoveOperation["stage"], "pre-link" | "target-linked" | "companion-reserve">,
  ): CortexTreeTransactionMoveOperation {
    if (operation.direction !== "reverse" || operation.reservationIdentity !== null) throw vaultWriterError();
    return Object.freeze({ ...operation, stage, reservationIdentity: null });
  }

  private async checkpointCortexForwardMoveOperationWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    operation: CortexTreeTransactionMoveOperation,
    lock: CortexMoveLock,
  ): Promise<Readonly<{ location: CortexTransactionManifestLocation; manifest: CortexTreeTransactionManifest }>> {
    await this.assertCortexMoveLockOwnership(lock);
    const nextManifest = await this.manifestWithMoveOperation(manifest, operation);
    return Object.freeze({
      manifest: nextManifest,
      location: await this.persistCortexTransactionManifest(location, nextManifest),
    });
  }

  /** A reverse mutation advances only an expanded, digest-covered rollback WAL. */
  private async checkpointCortexReverseMoveMutationWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    member: Extract<CortexTreeTransactionManifestMember, { readonly kind: "move" }>,
    nextOperation: CortexMoveExecutionOperation,
    lock: CortexMoveLock,
  ): Promise<Readonly<{ location: CortexTransactionManifestLocation; manifest: CortexTreeTransactionManifest }>> {
    await this.assertCortexMoveLockOwnership(lock);
    const rollback = this.activeCortexRollbackPending(manifest);
    if (
      manifest.phase !== "rolling-back" ||
      rollback === null ||
      rollback.kind !== "move" ||
      rollback.memberId !== member.memberId ||
      this.cortexRollbackMoveOperation(rollback) === null ||
      nextOperation.direction !== "reverse"
    ) {
      throw vaultWriterError();
    }
    const checkpoint = await this.manifestWithRollbackMoveOperation(manifest, nextOperation);
    return Object.freeze({
      manifest: checkpoint,
      location: await this.persistCortexTransactionManifest(location, checkpoint),
    });
  }

  private async checkpointCortexManifestMoveOperationWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    owner: CortexManifestMoveOwner,
    member: Extract<CortexTreeTransactionManifestMember, { readonly kind: "move" }>,
    operation: CortexTreeTransactionMoveOperation,
    lock: CortexMoveLock,
  ): Promise<Readonly<{ location: CortexTransactionManifestLocation; manifest: CortexTreeTransactionManifest }>> {
    if (owner === "forward") {
      return this.checkpointCortexForwardMoveOperationWhileLocked(location, manifest, operation, lock);
    }
    return this.checkpointCortexReverseMoveMutationWhileLocked(location, manifest, member, operation, lock);
  }

  private reversedCortexManifestMoveMember(
    member: Extract<CortexTreeTransactionManifestMember, { readonly kind: "move" }>,
  ): Extract<CortexTreeTransactionManifestMember, { readonly kind: "move" }> {
    return Object.freeze({
      ...member,
      sourcePath: member.targetPath,
      targetPath: member.sourcePath,
      expectedSourceByteHash: member.resultByteHash,
      resultByteHash: member.expectedSourceByteHash,
    });
  }

  /**
   * Execute a pending move only through its durable namespace checkpoints.
   * The direct public mover intentionally remains separate: it retains its
   * legacy all-or-nothing API while transaction recovery needs to observe
   * every partial layout after a restart.
   */
  private async executeCortexManifestMoveWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    owner: CortexManifestMoveOwner,
    operation: CortexTreeTransactionMoveOperation,
    lock: CortexMoveLock,
  ): Promise<CortexManifestMoveExecution> {
    const pending = manifest.pendingMember;
    const member = this.pendingCortexManifestMember(manifest);
    if (
      pending === null ||
      pending.kind !== "move" ||
      member === null ||
      member.kind !== "move" ||
      this.cortexMoveOperationFromPending(pending) === null
    ) {
      throw vaultWriterError();
    }
    return this.executeCortexManifestMoveForMemberWhileLocked(location, manifest, owner, member, operation, lock);
  }

  /**
   * Forward and expanded reverse WALs share one identity-first state machine.
   * A legacy rollback record remains a narrow reconciliation-only reader so
   * historical manifests never gain fabricated reservation evidence.
   */
  private async executeCortexManifestMoveForMemberWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    owner: CortexManifestMoveOwner,
    member: Extract<CortexTreeTransactionManifestMember, { readonly kind: "move" }>,
    initialOperation: CortexMoveExecutionOperation,
    lock: CortexMoveLock,
  ): Promise<CortexManifestMoveExecution> {
    let currentLocation = location;
    let currentManifest = manifest;
    let operation = initialOperation;
    if (
      (owner === "forward" && operation.direction !== "forward") ||
      (owner === "reverse" && operation.direction !== "reverse")
    ) {
      throw vaultWriterError();
    }
    const orientedMember = owner === "reverse" ? this.reversedCortexManifestMoveMember(member) : member;

    while (true) {
      await this.assertCortexMoveLockOwnership(lock);
      const evidence = await this.classifyCortexManifestMoveLayout(currentLocation, orientedMember, operation);
      if (evidence === null) throw vaultWriterError();

      if (evidence.layout === "published") {
        if (operation.stage !== "source-unlinked" || evidence.targetFile === null) throw vaultWriterError();
        return Object.freeze({
          location: currentLocation,
          manifest: currentManifest,
          postIdentity: Object.freeze({
            targetFile: this.cortexIdentity(evidence.targetFile.identity),
            targetDirectory: evidence.targetDirectory === null ? null : this.cortexIdentity(evidence.targetDirectory.identity),
          }),
        });
      }

      if (evidence.layout === "old") {
        if (operation.stage === "pre-link") {
          operation = this.cortexMoveOperationWithStage(operation, "target-linked", null);
          const checkpoint = await this.checkpointCortexManifestMoveOperationWhileLocked(
            currentLocation,
            currentManifest,
            owner,
            orientedMember,
            operation,
            lock,
          );
          currentLocation = checkpoint.location;
          currentManifest = checkpoint.manifest;
          continue;
        }
        if (operation.stage !== "target-linked") throw vaultWriterError();
        if (evidence.sourceFile === null || evidence.targetFile !== null) throw vaultWriterError();
        const source = await this.readExisting(evidence.paths.sourceFileSegments);
        const target = await this.assertAbsentTarget(evidence.paths.targetFileSegments);
        if (
          source.byteHash !== orientedMember.expectedSourceByteHash ||
          !this.matchesCortexIdentity(operation.sourceFileIdentity, source.identity)
        ) {
          throw vaultWriterError();
        }
        await link(source.targetPath, target.targetPath);
        const linked = await this.readExisting(evidence.paths.targetFileSegments);
        if (
          linked.byteHash !== orientedMember.expectedSourceByteHash ||
          !this.matchesCortexIdentity(operation.targetFileIdentity, linked.identity) ||
          !sameIdentity(source.identity, linked.identity)
        ) {
          throw vaultWriterError();
        }
        await this.syncDirectory(target.parentPath);
        continue;
      }

      if (evidence.layout === "target-linked") {
        if (operation.sourceCompanionIdentity === null) {
          if (operation.stage === "target-linked") {
            operation = this.cortexMoveOperationWithStage(operation, "source-unlinked", null);
            const checkpoint = await this.checkpointCortexManifestMoveOperationWhileLocked(
              currentLocation,
              currentManifest,
              owner,
              orientedMember,
              operation,
              lock,
            );
            currentLocation = checkpoint.location;
            currentManifest = checkpoint.manifest;
            continue;
          }
          if (operation.stage !== "source-unlinked" || evidence.sourceFile === null) throw vaultWriterError();
          const source = await this.readExisting(evidence.paths.sourceFileSegments);
          if (
            source.byteHash !== orientedMember.expectedSourceByteHash ||
            !this.matchesCortexIdentity(operation.sourceFileIdentity, source.identity)
          ) {
            throw vaultWriterError();
          }
          await unlink(source.targetPath);
          await this.syncDirectory(source.parentPath);
          continue;
        }
        if (operation.stage === "target-linked") {
          operation = this.cortexMoveOperationWithStage(operation, "companion-reserve", null);
          const checkpoint = await this.checkpointCortexManifestMoveOperationWhileLocked(
            currentLocation,
            currentManifest,
            owner,
            orientedMember,
            operation,
            lock,
          );
          currentLocation = checkpoint.location;
          currentManifest = checkpoint.manifest;
          continue;
        }
        if (operation.stage !== "companion-reserve") throw vaultWriterError();
        const reservation = await this.createPrivateCortexMoveReservation(currentLocation.directory, orientedMember.memberId);
        operation = this.cortexMoveOperationWithStage(operation, "companion-reserved", reservation.identity);
        const checkpoint = await this.checkpointCortexManifestMoveOperationWhileLocked(
          currentLocation,
          currentManifest,
          owner,
          orientedMember,
          operation,
          lock,
        );
        currentLocation = checkpoint.location;
        currentManifest = checkpoint.manifest;
        continue;
      }

      if (evidence.layout === "private-reserved") {
        if (evidence.privateReservation === null) throw vaultWriterError();
        if (operation.stage === "companion-reserve" && operation.reservationIdentity === null) {
          operation = this.cortexMoveOperationWithStage(
            operation,
            "companion-reserved",
            evidence.privateReservation.identity,
          );
          const checkpoint = await this.checkpointCortexManifestMoveOperationWhileLocked(
            currentLocation,
            currentManifest,
            owner,
            orientedMember,
            operation,
            lock,
          );
          currentLocation = checkpoint.location;
          currentManifest = checkpoint.manifest;
          continue;
        }
        if (operation.stage !== "companion-reserved" || operation.reservationIdentity === null) throw vaultWriterError();
        const reservation = await this.readPrivateCortexMoveReservation(
          currentLocation.directory,
          orientedMember.memberId,
          operation.reservationIdentity,
        );
        if (reservation === null) throw vaultWriterError();
        const target = await this.assertAbsentTarget(evidence.paths.targetDirectorySegments);
        await rename(reservation.directoryPath, target.targetPath);
        await this.syncDirectory(reservation.parentPath);
        await this.syncDirectory(target.parentPath);
        continue;
      }

      if (evidence.layout === "companion-reserved") {
        if (operation.stage === "companion-reserved") {
          operation = this.cortexMoveOperationWithStage(
            operation,
            "companion-moved",
            operation.reservationIdentity,
          );
          const checkpoint = await this.checkpointCortexManifestMoveOperationWhileLocked(
            currentLocation,
            currentManifest,
            owner,
            orientedMember,
            operation,
            lock,
          );
          currentLocation = checkpoint.location;
          currentManifest = checkpoint.manifest;
          continue;
        }
        if (
          operation.stage !== "companion-moved" ||
          evidence.sourceDirectory === null ||
          evidence.targetDirectory === null ||
          operation.sourceCompanionIdentity === null ||
          operation.reservationIdentity === null
        ) {
          throw vaultWriterError();
        }
        const source = await this.readExistingDirectory(evidence.paths.sourceDirectorySegments);
        const target = await this.readExistingDirectory(evidence.paths.targetDirectorySegments);
        if (!this.matchesCortexIdentity(operation.sourceCompanionIdentity, source.identity)) throw vaultWriterError();
        await this.assertVisibleCortexMoveReservation(target, operation.reservationIdentity);
        await rename(source.directoryPath, target.directoryPath);
        await this.syncDirectory(source.parentPath);
        await this.syncDirectory(target.parentPath);
        continue;
      }

      if (evidence.layout !== "companion-moved") throw vaultWriterError();
      if (operation.stage === "companion-moved") {
        operation = this.cortexMoveOperationWithStage(
          operation,
          "source-unlinked",
          operation.reservationIdentity,
        );
        const checkpoint = await this.checkpointCortexManifestMoveOperationWhileLocked(
          currentLocation,
          currentManifest,
          owner,
          orientedMember,
          operation,
          lock,
        );
        currentLocation = checkpoint.location;
        currentManifest = checkpoint.manifest;
        continue;
      }
      if (operation.stage !== "source-unlinked" || evidence.sourceFile === null) throw vaultWriterError();
      const source = await this.readExisting(evidence.paths.sourceFileSegments);
      if (
        source.byteHash !== orientedMember.expectedSourceByteHash ||
        !this.matchesCortexIdentity(operation.sourceFileIdentity, source.identity)
      ) {
        throw vaultWriterError();
      }
      await unlink(source.targetPath);
      await this.syncDirectory(source.parentPath);
    }
  }

  private async classifyCortexManifestMoveLayout(
    location: CortexTransactionManifestLocation,
    member: Extract<CortexTreeTransactionManifestMember, { readonly kind: "move" }>,
    operation: CortexMoveExecutionOperation,
  ): Promise<CortexManifestMoveLayoutEvidence | null> {
    try {
      const paths = cortexMovePaths({
        sourcePath: member.sourcePath,
        targetPath: member.targetPath,
        expectedSourceByteHash: member.expectedSourceByteHash,
      });
      const sourceFile = await this.optionalReadExisting(paths.sourceFileSegments);
      const targetFile = await this.optionalReadExisting(paths.targetFileSegments);
      const sourceDirectory = await this.optionalExistingDirectory(paths.sourceDirectorySegments);
      const targetDirectory = await this.optionalExistingDirectory(paths.targetDirectorySegments);
      const privateReservation = await this.readPrivateCortexMoveReservation(
        location.directory,
        member.memberId,
        operation.reservationIdentity ?? undefined,
      );
      const sourceMatches = sourceFile !== null &&
        sourceFile.byteHash === member.expectedSourceByteHash &&
        this.matchesCortexIdentity(operation.sourceFileIdentity, sourceFile.identity);
      const targetMatches = targetFile !== null &&
        targetFile.byteHash === member.resultByteHash &&
        this.matchesCortexIdentity(operation.targetFileIdentity, targetFile.identity);
      const sourceCompanionMatches = operation.sourceCompanionIdentity === null
        ? sourceDirectory === null
        : sourceDirectory !== null && this.matchesCortexIdentity(operation.sourceCompanionIdentity, sourceDirectory.identity);
      const targetCompanionMatches = operation.targetCompanionIdentity === null
        ? targetDirectory === null
        : targetDirectory !== null && this.matchesCortexIdentity(operation.targetCompanionIdentity, targetDirectory.identity);
      const linked = sourceMatches && targetMatches && sourceFile !== null && targetFile !== null &&
        sameIdentity(sourceFile.identity, targetFile.identity);
      const reservationMatches = operation.reservationIdentity !== null &&
        targetDirectory !== null &&
        this.matchesCortexIdentity(operation.reservationIdentity, targetDirectory.identity) &&
        (await this.isVisibleCortexMoveReservation(targetDirectory, operation.reservationIdentity));
      const privateReservationMatches = privateReservation !== null && (
        (operation.reservationIdentity !== null &&
          this.matchesCortexIdentity(operation.reservationIdentity, privateReservation.identity)) ||
        (operation.stage === "companion-reserve" && operation.reservationIdentity === null)
      );
      const evidence = (layout: CortexMoveLayout): CortexManifestMoveLayoutEvidence => Object.freeze({
        layout,
        paths,
        sourceFile,
        targetFile,
        sourceDirectory,
        targetDirectory,
        privateReservation,
      });

      if (sourceMatches && targetFile === null && sourceCompanionMatches && targetDirectory === null && privateReservation === null) {
        return evidence("old");
      }
      if (linked && sourceCompanionMatches && targetDirectory === null && privateReservation === null) {
        return evidence("target-linked");
      }
      if (
        linked &&
        sourceCompanionMatches &&
        targetDirectory === null &&
        operation.sourceCompanionIdentity !== null &&
        privateReservationMatches
      ) {
        return evidence("private-reserved");
      }
      if (linked && sourceCompanionMatches && reservationMatches && privateReservation === null) {
        return evidence("companion-reserved");
      }
      if (linked && sourceDirectory === null && targetCompanionMatches && privateReservation === null) {
        return evidence("companion-moved");
      }
      if (sourceFile === null && targetMatches && sourceDirectory === null && targetCompanionMatches && privateReservation === null) {
        return evidence("published");
      }
      return null;
    } catch {
      return null;
    }
  }

  private async isVisibleCortexMoveReservation(
    reservation: ExistingDirectory,
    expectedIdentity: Readonly<{ dev: string; ino: string }>,
  ): Promise<boolean> {
    try {
      await this.assertVisibleCortexMoveReservation(reservation, expectedIdentity);
      return true;
    } catch {
      return false;
    }
  }

  private async assertVisibleCortexMoveReservation(
    reservation: ExistingDirectory,
    expectedIdentity: Readonly<{ dev: string; ino: string }>,
  ): Promise<void> {
    await this.assertExistingDirectory(reservation.parentPath);
    await this.assertExistingDirectory(reservation.directoryPath);
    const named = await lstat(reservation.directoryPath);
    if (
      named.isSymbolicLink() ||
      !named.isDirectory() ||
      (named.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      !sameIdentity(reservation.identity, { dev: named.dev, ino: named.ino }) ||
      !this.matchesCortexIdentity(expectedIdentity, reservation.identity) ||
      (await readdir(reservation.directoryPath)).length !== 0
    ) {
      throw vaultWriterError();
    }
  }

  private cortexIdentity(identity: FileIdentity): Readonly<{ dev: string; ino: string }> {
    return Object.freeze({ dev: String(identity.dev), ino: String(identity.ino) });
  }

  private matchesCortexIdentity(
    expected: Readonly<{ dev: string; ino: string }>,
    actual: FileIdentity,
  ): boolean {
    return expected.dev === String(actual.dev) && expected.ino === String(actual.ino);
  }

  private sameCortexIdentityEvidence(
    left: Readonly<{ dev: string; ino: string }>,
    right: Readonly<{ dev: string; ino: string }>,
  ): boolean {
    return left.dev === right.dev && left.ino === right.ino;
  }

  private sameNullableCortexIdentityEvidence(
    left: Readonly<{ dev: string; ino: string }> | null,
    right: Readonly<{ dev: string; ino: string }> | null,
  ): boolean {
    return left === null ? right === null : right !== null && this.sameCortexIdentityEvidence(left, right);
  }

  private async assertCortexMoveLockOwnership(lock: CortexMoveLock): Promise<void> {
    if (!(await this.ownsCortexMoveLock(lock))) throw cortexMoveLockError("recovery-required");
  }

  private async assertRoot(): Promise<void> {
    try {
      if (
        typeof this.root.canonicalRealPath !== "string" ||
        typeof this.root.filesystemDeviceId !== "string" ||
        typeof this.root.vaultFingerprint !== "string" ||
        !HASH_PATTERN.test(this.root.vaultFingerprint)
      ) {
        throw vaultWriterError();
      }
      const named = await lstat(this.root.canonicalRealPath);
      if (named.isSymbolicLink() || !named.isDirectory()) {
        throw vaultWriterError();
      }
      const canonical = await realpath(this.root.canonicalRealPath);
      const rootStats = await stat(canonical);
      if (
        canonical !== this.root.canonicalRealPath ||
        !rootStats.isDirectory() ||
        String(rootStats.dev) !== this.root.filesystemDeviceId
      ) {
        throw vaultWriterError();
      }
    } catch {
      throw vaultWriterError();
    }
  }

  private async ensureCortexTransactionRoot(): Promise<ExistingDirectory> {
    let current = this.root.canonicalRealPath;
    await this.assertRoot();
    for (let index = 0; index < CORTEX_TRANSACTION_ROOT_SEGMENTS.length; index += 1) {
      const next = join(current, CORTEX_TRANSACTION_ROOT_SEGMENTS[index]!);
      let created = false;
      try {
        await this.assertExistingDirectory(next);
      } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw vaultWriterError();
        await this.assertExistingDirectory(current);
        try {
          await mkdir(next, { mode: PRIVATE_DIRECTORY_MODE });
          created = true;
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw vaultWriterError();
        }
        await this.assertExistingDirectory(next);
      }
      if (index > 0) {
        if (created) await chmod(next, PRIVATE_DIRECTORY_MODE);
        await this.assertPrivateCortexDirectory(next);
      }
      await this.syncDirectory(current);
      await this.syncDirectory(next);
      current = next;
    }
    return this.readPrivateCortexDirectory(CORTEX_TRANSACTION_ROOT_SEGMENTS);
  }

  private async optionalCortexTransactionRoot(): Promise<ExistingDirectory | null> {
    try {
      return await this.readPrivateCortexDirectory(CORTEX_TRANSACTION_ROOT_SEGMENTS);
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw vaultWriterError();
    }
  }

  private async createCortexTransactionDirectory(transactionId: string): Promise<ExistingDirectory> {
    if (!UUID_PATTERN.test(transactionId)) throw vaultWriterError();
    const parent = await this.ensureCortexTransactionRoot();
    const segments = [...CORTEX_TRANSACTION_ROOT_SEGMENTS, transactionId];
    const paths = this.targetPaths(segments);
    try {
      await mkdir(paths.targetPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch {
      throw vaultWriterError();
    }
    try {
      await chmod(paths.targetPath, PRIVATE_DIRECTORY_MODE);
      await this.assertPrivateCortexDirectory(paths.targetPath);
      await this.syncDirectory(parent.directoryPath);
      await this.syncDirectory(paths.targetPath);
      return this.readPrivateCortexDirectory(segments);
    } catch {
      throw vaultWriterError();
    }
  }

  private async readCortexTransactionLocation(transactionId: string): Promise<CortexTransactionManifestLocation> {
    if (!UUID_PATTERN.test(transactionId)) throw vaultWriterError();
    const directory = await this.readPrivateCortexDirectory([...CORTEX_TRANSACTION_ROOT_SEGMENTS, transactionId]);
    const manifest = await this.readPrivateTextArtifact(directory, CORTEX_TRANSACTION_MANIFEST_FILENAME, MAX_CORTEX_TRANSACTION_MANIFEST_BYTES);
    return Object.freeze({
      directory,
      manifestPath: manifest.path,
      manifestIdentity: manifest.identity,
      manifestContent: manifest.content,
    });
  }

  private async readPrivateCortexDirectory(segments: readonly string[]): Promise<ExistingDirectory> {
    await this.assertRoot();
    const paths = this.targetPaths(segments);
    let current = this.root.canonicalRealPath;
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]!);
      await this.assertExistingDirectory(current);
      if (index > 0) await this.assertPrivateCortexDirectory(current);
    }
    const named = await lstat(paths.targetPath);
    if (named.isSymbolicLink() || !named.isDirectory()) throw vaultWriterError();
    return Object.freeze({
      directoryPath: paths.targetPath,
      parentPath: paths.parentPath,
      identity: { dev: named.dev, ino: named.ino },
    });
  }

  private async assertPrivateCortexDirectory(path: string, expectedIdentity?: FileIdentity): Promise<void> {
    await this.assertExistingDirectory(path);
    const named = await lstat(path);
    if (
      named.isSymbolicLink() ||
      !named.isDirectory() ||
      (named.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      (expectedIdentity !== undefined && !sameIdentity(expectedIdentity, { dev: named.dev, ino: named.ino }))
    ) {
      throw vaultWriterError();
    }
  }

  private privateArtifactPath(directory: ExistingDirectory, name: string): string {
    if (
      name !== CORTEX_TRANSACTION_MANIFEST_FILENAME &&
      !new RegExp(`^${UUID_PATTERN.source.slice(1, -1)}\\.(?:preimage|pending|rollback|reservation)$`).test(name)
    ) {
      throw vaultWriterError();
    }
    const path = join(directory.directoryPath, name);
    if (!isBeneath(directory.directoryPath, path)) throw vaultWriterError();
    return path;
  }

  private cortexPendingArtifactName(memberId: string): string {
    if (!UUID_PATTERN.test(memberId)) throw vaultWriterError();
    return `${memberId}.pending`;
  }

  private cortexRollbackArtifactName(memberId: string): string {
    if (!UUID_PATTERN.test(memberId)) throw vaultWriterError();
    return `${memberId}.rollback`;
  }

  private cortexMoveReservationArtifactName(memberId: string): string {
    if (!UUID_PATTERN.test(memberId)) throw vaultWriterError();
    return `${memberId}.reservation`;
  }

  /**
   * The companion reservation is deliberately born below the private
   * transaction directory.  Its recorded inode is therefore established
   * before it becomes a visible target-path namespace entry.
   */
  private async createPrivateCortexMoveReservation(
    directory: ExistingDirectory,
    memberId: string,
  ): Promise<ExistingDirectory> {
    const name = this.cortexMoveReservationArtifactName(memberId);
    const path = this.privateArtifactPath(directory, name);
    try {
      await this.assertPrivateCortexDirectory(directory.directoryPath, directory.identity);
      await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
      await chmod(path, PRIVATE_DIRECTORY_MODE);
      const reservation = await this.readPrivateCortexMoveReservation(directory, memberId);
      if (reservation === null) throw vaultWriterError();
      await this.syncDirectory(directory.directoryPath);
      await this.syncDirectory(reservation.directoryPath);
      return reservation;
    } catch {
      throw vaultWriterError();
    }
  }

  private async readPrivateCortexMoveReservation(
    directory: ExistingDirectory,
    memberId: string,
    expectedIdentity?: Readonly<{ dev: string; ino: string }>,
  ): Promise<ExistingDirectory | null> {
    const name = this.cortexMoveReservationArtifactName(memberId);
    const path = this.privateArtifactPath(directory, name);
    try {
      await this.assertPrivateCortexDirectory(directory.directoryPath, directory.identity);
      const named = await lstat(path);
      const identity = { dev: named.dev, ino: named.ino };
      if (
        named.isSymbolicLink() ||
        !named.isDirectory() ||
        (named.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        (expectedIdentity !== undefined && !this.matchesCortexIdentity(expectedIdentity, identity))
      ) {
        throw vaultWriterError();
      }
      await this.assertExistingDirectory(path);
      if ((await readdir(path)).length !== 0) throw vaultWriterError();
      const after = await lstat(path);
      if (
        after.isSymbolicLink() ||
        !after.isDirectory() ||
        (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        !sameIdentity(identity, { dev: after.dev, ino: after.ino })
      ) {
        throw vaultWriterError();
      }
      return Object.freeze({ directoryPath: path, parentPath: directory.directoryPath, identity });
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw vaultWriterError();
    }
  }

  private async removePrivateCortexMoveReservation(
    directory: ExistingDirectory,
    memberId: string,
    expectedIdentity: Readonly<{ dev: string; ino: string }>,
  ): Promise<void> {
    const reservation = await this.readPrivateCortexMoveReservation(directory, memberId, expectedIdentity);
    if (reservation === null) throw vaultWriterError();
    await rmdir(reservation.directoryPath);
    await this.syncDirectory(reservation.parentPath);
  }

  private async createPrivateTextArtifact(
    directory: ExistingDirectory,
    name: string,
    content: string,
  ): Promise<PrivateTextEvidence> {
    const bytes = Buffer.from(content, "utf8");
    const limit = name === CORTEX_TRANSACTION_MANIFEST_FILENAME
      ? MAX_CORTEX_TRANSACTION_MANIFEST_BYTES
      : MAX_LOCAL_NOTE_BYTES;
    if (bytes.byteLength > limit || new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== content) {
      throw vaultWriterError();
    }
    const path = this.privateArtifactPath(directory, name);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await this.assertPrivateCortexDirectory(directory.directoryPath, directory.identity);
      handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      const opened = await handle.stat();
      const identity = { dev: opened.dev, ino: opened.ino };
      if (!opened.isFile() || (opened.mode & 0o777) !== PRIVATE_FILE_MODE) throw vaultWriterError();
      await handle.writeFile(bytes);
      await this.syncFile(path, handle);
      const afterSync = await handle.stat();
      if (
        !afterSync.isFile() ||
        afterSync.size !== bytes.byteLength ||
        !sameIdentity(identity, afterSync)
      ) {
        throw vaultWriterError();
      }
      await handle.close();
      handle = undefined;
      const observed = await this.readPrivateTextArtifact(directory, name, limit);
      if (observed.content !== content || !sameIdentity(identity, observed.identity)) throw vaultWriterError();
      await this.syncDirectory(directory.directoryPath);
      return observed;
    } catch {
      await handle?.close().catch(() => undefined);
      throw vaultWriterError();
    }
  }

  private async readPrivateTextArtifact(
    directory: ExistingDirectory,
    name: string,
    maximumBytes: number,
  ): Promise<PrivateTextEvidence> {
    const path = this.privateArtifactPath(directory, name);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await this.assertPrivateCortexDirectory(directory.directoryPath, directory.identity);
      const named = await lstat(path);
      const identity = { dev: named.dev, ino: named.ino };
      if (
        named.isSymbolicLink() ||
        !named.isFile() ||
        (named.mode & 0o777) !== PRIVATE_FILE_MODE ||
        named.size < 0 ||
        named.size > maximumBytes
      ) {
        throw vaultWriterError();
      }
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || !sameIdentity(identity, opened)) throw vaultWriterError();
      const bytes = Buffer.alloc(maximumBytes + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      if (offset > maximumBytes) throw vaultWriterError();
      const afterRead = await handle.stat();
      const namedAfterRead = await lstat(path);
      if (
        !afterRead.isFile() ||
        afterRead.size !== offset ||
        !sameIdentity(identity, afterRead) ||
        namedAfterRead.isSymbolicLink() ||
        !namedAfterRead.isFile() ||
        (namedAfterRead.mode & 0o777) !== PRIVATE_FILE_MODE ||
        !sameIdentity(identity, namedAfterRead)
      ) {
        throw vaultWriterError();
      }
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
      return Object.freeze({ path, parentPath: directory.directoryPath, identity, content });
    } catch {
      throw vaultWriterError();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async optionalPrivateTextArtifact(
    directory: ExistingDirectory,
    name: string,
    maximumBytes: number,
  ): Promise<PrivateTextEvidence | null> {
    const path = this.privateArtifactPath(directory, name);
    await this.assertPrivateCortexDirectory(directory.directoryPath, directory.identity);
    try {
      await lstat(path);
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw vaultWriterError();
    }
    return this.readPrivateTextArtifact(directory, name, maximumBytes);
  }

  private async createCortexTransactionManifest(
    directory: ExistingDirectory,
    manifest: CortexTreeTransactionManifest,
  ): Promise<CortexTransactionManifestLocation> {
    const artifact = await this.createPrivateTextArtifact(
      directory,
      CORTEX_TRANSACTION_MANIFEST_FILENAME,
      `${JSON.stringify(manifest)}\n`,
    );
    return Object.freeze({
      directory,
      manifestPath: artifact.path,
      manifestIdentity: artifact.identity,
      manifestContent: artifact.content,
    });
  }

  private async persistCortexTransactionManifest(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
  ): Promise<CortexTransactionManifestLocation> {
    const content = `${JSON.stringify(manifest)}\n`;
    const artifact = await this.replacePrivateTextArtifact(
      location.directory,
      CORTEX_TRANSACTION_MANIFEST_FILENAME,
      location.manifestIdentity,
      location.manifestContent,
      content,
    );
    await this.testHooks.afterCortexTransactionManifestPersist?.({
      transactionId: manifest.transactionId,
      phase: manifest.phase,
      completedMemberIds: manifest.completedMemberIds,
    });
    return Object.freeze({
      directory: location.directory,
      manifestPath: artifact.path,
      manifestIdentity: artifact.identity,
      manifestContent: artifact.content,
    });
  }

  private async replacePrivateTextArtifact(
    directory: ExistingDirectory,
    name: string,
    expectedIdentity: FileIdentity,
    expectedContent: string,
    content: string,
  ): Promise<PrivateTextEvidence> {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > MAX_CORTEX_TRANSACTION_MANIFEST_BYTES) throw vaultWriterError();
    const path = this.privateArtifactPath(directory, name);
    let temporary: TemporaryFile | undefined;
    try {
      await this.assertPrivateCortexDirectory(directory.directoryPath, directory.identity);
      temporary = await this.createPrivateTemporary(directory.directoryPath, name, bytes);
      const beforeRename = await this.readPrivateTextArtifact(directory, name, MAX_CORTEX_TRANSACTION_MANIFEST_BYTES);
      if (!sameIdentity(expectedIdentity, beforeRename.identity) || beforeRename.content !== expectedContent) {
        throw vaultWriterError();
      }
      await this.assertOwnedTemporary(temporary);
      const finalBaseline = await this.readPrivateTextArtifact(directory, name, MAX_CORTEX_TRANSACTION_MANIFEST_BYTES);
      if (!sameIdentity(expectedIdentity, finalBaseline.identity) || finalBaseline.content !== expectedContent) {
        throw vaultWriterError();
      }
      await rename(temporary.path, path);
      temporary = undefined;
      await this.syncDirectory(directory.directoryPath);
      const observed = await this.readPrivateTextArtifact(directory, name, MAX_CORTEX_TRANSACTION_MANIFEST_BYTES);
      if (observed.content !== content) throw vaultWriterError();
      return observed;
    } catch {
      if (temporary !== undefined) await this.removeOwnedTemporary(temporary).catch(() => undefined);
      throw vaultWriterError();
    }
  }

  private async readCortexTransactionManifest(
    location: CortexTransactionManifestLocation,
  ): Promise<CortexTreeTransactionManifest> {
    try {
      const parsed = await parseCortexTreeTransactionManifest(JSON.parse(location.manifestContent));
      if (parsed.transactionId !== basename(location.directory.directoryPath)) throw vaultWriterError();
      return parsed;
    } catch {
      throw vaultWriterError();
    }
  }

  private async verifyCortexTransactionPostconditions(
    manifest: CortexTreeTransactionManifest,
    location: CortexTransactionManifestLocation,
  ): Promise<boolean> {
    try {
      await this.assertCortexTransactionArtifacts(location, manifest);
      for (let index = 0; index < manifest.members.length; index += 1) {
        const member = manifest.members[index]!;
        if (member.postIdentity === undefined) return false;
        if (member.kind === "write" || member.kind === "create") {
          const observed = await this.readExisting(validateRelativePath(member.relativePath));
          if (
            observed.byteHash !== member.resultByteHash ||
            !this.matchesCortexIdentity(member.postIdentity.file, observed.identity)
          ) {
            return false;
          }
          continue;
        }
        const paths = cortexMovePaths({
          sourcePath: member.sourcePath,
          targetPath: member.targetPath,
          expectedSourceByteHash: member.expectedSourceByteHash,
        });
        const target = await this.readExisting(paths.targetFileSegments);
        const targetDirectory = await this.optionalExistingDirectory(paths.targetDirectorySegments);
        const laterWrite = this.latestCortexWriteForPath(manifest.members, index, member.targetPath);
        const expectedTargetHash = laterWrite === null ? member.resultByteHash : laterWrite.resultByteHash;
        const expectedTargetIdentity = laterWrite === null
          ? member.postIdentity.targetFile
          : laterWrite.postIdentity?.file;
        if (
          expectedTargetIdentity === undefined ||
          target.byteHash !== expectedTargetHash ||
          !this.matchesCortexIdentity(expectedTargetIdentity, target.identity) ||
          (member.postIdentity.targetDirectory === null
            ? targetDirectory !== null
            : targetDirectory === null || !this.matchesCortexIdentity(member.postIdentity.targetDirectory, targetDirectory.identity))
        ) {
          return false;
        }
        await this.assertAbsentTarget(paths.sourceFileSegments);
        if (await this.optionalExistingDirectory(paths.sourceDirectorySegments) !== null) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private latestCortexWriteForPath(
    members: readonly CortexTreeTransactionManifestMember[],
    moveIndex: number,
    relativePath: string,
  ): Extract<CortexTreeTransactionManifestMember, { readonly kind: "write" }> | null {
    for (let index = members.length - 1; index > moveIndex; index -= 1) {
      const member = members[index]!;
      if (member.kind === "write" && member.relativePath === relativePath) return member;
    }
    return null;
  }

  private async verifyCortexTransactionPreconditions(
    manifest: CortexTreeTransactionManifest,
    location: CortexTransactionManifestLocation,
  ): Promise<boolean> {
    try {
      for (let index = 0; index < manifest.members.length; index += 1) {
        const member = manifest.members[index]!;
        if (member.kind === "write") {
          const source = await this.readCortexWritePreimageSource(manifest.members, index, member.relativePath);
          if (source.byteHash !== member.expectedByteHash) return false;
        } else {
          await this.assertCortexManifestMemberPrecondition(member);
        }
        if (member.kind === "create") continue;
        const preimage = await this.readCortexTransactionPreimage(location, member);
        const expectedHash = member.kind === "move" ? member.expectedSourceByteHash : member.expectedByteHash;
        if (await sha256Hex(preimage) !== expectedHash) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async assertCortexManifestMemberPrecondition(member: CortexTreeTransactionManifestMember): Promise<void> {
    if (member.kind === "write") {
      const observed = await this.readExisting(validateRelativePath(member.relativePath));
      if (observed.byteHash !== member.expectedByteHash) throw vaultWriterError();
      return;
    }
    if (member.kind === "create") {
      await this.assertAbsentTarget(validateRelativePath(member.relativePath));
      return;
    }
    const paths = cortexMovePaths({
      sourcePath: member.sourcePath,
      targetPath: member.targetPath,
      expectedSourceByteHash: member.expectedSourceByteHash,
    });
    const source = await this.readExisting(paths.sourceFileSegments);
    if (source.byteHash !== member.expectedSourceByteHash) throw vaultWriterError();
    await this.optionalExistingDirectory(paths.sourceDirectorySegments);
    await this.assertAbsentTarget(paths.targetFileSegments);
    await this.assertAbsentTarget(paths.targetDirectorySegments);
  }

  private async rollbackCortexTransactionManifestWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    lock: CortexMoveLock,
  ): Promise<boolean> {
    try {
      await this.assertCortexMoveLockOwnership(lock);
      await this.assertCortexTransactionArtifacts(location, manifest);
      if (manifest.phase === "rolling-back") {
        return this.resumeCortexRollingBackTransactionWhileLocked(location, manifest, lock);
      }
      if (
        manifest.phase !== "prepared" &&
        manifest.phase !== "publishing" &&
        manifest.phase !== "committed"
      ) return false;
      const completedCount = manifest.completedMemberIds.length;
      const pendingState = await this.classifyCortexPendingRecoveryState(location, manifest);
      if (pendingState === null) return false;

      for (let index = 0; index < completedCount; index += 1) {
        if (!(await this.verifyCortexCompletedMemberPostconditionBeforeRollback(manifest, index, pendingState))) {
          return false;
        }
      }
      for (let index = completedCount; index < manifest.members.length; index += 1) {
        if (manifest.pendingMember !== null && index === completedCount) continue;
        const member = manifest.members[index]!;
        if (member.kind === "write") {
          const source = await this.readCortexWritePreimageSource(manifest.members, index, member.relativePath);
          if (source.byteHash !== member.expectedByteHash) return false;
        } else {
          await this.assertCortexManifestMemberPrecondition(member);
        }
      }

      if (pendingState === "published") {
        const promoted = await this.promoteCortexPublishedPendingForRollbackWhileLocked(location, manifest, lock);
        if (promoted === null) return false;
        return this.resumeCortexRollingBackTransactionWhileLocked(promoted.location, promoted.manifest, lock);
      }

      const pending = manifest.pendingMember;
      const pendingMoveOperation = pending !== null && pending.kind === "move"
        ? this.cortexMoveOperationFromPending(pending)
        : null;
      if (
        pendingState !== "old" &&
        pendingMoveOperation !== null &&
        pendingMoveOperation.direction === "forward"
      ) {
        const promoted = await this.finishCortexPendingMoveForRollbackWhileLocked(location, manifest, lock);
        if (promoted === null) return false;
        return this.resumeCortexRollingBackTransactionWhileLocked(promoted.location, promoted.manifest, lock);
      }

      const pendingRollback = await this.rollbackCortexPendingMemberWhileLocked(
        location,
        manifest,
        lock,
        pendingState,
      );
      if (pendingRollback === null) return false;
      // The forward pending member is now back at its exact precondition.  A
      // durable phase transition makes every subsequent reverse operation
      // restartable; no in-memory completed-prefix mutation is trusted.
      const rollingManifest = await this.manifestWithRollingBack(pendingRollback.manifest, pendingRollback.restoredWrite);
      const rollingLocation = await this.persistCortexTransactionManifest(pendingRollback.location, rollingManifest);
      return this.resumeCortexRollingBackTransactionWhileLocked(rollingLocation, rollingManifest, lock);
    } catch {
      return false;
    }
  }

  /**
   * A partially-published forward move is never physically inverted under its
   * forward WAL.  It first reaches the exact published topology through its
   * own durable stages, then becomes a completed reverse member.
   */
  private async finishCortexPendingMoveForRollbackWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    lock: CortexMoveLock,
  ): Promise<CortexRollbackMemberPreparation | null> {
    try {
      await this.assertCortexMoveLockOwnership(lock);
      const pending = manifest.pendingMember;
      const member = this.pendingCortexManifestMember(manifest);
      if (
        manifest.phase !== "publishing" ||
        pending === null ||
        pending.kind !== "move" ||
        member === null ||
        member.kind !== "move"
      ) {
        return null;
      }
      const operation = this.cortexMoveOperationFromPending(pending);
      if (operation === null || operation.direction !== "forward") return null;
      const executed = await this.executeCortexManifestMoveWhileLocked(
        location,
        manifest,
        "forward",
        operation,
        lock,
      );
      if (executed.postIdentity === null) return null;
      return this.promoteCortexPublishedPendingForRollbackWhileLocked(executed.location, executed.manifest, lock);
    } catch {
      return null;
    }
  }

  private async promoteCortexPublishedPendingForRollbackWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    lock: CortexMoveLock,
  ): Promise<CortexRollbackMemberPreparation | null> {
    try {
      await this.assertCortexMoveLockOwnership(lock);
      const pending = manifest.pendingMember;
      const member = this.pendingCortexManifestMember(manifest);
      const moveOperation = pending !== null && pending.kind === "move"
        ? this.cortexMoveOperationFromPending(pending)
        : null;
      if (
        manifest.phase !== "publishing" ||
        pending === null ||
        member === null ||
        !(await this.verifyCortexPendingMemberPostcondition(member, pending, location))
      ) {
        return null;
      }
      if (pending.kind !== "move" && pending.postIdentity === null) return null;
      if (pending.kind === "move" && moveOperation === null && pending.postIdentity === undefined) return null;
      if (pending.kind !== "move") {
        const staged = await this.readCortexPendingArtifact(location, manifest);
        if (staged !== null) await this.removePrivateTextArtifact(location.directory, staged);
      }
      const members = manifest.members.map((candidate) => {
        if (candidate.memberId !== member.memberId) return candidate;
        if (candidate.kind === "move") {
          if (pending.kind !== "move") throw vaultWriterError();
          const postIdentity = moveOperation === null
            ? pending.postIdentity
            : Object.freeze({
              targetFile: moveOperation.targetFileIdentity,
              targetDirectory: moveOperation.targetCompanionIdentity,
            });
          if (postIdentity === undefined || !("targetFile" in postIdentity)) throw vaultWriterError();
          return { ...candidate, postIdentity };
        }
        const pendingPostIdentity = pending.postIdentity;
        if (
          (pending.kind !== "write" && pending.kind !== "create") ||
          pendingPostIdentity === null ||
          !("file" in pendingPostIdentity)
        ) {
          throw vaultWriterError();
        }
        return { ...candidate, postIdentity: pendingPostIdentity };
      });
      const rollingManifest = await createCortexTreeTransactionManifest({
        schemaVersion: manifest.schemaVersion,
        transactionId: manifest.transactionId,
        rootPageId: manifest.rootPageId,
        participantIds: manifest.participantIds,
        phase: "rolling-back",
        completedMemberIds: [...manifest.completedMemberIds, member.memberId],
        pendingMember: null,
        ...this.cortexRollbackWalFields(manifest, "clear"),
        members,
      });
      return Object.freeze({
        manifest: rollingManifest,
        location: await this.persistCortexTransactionManifest(location, rollingManifest),
      });
    } catch {
      return null;
    }
  }

  private async resumeCortexRollingBackTransactionWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    lock: CortexMoveLock,
  ): Promise<boolean> {
    try {
      let currentLocation = location;
      let currentManifest = manifest;
      while (true) {
        await this.assertCortexMoveLockOwnership(lock);
        if (currentManifest.phase !== "rolling-back" || currentManifest.pendingMember !== null) return false;
        await this.assertCortexTransactionArtifacts(currentLocation, currentManifest);

        if (this.activeCortexRollbackPending(currentManifest) === null) {
          const uncheckpointed = await this.readUncheckpointedCortexRollbackArtifact(currentLocation, currentManifest);
          if (uncheckpointed !== null) {
            await this.removePrivateTextArtifact(currentLocation.directory, uncheckpointed);
            continue;
          }
        }

        if (this.activeCortexRollbackPending(currentManifest) !== null) {
          const resumed = await this.resumeCortexRollbackPendingMemberWhileLocked(
            currentLocation,
            currentManifest,
            lock,
          );
          if (resumed === null) return false;
          currentLocation = resumed.location;
          currentManifest = resumed.manifest;
          continue;
        }

        const restoredWriteIdentities = await this.verifyCortexRollingBackSnapshot(currentManifest);
        if (restoredWriteIdentities === null) return false;
        if (currentManifest.completedMemberIds.length === 0) {
          await this.removeCortexTransactionArtifacts(currentLocation, currentManifest);
          return true;
        }

        const prepared = await this.prepareCortexRollbackPendingMemberWhileLocked(
          currentLocation,
          currentManifest,
          lock,
          restoredWriteIdentities,
        );
        if (prepared === null) return false;
        currentLocation = prepared.location;
        currentManifest = prepared.manifest;
      }
    } catch {
      return false;
    }
  }

  private async verifyCortexRollingBackSnapshot(
    manifest: CortexTreeTransactionManifest,
  ): Promise<ReadonlyMap<string, FileIdentity> | null> {
    try {
      const restoredWriteIdentities = new Map<string, FileIdentity>();
      for (let index = 0; index < manifest.members.length; index += 1) {
        const member = manifest.members[index]!;
        if (member.kind !== "write" || member.rollbackRestoredIdentity === undefined) continue;
        const observed = await this.readExisting(validateRelativePath(
          this.cortexRollbackCurrentPath(manifest, index, member.relativePath),
        ));
        if (
          observed.byteHash !== member.expectedByteHash ||
          !this.matchesCortexIdentity(member.rollbackRestoredIdentity.file, observed.identity)
        ) {
          return null;
        }
        restoredWriteIdentities.set(member.relativePath, observed.identity);
      }
      for (let index = 0; index < manifest.completedMemberIds.length; index += 1) {
        const member = manifest.members[index];
        if (member === undefined) {
          return null;
        }
        const valid = member.kind === "move" && this.latestCortexPublishedWriteForPath(manifest, index, "none") !== null
          ? await this.verifyCortexCompletedMemberPostconditionBeforeRollback(manifest, index, "none")
          : await this.verifyCortexManifestMemberPostcondition(member, restoredWriteIdentities);
        if (!valid) {
          return null;
        }
      }
      for (let index = manifest.completedMemberIds.length; index < manifest.members.length; index += 1) {
        const member = manifest.members[index]!;
        if (member.kind === "write") {
          const source = await this.readCortexWritePreimageSource(manifest.members, index, member.relativePath);
          if (source.byteHash !== member.expectedByteHash) return null;
        } else {
          await this.assertCortexManifestMemberPrecondition(member);
        }
      }
      return restoredWriteIdentities;
    } catch {
      return null;
    }
  }

  private cortexRollbackCurrentPath(
    manifest: CortexTreeTransactionManifest,
    memberIndex: number,
    relativePath: string,
  ): string {
    let currentPath = relativePath;
    for (let prior = memberIndex - 1; prior >= manifest.completedMemberIds.length; prior -= 1) {
      const member = manifest.members[prior]!;
      if (member.kind !== "move") continue;
      if (currentPath === member.targetPath) {
        currentPath = member.sourcePath;
        continue;
      }
      const targetDirectory = member.targetPath.slice(0, -3);
      const sourceDirectory = member.sourcePath.slice(0, -3);
      if (currentPath.startsWith(`${targetDirectory}/`)) {
        currentPath = `${sourceDirectory}${currentPath.slice(targetDirectory.length)}`;
      }
    }
    return currentPath;
  }

  private async prepareCortexRollbackPendingMemberWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    lock: CortexMoveLock,
    restoredWriteIdentities: ReadonlyMap<string, FileIdentity>,
  ): Promise<CortexRollbackMemberPreparation | null> {
    try {
      await this.assertCortexMoveLockOwnership(lock);
      const member = manifest.members[manifest.completedMemberIds.length - 1];
      if (
        member === undefined ||
        member.postIdentity === undefined ||
        !(await this.verifyCortexManifestMemberPostcondition(member, restoredWriteIdentities))
      ) {
        return null;
      }
      let rollbackPending: CortexTreeTransactionRollbackPendingMember;
      if (member.kind === "write") {
        const preimage = await this.readCortexTransactionPreimage(location, member);
        if (await sha256Hex(preimage) !== member.expectedByteHash) return null;
        const staged = await this.createPrivateTextArtifact(
          location.directory,
          this.cortexRollbackArtifactName(member.memberId),
          preimage,
        );
        rollbackPending = Object.freeze({
          memberId: member.memberId,
          kind: "write",
          expectedNewIdentity: { file: member.postIdentity.file },
          intendedOldIdentity: { file: this.cortexIdentity(staged.identity) },
        });
      } else if (member.kind === "create") {
        rollbackPending = Object.freeze({
          memberId: member.memberId,
          kind: "create",
          expectedNewIdentity: { file: member.postIdentity.file },
          intendedOldAbsent: true,
        });
      } else {
        const paths = cortexMovePaths({
          sourcePath: member.sourcePath,
          targetPath: member.targetPath,
          expectedSourceByteHash: member.expectedSourceByteHash,
        });
        const target = await this.readExisting(paths.targetFileSegments);
        const targetDirectory = await this.optionalExistingDirectory(paths.targetDirectorySegments);
        if (
          target.byteHash !== member.resultByteHash ||
          (member.postIdentity.targetDirectory === null
            ? targetDirectory !== null
            : targetDirectory === null || !this.matchesCortexIdentity(member.postIdentity.targetDirectory, targetDirectory.identity))
        ) {
          return null;
        }
        const targetFileIdentity = this.cortexIdentity(target.identity);
        const targetCompanionIdentity = targetDirectory === null ? null : this.cortexIdentity(targetDirectory.identity);
        rollbackPending = Object.freeze({
          memberId: member.memberId,
          kind: "move",
          moveOperation: Object.freeze({
            direction: "reverse",
            // Reverse starts at the published topology.  Every actual inverse
            // mutation advances this expanded WAL before it touches a name.
            stage: "pre-link",
            sourceFileIdentity: targetFileIdentity,
            targetFileIdentity,
            sourceCompanionIdentity: targetCompanionIdentity,
            targetCompanionIdentity,
            reservationIdentity: null,
          }),
        });
      }
      const nextManifest = await this.manifestWithRollbackPending(manifest, rollbackPending);
      return Object.freeze({
        manifest: nextManifest,
        location: await this.persistCortexTransactionManifest(location, nextManifest),
      });
    } catch {
      return null;
    }
  }

  private async resumeCortexRollbackPendingMemberWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    lock: CortexMoveLock,
  ): Promise<CortexRollbackMemberPreparation | null> {
    try {
      await this.assertCortexMoveLockOwnership(lock);
      const rollback = this.activeCortexRollbackPending(manifest);
      const member = manifest.members[manifest.completedMemberIds.length - 1];
      if (
        rollback === null ||
        member === undefined ||
        member.memberId !== rollback.memberId ||
        member.kind !== rollback.kind ||
        member.postIdentity === undefined
      ) {
        return null;
      }
      if (member.kind === "write") {
        if (rollback.kind !== "write") return null;
        const target = await this.optionalReadExisting(validateRelativePath(member.relativePath));
        const staged = await this.readCortexRollbackArtifact(location, manifest);
        const isNew = target !== null &&
          target.byteHash === member.resultByteHash &&
          this.matchesCortexIdentity(rollback.expectedNewIdentity.file, target.identity);
        const isOld = target !== null &&
          target.byteHash === member.expectedByteHash &&
          this.matchesCortexIdentity(rollback.intendedOldIdentity.file, target.identity);
        if (isNew) {
          if (target === null || staged === null) return null;
          await rename(staged.path, target.targetPath);
          await this.syncDirectory(staged.parentPath);
          await this.syncDirectory(target.parentPath);
          const restored = await this.readExisting(validateRelativePath(member.relativePath));
          if (
            restored.byteHash !== member.expectedByteHash ||
            !this.matchesCortexIdentity(rollback.intendedOldIdentity.file, restored.identity)
          ) {
            return null;
          }
        } else if (!isOld || staged !== null) {
          return null;
        }
      } else if (member.kind === "create") {
        if (rollback.kind !== "create") return null;
        const target = await this.optionalReadExisting(validateRelativePath(member.relativePath));
        if (target === null) {
          // The unlink completed before its durable progress checkpoint.
        } else {
          if (
            target.byteHash !== member.resultByteHash ||
            !this.matchesCortexIdentity(rollback.expectedNewIdentity.file, target.identity)
          ) {
            return null;
          }
          await unlink(target.targetPath);
          await this.syncDirectory(target.parentPath);
          await this.assertAbsentTarget(validateRelativePath(member.relativePath));
        }
      } else {
        if (rollback.kind !== "move") return null;
        let operation = this.cortexRollbackMoveOperation(rollback);
        if (operation === null) {
          const migration = this.legacyCortexRollbackMoveMigrationOperation(rollback);
          const reverseLayout = await this.classifyCortexManifestMoveLayout(
            location,
            this.reversedCortexManifestMoveMember(member),
            migration,
          );
          if (reverseLayout?.layout !== "published") {
            if (reverseLayout?.layout !== "old") return null;
            const migratedManifest = await this.manifestWithRollbackMoveOperation(manifest, migration);
            location = await this.persistCortexTransactionManifest(location, migratedManifest);
            manifest = migratedManifest;
            operation = migration;
          }
        }
        if (operation !== null) {
          const executed = await this.executeCortexManifestMoveForMemberWhileLocked(
            location,
            manifest,
            "reverse",
            member,
            operation,
            lock,
          );
          const recovered = await this.classifyCortexManifestMoveLayout(executed.location, member, operation);
          if (recovered?.layout !== "old") return null;
          location = executed.location;
          manifest = executed.manifest;
        }
      }
      const nextManifest = await this.manifestWithRollbackProgress(manifest);
      return Object.freeze({
        manifest: nextManifest,
        location: await this.persistCortexTransactionManifest(location, nextManifest),
      });
    } catch {
      return null;
    }
  }

  private async classifyCortexPendingRecoveryState(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
  ): Promise<CortexPendingRecoveryState | null> {
    const pending = manifest.pendingMember;
    const member = this.pendingCortexManifestMember(manifest);
    if (pending === null || member === null) return "none";
    if (pending.kind === "move" && member.kind === "move") {
      return this.classifyCortexPendingMoveRecoveryState(location, member, pending);
    }
    const artifact = await this.readCortexPendingArtifact(location, manifest);
    try {
      await this.assertCortexPendingManifestMemberPrecondition(member, pending);
      if (pending.state === "ready" && pending.kind !== "move" && artifact === null) return null;
      return "old";
    } catch {
      // A ready checkpoint can instead prove that exactly its staged output became visible.
    }
    if (pending.state !== "ready") return null;
    return (await this.verifyCortexPendingMemberPostcondition(member, pending, location)) ? "published" : null;
  }

  private async classifyCortexPendingMoveRecoveryState(
    location: CortexTransactionManifestLocation,
    member: Extract<CortexTreeTransactionManifestMember, { readonly kind: "move" }>,
    pending: CortexPendingMoveMember,
  ): Promise<Extract<CortexPendingRecoveryState, "old" | "published" | "target-linked" | "private-reserved" | "companion-reserved" | "companion-moved"> | null> {
    try {
      const operation = this.cortexMoveOperationFromPending(pending);
      if (operation !== null) {
        return (await this.classifyCortexManifestMoveLayout(location, member, operation))?.layout ?? null;
      }
      // Legacy ready records are deliberately read-only compatibility.  They
      // can prove only the all-old or all-published topology; an intermediate
      // namespace layout was never durably described by that format.
      if (pending.state !== "ready") return null;
      const paths = cortexMovePaths({
        sourcePath: member.sourcePath,
        targetPath: member.targetPath,
        expectedSourceByteHash: member.expectedSourceByteHash,
      });
      const source = await this.optionalReadExisting(paths.sourceFileSegments);
      const target = await this.optionalReadExisting(paths.targetFileSegments);
      const sourceDirectory = await this.optionalExistingDirectory(paths.sourceDirectorySegments);
      const targetDirectory = await this.optionalExistingDirectory(paths.targetDirectorySegments);
      const reservationIdentity = pending.reservationIdentity ?? null;
      const sourceMatches = source !== null &&
        source.byteHash === member.expectedSourceByteHash &&
        this.matchesCortexIdentity(pending.preIdentity.sourceFile, source.identity);
      const targetMatches = target !== null &&
        target.byteHash === member.resultByteHash &&
        this.matchesCortexIdentity(pending.postIdentity.targetFile, target.identity);
      const sourceDirectoryMatches = pending.preIdentity.sourceDirectory === null
        ? sourceDirectory === null
        : sourceDirectory !== null && this.matchesCortexIdentity(pending.preIdentity.sourceDirectory, sourceDirectory.identity);
      const targetDirectoryMatches = pending.postIdentity.targetDirectory === null
        ? targetDirectory === null
        : targetDirectory !== null && this.matchesCortexIdentity(pending.postIdentity.targetDirectory, targetDirectory.identity);
      const linked = sourceMatches && targetMatches && source !== null && target !== null && sameIdentity(source.identity, target.identity);
      const allOld = sourceMatches && target === null && sourceDirectoryMatches && targetDirectory === null;
      const allNew = source === null && targetMatches && sourceDirectory === null && targetDirectoryMatches;
      if (reservationIdentity !== null || !linked) return allOld ? "old" : allNew ? "published" : null;
      return allOld ? "old" : allNew ? "published" : null;
    } catch {
      return null;
    }
  }

  private async assertCortexPendingManifestMemberPrecondition(
    member: CortexTreeTransactionManifestMember,
    pending: CortexTreeTransactionPendingMember,
  ): Promise<void> {
    if (member.memberId !== pending.memberId || member.kind !== pending.kind) throw vaultWriterError();
    if (member.kind === "write") {
      if (pending.kind !== "write") throw vaultWriterError();
      const observed = await this.readExisting(validateRelativePath(member.relativePath));
      if (
        observed.byteHash !== member.expectedByteHash ||
        !this.matchesCortexIdentity(pending.preIdentity, observed.identity)
      ) {
        throw vaultWriterError();
      }
      return;
    }
    if (member.kind === "create") {
      if (pending.kind !== "create") throw vaultWriterError();
      if (pending.preIdentity !== null) throw vaultWriterError();
      await this.assertAbsentTarget(validateRelativePath(member.relativePath));
      return;
    }
    if (pending.kind !== "move") throw vaultWriterError();
    const paths = cortexMovePaths({
      sourcePath: member.sourcePath,
      targetPath: member.targetPath,
      expectedSourceByteHash: member.expectedSourceByteHash,
    });
    const source = await this.readExisting(paths.sourceFileSegments);
    const sourceDirectory = await this.optionalExistingDirectory(paths.sourceDirectorySegments);
    if (
      source.byteHash !== member.expectedSourceByteHash ||
      !this.matchesCortexIdentity(pending.preIdentity.sourceFile, source.identity) ||
      (pending.preIdentity.sourceDirectory === null
        ? sourceDirectory !== null
        : sourceDirectory === null || !this.matchesCortexIdentity(pending.preIdentity.sourceDirectory, sourceDirectory.identity))
    ) {
      throw vaultWriterError();
    }
    await this.assertAbsentTarget(paths.targetFileSegments);
    await this.assertAbsentTarget(paths.targetDirectorySegments);
  }

  private async verifyCortexPendingMemberPostcondition(
    member: CortexTreeTransactionManifestMember,
    pending: CortexTreeTransactionPendingMember,
    location?: CortexTransactionManifestLocation,
  ): Promise<boolean> {
    try {
      if (member.kind !== pending.kind) return false;
      if (member.kind === "move") {
        if (pending.kind !== "move") return false;
        if (location === undefined) return false;
        return (await this.classifyCortexPendingMoveRecoveryState(location, member, pending)) === "published";
      }
      if (pending.postIdentity === null) return false;
      if (member.kind === "write") {
        if (pending.kind !== "write" || !("file" in pending.postIdentity)) return false;
        if (!("file" in pending.postIdentity)) return false;
        const observed = await this.readExisting(validateRelativePath(member.relativePath));
        return (
          observed.byteHash === member.resultByteHash &&
          this.matchesCortexIdentity(pending.postIdentity.file, observed.identity)
        );
      }
      if (member.kind === "create") {
        if (pending.kind !== "create" || !("file" in pending.postIdentity)) return false;
        const observed = await this.readExisting(validateRelativePath(member.relativePath));
        return (
          observed.byteHash === member.resultByteHash &&
          this.matchesCortexIdentity(pending.postIdentity.file, observed.identity)
        );
      }
      return false;
    } catch {
      return false;
    }
  }

  private async verifyCortexCompletedMemberPostconditionBeforeRollback(
    manifest: CortexTreeTransactionManifest,
    memberIndex: number,
    pendingState: CortexPendingRecoveryState,
  ): Promise<boolean> {
    const member = manifest.members[memberIndex];
    if (member === undefined || memberIndex >= manifest.completedMemberIds.length || member.postIdentity === undefined) return false;
    try {
      if (member.kind === "write" || member.kind === "create") {
        return await this.verifyCortexManifestMemberPostcondition(member);
      }
      const paths = cortexMovePaths({
        sourcePath: member.sourcePath,
        targetPath: member.targetPath,
        expectedSourceByteHash: member.expectedSourceByteHash,
      });
      const target = await this.readExisting(paths.targetFileSegments);
      const targetDirectory = await this.optionalExistingDirectory(paths.targetDirectorySegments);
      const laterWrite = this.latestCortexPublishedWriteForPath(manifest, memberIndex, pendingState);
      const expectedTargetHash = laterWrite === null ? member.resultByteHash : laterWrite.byteHash;
      const expectedTargetIdentity = laterWrite === null ? member.postIdentity.targetFile : laterWrite.identity;
      if (
        target.byteHash !== expectedTargetHash ||
        !this.matchesCortexIdentity(expectedTargetIdentity, target.identity) ||
        (member.postIdentity.targetDirectory === null
          ? targetDirectory !== null
          : targetDirectory === null || !this.matchesCortexIdentity(member.postIdentity.targetDirectory, targetDirectory.identity))
      ) {
        return false;
      }
      await this.assertAbsentTarget(paths.sourceFileSegments);
      return (await this.optionalExistingDirectory(paths.sourceDirectorySegments)) === null;
    } catch {
      return false;
    }
  }

  private latestCortexPublishedWriteForPath(
    manifest: CortexTreeTransactionManifest,
    moveIndex: number,
    pendingState: CortexPendingRecoveryState,
  ): Readonly<{ byteHash: string; identity: Readonly<{ dev: string; ino: string }> }> | null {
    const move = manifest.members[moveIndex];
    if (move === undefined || move.kind !== "move") return null;
    for (let index = manifest.completedMemberIds.length - 1; index > moveIndex; index -= 1) {
      const member = manifest.members[index]!;
      if (member.kind === "write" && member.relativePath === move.targetPath && member.postIdentity !== undefined) {
        return Object.freeze({ byteHash: member.resultByteHash, identity: member.postIdentity.file });
      }
    }
    const pending = manifest.pendingMember;
    if (
      pendingState === "published" &&
      pending !== null &&
      pending.kind === "write" &&
      pending.postIdentity !== null &&
      pending.memberId === manifest.members[manifest.completedMemberIds.length]?.memberId &&
      pending.memberId !== move.memberId
    ) {
      const member = manifest.members[manifest.completedMemberIds.length];
      if (member?.kind === "write" && member.relativePath === move.targetPath && "file" in pending.postIdentity) {
        return Object.freeze({ byteHash: member.resultByteHash, identity: pending.postIdentity.file });
      }
    }
    return null;
  }

  private async rollbackCortexPendingMemberWhileLocked(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
    lock: CortexMoveLock,
    state: CortexPendingRecoveryState,
  ): Promise<CortexPendingRollback | null> {
    const pending = manifest.pendingMember;
    const member = this.pendingCortexManifestMember(manifest);
    if (state === "none" || pending === null || member === null) {
      return this.cortexPendingRollback(location, manifest);
    }
    try {
      await this.assertCortexMoveLockOwnership(lock);
      if (member.kind === "move" && pending.kind === "move") {
        const operation = this.cortexMoveOperationFromPending(pending);
        const preimage = await this.readCortexTransactionPreimage(location, member);
        if (await sha256Hex(preimage) !== member.expectedSourceByteHash) return null;
        if (operation !== null) {
          // An expanded forward WAL must either be completed and promoted by
          // the caller or already be at the untouched all-old layout.
          if (state !== "old") return null;
          return this.cortexPendingRollback(location, manifest);
        }
        const executed = await this.executeCortexManifestMoveForMemberWhileLocked(
          location,
          manifest,
          "reverse",
          member,
          this.legacyCortexMoveExecutionOperation(pending),
          lock,
        );
        const recoveredPending = executed.manifest.pendingMember;
        if (recoveredPending === null || recoveredPending.kind !== "move") return null;
        const recoveredState = await this.classifyCortexPendingMoveRecoveryState(
          executed.location,
          member,
          recoveredPending,
        );
        if (recoveredState !== "old") return null;
        return this.cortexPendingRollback(executed.location, executed.manifest);
      }
      if (state === "old") {
        const staged = await this.readCortexPendingArtifact(location, manifest);
        if (staged !== null) await this.removePrivateTextArtifact(location.directory, staged);
        return this.cortexPendingRollback(location, manifest);
      }
      if (!(await this.verifyCortexPendingMemberPostcondition(member, pending, location))) return null;
      if (member.kind === "write") {
        const preimage = await this.readCortexTransactionPreimage(location, member);
        if (await sha256Hex(preimage) !== member.expectedByteHash) return null;
        await this.write({
          relativePath: member.relativePath,
          expectedByteHash: member.resultByteHash,
          content: preimage,
        });
        const restored = await this.readExisting(validateRelativePath(member.relativePath));
        if (restored.byteHash !== member.expectedByteHash) return null;
        const staged = await this.readCortexPendingArtifact(location, manifest);
        if (staged !== null) await this.removePrivateTextArtifact(location.directory, staged);
        return this.cortexPendingRollback(
          location,
          manifest,
          Object.freeze({ memberId: member.memberId, relativePath: member.relativePath, identity: restored.identity }),
        );
      }
      if (member.kind === "create") {
        const observed = await this.readExisting(validateRelativePath(member.relativePath));
        if (
          pending.postIdentity === null ||
          !("file" in pending.postIdentity) ||
          observed.byteHash !== member.resultByteHash ||
          !this.matchesCortexIdentity(pending.postIdentity.file, observed.identity)
        ) {
          return null;
        }
        await unlink(observed.targetPath);
        await this.syncDirectory(observed.parentPath);
        await this.assertAbsentTarget(validateRelativePath(member.relativePath));
        const staged = await this.readCortexPendingArtifact(location, manifest);
        if (staged !== null) await this.removePrivateTextArtifact(location.directory, staged);
        return this.cortexPendingRollback(location, manifest);
      }
      return null;
    } catch {
      return null;
    }
  }

  private legacyCortexMoveExecutionOperation(
    pending: CortexPendingMoveMember,
  ): CortexMoveExecutionOperation {
    return Object.freeze({
      direction: "reverse",
      stage: "source-unlinked",
      sourceFileIdentity: pending.preIdentity.sourceFile,
      targetFileIdentity: pending.postIdentity.targetFile,
      sourceCompanionIdentity: pending.preIdentity.sourceDirectory,
      targetCompanionIdentity: pending.postIdentity.targetDirectory,
      // Legacy ready records never recorded a private reservation.  This is
      // intentionally execution-only and is never serialized as a new WAL.
      reservationIdentity: null,
    });
  }

  private legacyCortexRollbackMoveMigrationOperation(
    rollback: CortexRollbackPending,
  ): CortexTreeTransactionMoveOperation {
    if (rollback.kind !== "move" || "moveOperation" in rollback) throw vaultWriterError();
    return Object.freeze({
      direction: "reverse",
      stage: "pre-link",
      sourceFileIdentity: rollback.expectedNewIdentity.targetFile,
      targetFileIdentity: rollback.expectedNewIdentity.targetFile,
      sourceCompanionIdentity: rollback.expectedNewIdentity.targetDirectory,
      targetCompanionIdentity: rollback.expectedNewIdentity.targetDirectory,
      reservationIdentity: null,
    });
  }

  private async verifyCortexManifestMemberPostcondition(
    member: CortexTreeTransactionManifestMember,
    restoredWriteIdentities: ReadonlyMap<string, FileIdentity> = new Map(),
  ): Promise<boolean> {
    try {
      if (member.postIdentity === undefined) return false;
      if (member.kind === "write" || member.kind === "create") {
        const observed = await this.readExisting(validateRelativePath(member.relativePath));
        return (
          observed.byteHash === member.resultByteHash &&
          this.matchesCortexIdentity(member.postIdentity.file, observed.identity)
        );
      }
      const paths = cortexMovePaths({
        sourcePath: member.sourcePath,
        targetPath: member.targetPath,
        expectedSourceByteHash: member.expectedSourceByteHash,
      });
      const target = await this.readExisting(paths.targetFileSegments);
      const targetDirectory = await this.optionalExistingDirectory(paths.targetDirectorySegments);
      const expectedTargetIdentity = this.matchesCortexIdentity(member.postIdentity.targetFile, target.identity) || (
        restoredWriteIdentities.has(member.targetPath) &&
        sameIdentity(restoredWriteIdentities.get(member.targetPath)!, target.identity)
      );
      if (
        target.byteHash !== member.resultByteHash ||
        !expectedTargetIdentity ||
        (member.postIdentity.targetDirectory === null
          ? targetDirectory !== null
          : targetDirectory === null || !this.matchesCortexIdentity(member.postIdentity.targetDirectory, targetDirectory.identity))
      ) {
        return false;
      }
      await this.assertAbsentTarget(paths.sourceFileSegments);
      return (await this.optionalExistingDirectory(paths.sourceDirectorySegments)) === null;
    } catch {
      return false;
    }
  }

  private async readCortexTransactionPreimage(
    location: CortexTransactionManifestLocation,
    member: Exclude<CortexTreeTransactionManifestMember, { readonly kind: "create" }>,
  ): Promise<string> {
    const artifact = await this.readPrivateTextArtifact(location.directory, member.preimageFile, MAX_LOCAL_NOTE_BYTES);
    return artifact.content;
  }

  private async removeCortexTransactionArtifacts(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
  ): Promise<void> {
    await this.assertCortexTransactionArtifacts(location, manifest);
    const manifestArtifact = await this.readPrivateTextArtifact(
      location.directory,
      CORTEX_TRANSACTION_MANIFEST_FILENAME,
      MAX_CORTEX_TRANSACTION_MANIFEST_BYTES,
    );
    for (const member of manifest.members) {
      if (member.kind === "create") continue;
      const artifact = await this.readPrivateTextArtifact(location.directory, member.preimageFile, MAX_LOCAL_NOTE_BYTES);
      await this.removePrivateTextArtifact(location.directory, artifact);
    }
    const pendingArtifact = await this.readCortexPendingArtifact(location, manifest);
    if (pendingArtifact !== null) await this.removePrivateTextArtifact(location.directory, pendingArtifact);
    const pendingReservation = await this.readCortexManifestMoveReservation(location, manifest);
    if (pendingReservation !== null && pendingReservation.reservation !== null) {
      await this.removePrivateCortexMoveReservation(
        location.directory,
        pendingReservation.memberId,
        this.cortexIdentity(pendingReservation.reservation.identity),
      );
    }
    await this.removePrivateTextArtifact(location.directory, manifestArtifact);
    await this.assertPrivateCortexDirectory(location.directory.directoryPath, location.directory.identity);
    if ((await readdir(location.directory.directoryPath)).length !== 0) throw vaultWriterError();
    await rmdir(location.directory.directoryPath);
    await this.syncDirectory(location.directory.parentPath);
  }

  private async assertCortexTransactionArtifacts(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
  ): Promise<void> {
    const expectedNames = [
      CORTEX_TRANSACTION_MANIFEST_FILENAME,
      ...manifest.members
        .filter((member): member is Exclude<CortexTreeTransactionManifestMember, { readonly kind: "create" }> => member.kind !== "create")
        .map((member) => member.preimageFile),
    ].sort();
    await this.assertPrivateCortexDirectory(location.directory.directoryPath, location.directory.identity);
    const entries = (await readdir(location.directory.directoryPath, { withFileTypes: true }))
      .map((entry) => entry.name)
      .sort();
    const pendingArtifactName = manifest.pendingMember === null || manifest.pendingMember.kind === "move"
      ? null
      : this.cortexPendingArtifactName(manifest.pendingMember.memberId);
    const rollback = this.activeCortexRollbackPending(manifest);
    const rollbackArtifactName = rollback?.kind === "write"
      ? this.cortexRollbackArtifactName(rollback.memberId)
      : null;
    const pendingReservation = this.cortexManifestMoveReservationManifestState(manifest);
    const pendingReservationName = pendingReservation === null
      ? null
      : this.cortexMoveReservationArtifactName(pendingReservation.memberId);
    const uncheckpointedRollbackMember = this.uncheckpointedCortexRollbackWriteMember(manifest);
    const uncheckpointedRollbackArtifactName = uncheckpointedRollbackMember === null
      ? null
      : this.cortexRollbackArtifactName(uncheckpointedRollbackMember.memberId);
    const baseAllowedEntrySets = [
      expectedNames,
      ...(pendingArtifactName === null ? [] : [[...expectedNames, pendingArtifactName].sort()]),
      ...(rollbackArtifactName === null ? [] : [[...expectedNames, rollbackArtifactName].sort()]),
      ...(uncheckpointedRollbackArtifactName === null
        ? []
        : [[...expectedNames, uncheckpointedRollbackArtifactName].sort()]),
      ...(pendingArtifactName === null || rollbackArtifactName === null
        ? []
        : [[...expectedNames, pendingArtifactName, rollbackArtifactName].sort()]),
    ];
    const allowedEntrySets = pendingReservationName === null
      ? baseAllowedEntrySets
      : [
        ...baseAllowedEntrySets,
        ...baseAllowedEntrySets.map((expected) => [...expected, pendingReservationName].sort()),
      ];
    if (!allowedEntrySets.some((expected) => entries.length === expected.length && entries.every((entry, index) => entry === expected[index]))) {
      throw vaultWriterError();
    }
    const manifestArtifact = await this.readPrivateTextArtifact(
      location.directory,
      CORTEX_TRANSACTION_MANIFEST_FILENAME,
      MAX_CORTEX_TRANSACTION_MANIFEST_BYTES,
    );
    if (
      !sameIdentity(location.manifestIdentity, manifestArtifact.identity) ||
      manifestArtifact.content !== location.manifestContent
    ) {
      throw vaultWriterError();
    }
    for (const member of manifest.members) {
      if (member.kind === "create") continue;
      const artifact = await this.readPrivateTextArtifact(location.directory, member.preimageFile, MAX_LOCAL_NOTE_BYTES);
      const expectedHash = member.kind === "move" ? member.expectedSourceByteHash : member.expectedByteHash;
      if (await sha256Hex(artifact.content) !== expectedHash) throw vaultWriterError();
    }
    await this.readCortexPendingArtifact(location, manifest);
    await this.readCortexManifestMoveReservation(location, manifest);
    await this.readCortexRollbackArtifact(location, manifest);
    await this.readUncheckpointedCortexRollbackArtifact(location, manifest);
  }

  private pendingCortexManifestMember(
    manifest: CortexTreeTransactionManifest,
  ): CortexTreeTransactionManifestMember | null {
    const pending = manifest.pendingMember;
    if (pending === null) return null;
    const member = manifest.members[manifest.completedMemberIds.length];
    if (member === undefined || member.memberId !== pending.memberId || member.kind !== pending.kind) {
      throw vaultWriterError();
    }
    return member;
  }

  private pendingCortexMoveReservationManifestState(
    manifest: CortexTreeTransactionManifest,
  ): Readonly<{ memberId: string; operation: CortexTreeTransactionMoveOperation }> | null {
    const pending = manifest.pendingMember;
    if (pending === null || pending.kind !== "move") return null;
    const operation = this.cortexMoveOperationFromPending(pending);
    if (operation === null) return null;
    if (operation.stage !== "companion-reserve" && operation.stage !== "companion-reserved") return null;
    if (
      operation.stage === "companion-reserve" &&
      operation.reservationIdentity !== null
    ) {
      throw vaultWriterError();
    }
    if (
      operation.stage === "companion-reserved" &&
      operation.reservationIdentity === null
    ) {
      throw vaultWriterError();
    }
    return Object.freeze({ memberId: pending.memberId, operation });
  }

  private rollbackCortexMoveReservationManifestState(
    manifest: CortexTreeTransactionManifest,
  ): Readonly<{ memberId: string; operation: CortexTreeTransactionMoveOperation }> | null {
    const rollback = this.activeCortexRollbackPending(manifest);
    if (rollback === null || rollback.kind !== "move") return null;
    const operation = this.cortexRollbackMoveOperation(rollback);
    if (operation === null) return null;
    if (operation.stage !== "companion-reserve" && operation.stage !== "companion-reserved") return null;
    if (operation.stage === "companion-reserve" && operation.reservationIdentity !== null) throw vaultWriterError();
    if (operation.stage === "companion-reserved" && operation.reservationIdentity === null) throw vaultWriterError();
    return Object.freeze({ memberId: rollback.memberId, operation });
  }

  private cortexManifestMoveReservationManifestState(
    manifest: CortexTreeTransactionManifest,
  ): Readonly<{ memberId: string; operation: CortexTreeTransactionMoveOperation }> | null {
    const pending = this.pendingCortexMoveReservationManifestState(manifest);
    const rollback = this.rollbackCortexMoveReservationManifestState(manifest);
    if (pending !== null && rollback !== null) throw vaultWriterError();
    return pending ?? rollback;
  }

  private async readCortexManifestMoveReservation(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
  ): Promise<Readonly<{ memberId: string; reservation: ExistingDirectory | null }> | null> {
    const state = this.cortexManifestMoveReservationManifestState(manifest);
    if (state === null) return null;
    const expected = state.operation.stage === "companion-reserved"
      ? state.operation.reservationIdentity ?? undefined
      : undefined;
    return Object.freeze({
      memberId: state.memberId,
      reservation: await this.readPrivateCortexMoveReservation(location.directory, state.memberId, expected),
    });
  }

  private async readCortexPendingArtifact(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
  ): Promise<PrivateTextEvidence | null> {
    const pending = manifest.pendingMember;
    const member = this.pendingCortexManifestMember(manifest);
    if (pending === null || member === null || pending.kind === "move") return null;
    const artifact = await this.optionalPrivateTextArtifact(
      location.directory,
      this.cortexPendingArtifactName(pending.memberId),
      MAX_LOCAL_NOTE_BYTES,
    );
    if (artifact === null) return null;
    if (await sha256Hex(artifact.content) !== member.resultByteHash) throw vaultWriterError();
    if (
      pending.state === "ready" &&
      (pending.postIdentity === null ||
        !("file" in pending.postIdentity) ||
        !this.matchesCortexIdentity(pending.postIdentity.file, artifact.identity))
    ) {
      throw vaultWriterError();
    }
    return artifact;
  }

  private async readCortexRollbackArtifact(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
  ): Promise<PrivateTextEvidence | null> {
    const rollback = this.activeCortexRollbackPending(manifest);
    if (rollback === null || rollback.kind !== "write") return null;
    const member = manifest.members[manifest.completedMemberIds.length - 1];
    if (
      member === undefined ||
      member.kind !== "write" ||
      member.memberId !== rollback.memberId
    ) {
      throw vaultWriterError();
    }
    const artifact = await this.optionalPrivateTextArtifact(
      location.directory,
      this.cortexRollbackArtifactName(rollback.memberId),
      MAX_LOCAL_NOTE_BYTES,
    );
    if (artifact === null) return null;
    if (
      await sha256Hex(artifact.content) !== member.expectedByteHash ||
      !this.matchesCortexIdentity(rollback.intendedOldIdentity.file, artifact.identity)
    ) {
      throw vaultWriterError();
    }
    return artifact;
  }

  private uncheckpointedCortexRollbackWriteMember(
    manifest: CortexTreeTransactionManifest,
  ): Extract<CortexTreeTransactionManifestMember, { readonly kind: "write" }> | null {
    if (manifest.phase !== "rolling-back" || this.activeCortexRollbackPending(manifest) !== null) return null;
    const member = manifest.members[manifest.completedMemberIds.length - 1];
    return member?.kind === "write" && member.postIdentity !== undefined ? member : null;
  }

  private async readUncheckpointedCortexRollbackArtifact(
    location: CortexTransactionManifestLocation,
    manifest: CortexTreeTransactionManifest,
  ): Promise<PrivateTextEvidence | null> {
    const member = this.uncheckpointedCortexRollbackWriteMember(manifest);
    if (member === null) return null;
    const artifact = await this.optionalPrivateTextArtifact(
      location.directory,
      this.cortexRollbackArtifactName(member.memberId),
      MAX_LOCAL_NOTE_BYTES,
    );
    if (artifact === null) return null;
    const postIdentity = member.postIdentity;
    if (postIdentity === undefined) throw vaultWriterError();
    const target = await this.readExisting(validateRelativePath(member.relativePath));
    if (
      await sha256Hex(artifact.content) !== member.expectedByteHash ||
      target.byteHash !== member.resultByteHash ||
      !this.matchesCortexIdentity(postIdentity.file, target.identity)
    ) {
      throw vaultWriterError();
    }
    return artifact;
  }

  private async removePrivateTextArtifact(directory: ExistingDirectory, artifact: PrivateTextEvidence): Promise<void> {
    await this.assertPrivateCortexDirectory(directory.directoryPath, directory.identity);
    const observed = await lstat(artifact.path);
    if (
      observed.isSymbolicLink() ||
      !observed.isFile() ||
      (observed.mode & 0o777) !== PRIVATE_FILE_MODE ||
      !sameIdentity(artifact.identity, { dev: observed.dev, ino: observed.ino })
    ) {
      throw vaultWriterError();
    }
    await unlink(artifact.path);
    await this.syncDirectory(directory.directoryPath);
  }

  private targetPaths(segments: readonly string[]): Readonly<{ targetPath: string; parentPath: string }> {
    const targetPath = join(this.root.canonicalRealPath, ...segments);
    if (!isBeneath(this.root.canonicalRealPath, targetPath)) {
      throw vaultWriterError();
    }
    return { targetPath, parentPath: join(this.root.canonicalRealPath, ...segments.slice(0, -1)) };
  }

  private async assertExistingDirectory(path: string): Promise<void> {
    await this.assertRoot();
    if (path !== this.root.canonicalRealPath && !isBeneath(this.root.canonicalRealPath, path)) {
      throw vaultWriterError();
    }
    const named = await lstat(path);
    if (named.isSymbolicLink() || !named.isDirectory()) {
      throw vaultWriterError();
    }
    const canonical = await realpath(path);
    if (canonical !== path) {
      throw vaultWriterError();
    }
  }

  private async readExistingDirectory(segments: readonly string[]): Promise<ExistingDirectory> {
    await this.assertRoot();
    const paths = this.targetPaths(segments);
    let current = this.root.canonicalRealPath;
    for (const segment of segments) {
      current = join(current, segment);
      await this.assertExistingDirectory(current);
    }
    const named = await lstat(paths.targetPath);
    if (named.isSymbolicLink() || !named.isDirectory()) throw vaultWriterError();
    await this.assertDirectoryTreeNoSymlinks(paths.targetPath);
    return {
      directoryPath: paths.targetPath,
      parentPath: paths.parentPath,
      identity: { dev: named.dev, ino: named.ino },
    };
  }

  private async optionalExistingDirectory(segments: readonly string[]): Promise<ExistingDirectory | null> {
    try {
      return await this.readExistingDirectory(segments);
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw vaultWriterError();
    }
  }

  private async assertDirectoryTreeNoSymlinks(directoryPath: string): Promise<void> {
    await this.assertExistingDirectory(directoryPath);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const childPath = join(directoryPath, entry.name);
      const named = await lstat(childPath);
      if (named.isSymbolicLink()) throw vaultWriterError();
      if (named.isDirectory()) {
        if ((await realpath(childPath)) !== childPath) throw vaultWriterError();
        await this.assertDirectoryTreeNoSymlinks(childPath);
      } else if (named.isFile()) {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(childPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          const opened = await handle.stat();
          const afterOpen = await lstat(childPath);
          if (
            !opened.isFile() ||
            afterOpen.isSymbolicLink() ||
            !afterOpen.isFile() ||
            !sameIdentity({ dev: named.dev, ino: named.ino }, opened) ||
            !sameIdentity({ dev: named.dev, ino: named.ino }, afterOpen)
          ) {
            throw vaultWriterError();
          }
        } finally {
          await handle?.close().catch(() => undefined);
        }
      } else {
        throw vaultWriterError();
      }
    }
  }

  private async assertExistingTarget(segments: readonly string[]): Promise<ExistingTarget> {
    await this.assertRoot();
    const paths = this.targetPaths(segments);
    let current = this.root.canonicalRealPath;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      await this.assertExistingDirectory(current);
    }
    const named = await lstat(paths.targetPath);
    if (named.isSymbolicLink() || !named.isFile()) {
      throw vaultWriterError();
    }
    const canonical = await realpath(paths.targetPath);
    if (
      canonical !== paths.targetPath ||
      !isBeneath(this.root.canonicalRealPath, canonical)
    ) {
      throw vaultWriterError();
    }
    await this.assertRoot();
    return {
      ...paths,
      identity: { dev: named.dev, ino: named.ino },
    };
  }

  private async ensureAbsentTarget(segments: readonly string[]): Promise<Readonly<{ targetPath: string; parentPath: string }>> {
    let current = this.root.canonicalRealPath;
    await this.assertRoot();
    for (const segment of segments.slice(0, -1)) {
      const next = join(current, segment);
      let created = false;
      try {
        await this.assertExistingDirectory(next);
      } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code !== "ENOENT") {
          throw vaultWriterError();
        }
        await this.assertExistingDirectory(current);
        try {
          await mkdir(next, { mode: PRIVATE_DIRECTORY_MODE });
          created = true;
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw vaultWriterError();
          }
        }
        await this.assertExistingDirectory(next);
        if (created) {
          await chmod(next, PRIVATE_DIRECTORY_MODE);
          await this.assertExistingDirectory(next);
        }
      }
      await this.syncDirectory(current);
      await this.syncDirectory(next);
      current = next;
    }
    return this.assertAbsentTarget(segments);
  }

  private async assertAbsentTarget(segments: readonly string[]): Promise<Readonly<{ targetPath: string; parentPath: string }>> {
    await this.assertRoot();
    const paths = this.targetPaths(segments);
    let current = this.root.canonicalRealPath;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      await this.assertExistingDirectory(current);
    }
    try {
      await lstat(paths.targetPath);
      throw vaultWriterError();
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "ENOENT") {
        throw vaultWriterError();
      }
    }
    return paths;
  }

  private async ensureCortexMoveLockParent(): Promise<Readonly<{ targetPath: string; parentPath: string }>> {
    const lockPaths = this.targetPaths(CORTEX_MOVE_LOCK_SEGMENTS);
    let current = this.root.canonicalRealPath;
    await this.assertRoot();
    for (const segment of CORTEX_MOVE_LOCK_SEGMENTS.slice(0, -1)) {
      const next = join(current, segment);
      let created = false;
      try {
        await this.assertExistingDirectory(next);
      } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw vaultWriterError();
        await this.assertExistingDirectory(current);
        try {
          await mkdir(next, { mode: PRIVATE_DIRECTORY_MODE });
          created = true;
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw vaultWriterError();
        }
        await this.assertExistingDirectory(next);
        if (created) {
          await chmod(next, PRIVATE_DIRECTORY_MODE);
          const named = await lstat(next);
          if (
            named.isSymbolicLink() ||
            !named.isDirectory() ||
            (named.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
          ) {
            throw vaultWriterError();
          }
        }
      }
      await this.syncDirectory(current);
      await this.syncDirectory(next);
      current = next;
    }
    if (current !== lockPaths.parentPath) throw vaultWriterError();
    return lockPaths;
  }

  private async acquireCortexMoveLock(): Promise<CortexMoveLock> {
    const ownerToken = randomUUID();
    const startedAt = new Date();
    if (!UUID_PATTERN.test(ownerToken) || !Number.isFinite(startedAt.getTime())) throw vaultWriterError();
    const owner = Object.freeze({
      schemaVersion: 1 as const,
      ownerToken,
      startedAt: startedAt.toISOString(),
    });
    const lockPaths = await this.ensureCortexMoveLockParent();
    try {
      await mkdir(lockPaths.targetPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "EEXIST") throw cortexMoveLockError("active-lock");
      throw vaultWriterError();
    }

    let lock: CortexMoveLock | undefined;
    try {
      await chmod(lockPaths.targetPath, PRIVATE_DIRECTORY_MODE);
      const directory = await this.readExistingDirectory(CORTEX_MOVE_LOCK_SEGMENTS);
      const named = await lstat(directory.directoryPath);
      if (
        named.isSymbolicLink() ||
        !named.isDirectory() ||
        (named.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        !sameIdentity(directory.identity, { dev: named.dev, ino: named.ino })
      ) {
        throw vaultWriterError();
      }
      await this.syncDirectory(lockPaths.parentPath);
      await this.syncDirectory(directory.directoryPath);

      lock = Object.freeze({
        directory,
        ownerRecordPath: join(directory.directoryPath, CORTEX_MOVE_LOCK_OWNER_FILENAME),
        ownerToken,
      });
      await this.createCortexMoveLockOwnerRecord(lock.ownerRecordPath, owner);
      await this.syncDirectory(directory.directoryPath);
      if (!(await this.ownsCortexMoveLock(lock))) throw vaultWriterError();
      return lock;
    } catch {
      if (lock !== undefined) {
        try {
          await this.releaseCortexMoveLock(lock);
        } catch {
          throw cortexMoveLockError("recovery-required");
        }
      }
      throw cortexMoveLockError("recovery-required");
    }
  }

  private async createCortexMoveLockOwnerRecord(ownerPath: string, owner: CortexMoveLockOwner): Promise<void> {
    const serialized = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
    if (serialized.byteLength > MAX_CORTEX_MOVE_LOCK_OWNER_BYTES) throw vaultWriterError();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await this.assertExistingDirectory(dirname(ownerPath));
      handle = await open(
        ownerPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      const opened = await handle.stat();
      const identity = { dev: opened.dev, ino: opened.ino };
      if (!opened.isFile() || (opened.mode & 0o777) !== PRIVATE_FILE_MODE) throw vaultWriterError();
      await handle.writeFile(serialized);
      await this.syncFile(ownerPath, handle);
      const afterSync = await handle.stat();
      if (
        !afterSync.isFile() ||
        afterSync.size !== serialized.byteLength ||
        !sameIdentity(identity, afterSync)
      ) {
        throw vaultWriterError();
      }
      await handle.close();
      handle = undefined;
      const named = await lstat(ownerPath);
      if (
        named.isSymbolicLink() ||
        !named.isFile() ||
        (named.mode & 0o777) !== PRIVATE_FILE_MODE ||
        !sameIdentity(identity, { dev: named.dev, ino: named.ino })
      ) {
        throw vaultWriterError();
      }
    } catch {
      await handle?.close().catch(() => undefined);
      throw vaultWriterError();
    }
  }

  private async cortexMoveLockOwnerMatches(ownerPath: string, ownerToken: string): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const named = await lstat(ownerPath);
      const identity = { dev: named.dev, ino: named.ino };
      if (
        named.isSymbolicLink() ||
        !named.isFile() ||
        (named.mode & 0o777) !== PRIVATE_FILE_MODE ||
        named.size < 0 ||
        named.size > MAX_CORTEX_MOVE_LOCK_OWNER_BYTES
      ) {
        return false;
      }
      handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || !sameIdentity(identity, opened)) return false;
      const bytes = Buffer.alloc(MAX_CORTEX_MOVE_LOCK_OWNER_BYTES + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      if (offset > MAX_CORTEX_MOVE_LOCK_OWNER_BYTES) return false;
      const owner = parseCortexMoveLockOwner(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset))));
      const afterRead = await handle.stat();
      const namedAfterRead = await lstat(ownerPath);
      if (
        owner === null ||
        owner.ownerToken !== ownerToken ||
        !afterRead.isFile() ||
        afterRead.size !== offset ||
        !sameIdentity(identity, afterRead) ||
        namedAfterRead.isSymbolicLink() ||
        !namedAfterRead.isFile() ||
        !sameIdentity(identity, namedAfterRead)
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async ownsCortexMoveLock(lock: CortexMoveLock): Promise<boolean> {
    try {
      await this.assertExistingDirectory(lock.directory.parentPath);
      await this.assertExistingDirectory(lock.directory.directoryPath);
      const before = await lstat(lock.directory.directoryPath);
      if (
        before.isSymbolicLink() ||
        !before.isDirectory() ||
        (before.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        !sameIdentity(lock.directory.identity, { dev: before.dev, ino: before.ino })
      ) {
        return false;
      }
      const entries = await readdir(lock.directory.directoryPath);
      if (entries.length !== 1 || entries[0] !== CORTEX_MOVE_LOCK_OWNER_FILENAME) return false;
      if (!(await this.cortexMoveLockOwnerMatches(lock.ownerRecordPath, lock.ownerToken))) return false;
      const after = await lstat(lock.directory.directoryPath);
      return (
        !after.isSymbolicLink() &&
        after.isDirectory() &&
        (after.mode & 0o777) === PRIVATE_DIRECTORY_MODE &&
        sameIdentity(lock.directory.identity, { dev: after.dev, ino: after.ino })
      );
    } catch {
      return false;
    }
  }

  private async releaseCortexMoveLock(lock: CortexMoveLock): Promise<void> {
    try {
      if (!(await this.ownsCortexMoveLock(lock))) throw cortexMoveLockError("recovery-required");
      await unlink(lock.ownerRecordPath);
      await this.syncDirectory(lock.directory.directoryPath);
      await rmdir(lock.directory.directoryPath);
      await this.syncDirectory(lock.directory.parentPath);
    } catch {
      throw cortexMoveLockError("recovery-required");
    }
  }

  private async rollbackCortexSubtreeMove(input: Readonly<{
    paths: CortexMovePaths;
    sourceFile: ReadEvidence;
    sourceDirectory: ExistingDirectory | null;
    targetFileReserved: boolean;
    targetDirectoryReservation: ExistingDirectory | undefined;
    directoryMoved: boolean;
    sourceFileRemoved: boolean;
  }>): Promise<void> {
    let directoryRestored = !input.directoryMoved;
    if (input.directoryMoved && input.sourceDirectory !== null) {
      directoryRestored = await this.restoreCortexCompanionDirectory({
        paths: input.paths,
        sourceDirectory: input.sourceDirectory,
      });
    }
    if (!input.directoryMoved && input.targetDirectoryReservation !== undefined) {
      await this.removeOwnedEmptyDirectoryReservation(input.targetDirectoryReservation);
    }

    let sourceFileRestored = !input.sourceFileRemoved;
    if (input.sourceFileRemoved) {
      sourceFileRestored = await this.restoreCortexSourceFile({
        paths: input.paths,
        sourceFile: input.sourceFile,
      });
    }
    if (!input.targetFileReserved || !sourceFileRestored || !directoryRestored) return;
    await this.removeCortexFileReservation({
      paths: input.paths,
      sourceFile: input.sourceFile,
    });
  }

  private async reserveAbsentDirectory(segments: readonly string[]): Promise<ExistingDirectory> {
    let reservation: ExistingDirectory | undefined;
    try {
      const target = this.targetPaths(segments);
      await this.assertExistingDirectory(target.parentPath);
      await mkdir(target.targetPath, { mode: PRIVATE_DIRECTORY_MODE });
      reservation = await this.readExistingDirectory(segments);
      await this.assertOwnedEmptyDirectoryReservation(reservation);
      return reservation;
    } catch {
      if (reservation !== undefined) {
        await this.removeOwnedEmptyDirectoryReservation(reservation);
      }
      throw vaultWriterError();
    }
  }

  private async assertOwnedEmptyDirectoryReservation(reservation: ExistingDirectory): Promise<void> {
    await this.assertExistingDirectory(reservation.parentPath);
    await this.assertExistingDirectory(reservation.directoryPath);
    const named = await lstat(reservation.directoryPath);
    if (
      named.isSymbolicLink() ||
      !named.isDirectory() ||
      !sameIdentity(reservation.identity, { dev: named.dev, ino: named.ino }) ||
      (await readdir(reservation.directoryPath)).length !== 0
    ) {
      throw vaultWriterError();
    }
  }

  private async removeOwnedEmptyDirectoryReservation(reservation: ExistingDirectory): Promise<void> {
    try {
      await this.assertOwnedEmptyDirectoryReservation(reservation);
      await rmdir(reservation.directoryPath);
      await this.syncDirectory(reservation.parentPath);
    } catch {
      return;
    }
  }

  private async restoreCortexCompanionDirectory(input: Readonly<{
    paths: CortexMovePaths;
    sourceDirectory: ExistingDirectory;
  }>): Promise<boolean> {
    let sourceReservation: ExistingDirectory | undefined;
    let restored = false;
    try {
      const movedDirectory = await this.readExistingDirectory(input.paths.targetDirectorySegments);
      if (!sameIdentity(movedDirectory.identity, input.sourceDirectory.identity)) return false;
      sourceReservation = await this.reserveAbsentDirectory(input.paths.sourceDirectorySegments);
      await this.syncDirectory(sourceReservation.parentPath);
      const immediatelyBeforeRestore = await this.readExistingDirectory(input.paths.targetDirectorySegments);
      if (!sameIdentity(immediatelyBeforeRestore.identity, input.sourceDirectory.identity)) {
        throw vaultWriterError();
      }
      await this.assertOwnedEmptyDirectoryReservation(sourceReservation);
      await rename(immediatelyBeforeRestore.directoryPath, sourceReservation.directoryPath);
      restored = true;
      await this.syncDirectory(immediatelyBeforeRestore.parentPath);
      await this.syncDirectory(sourceReservation.parentPath);
      return true;
    } catch {
      if (!restored && sourceReservation !== undefined) {
        await this.removeOwnedEmptyDirectoryReservation(sourceReservation);
      }
      return restored;
    }
  }

  private async restoreCortexSourceFile(input: Readonly<{
    paths: CortexMovePaths;
    sourceFile: ReadEvidence;
  }>): Promise<boolean> {
    let restored = false;
    try {
      const targetFile = await this.readExisting(input.paths.targetFileSegments);
      if (
        targetFile.byteHash !== input.sourceFile.byteHash ||
        !sameIdentity(targetFile.identity, input.sourceFile.identity)
      ) {
        return false;
      }
      const sourceFile = await this.assertAbsentTarget(input.paths.sourceFileSegments);
      await link(targetFile.targetPath, sourceFile.targetPath);
      const observed = await this.readExisting(input.paths.sourceFileSegments);
      if (
        observed.byteHash !== input.sourceFile.byteHash ||
        !sameIdentity(observed.identity, input.sourceFile.identity)
      ) {
        return false;
      }
      restored = true;
      await this.syncDirectory(targetFile.parentPath);
      await this.syncDirectory(sourceFile.parentPath);
      return true;
    } catch {
      return restored;
    }
  }

  private async removeCortexFileReservation(input: Readonly<{
    paths: CortexMovePaths;
    sourceFile: ReadEvidence;
  }>): Promise<void> {
    try {
      const targetFile = await this.readExisting(input.paths.targetFileSegments);
      if (
        targetFile.byteHash !== input.sourceFile.byteHash ||
        !sameIdentity(targetFile.identity, input.sourceFile.identity)
      ) {
        return;
      }
      await unlink(targetFile.targetPath);
      await this.syncDirectory(targetFile.parentPath);
    } catch {
      return;
    }
  }

  private async readExisting(segments: readonly string[]): Promise<ReadEvidence> {
    const target = await this.assertExistingTarget(segments);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(target.targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      const named = await lstat(target.targetPath);
      if (
        !opened.isFile() ||
        opened.size < 0 ||
        opened.size > MAX_LOCAL_NOTE_BYTES ||
        named.isSymbolicLink() ||
        !named.isFile() ||
        !sameIdentity(target.identity, opened) ||
        !sameIdentity(target.identity, named)
      ) {
        throw vaultWriterError();
      }
      await this.assertExistingTarget(segments);

      const bytes = Buffer.alloc(MAX_LOCAL_NOTE_BYTES + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (result.bytesRead === 0) {
          break;
        }
        offset += result.bytesRead;
      }
      if (offset > MAX_LOCAL_NOTE_BYTES) {
        throw vaultWriterError();
      }
      const afterRead = await handle.stat();
      const namedAfterRead = await lstat(target.targetPath);
      if (
        !afterRead.isFile() ||
        !namedAfterRead.isFile() ||
        namedAfterRead.isSymbolicLink() ||
        !sameIdentity(target.identity, afterRead) ||
        !sameIdentity(target.identity, namedAfterRead) ||
        afterRead.size !== offset ||
        afterRead.size !== opened.size ||
        afterRead.mtimeMs !== opened.mtimeMs
      ) {
        throw vaultWriterError();
      }
      await this.assertExistingTarget(segments);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
      return { ...target, content, byteHash: await sha256Hex(content) };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async optionalReadExisting(segments: readonly string[]): Promise<ReadEvidence | null> {
    try {
      return await this.readExisting(segments);
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw vaultWriterError();
    }
  }

  private async createPrivateTemporary(parentPath: string, targetName: string, content: Buffer): Promise<TemporaryFile> {
    await this.assertExistingDirectory(parentPath);
    const suffix = randomUUID();
    if (!JOURNAL_SAFE_SUFFIX.test(suffix)) {
      throw vaultWriterError();
    }
    const path = join(parentPath, `.${targetName}.${suffix}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporary: TemporaryFile | undefined;
    try {
      handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      const opened = await handle.stat();
      const identity = { dev: opened.dev, ino: opened.ino };
      temporary = { path, identity };
      if (!opened.isFile() || (opened.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw vaultWriterError();
      }
      await handle.writeFile(content);
      await this.syncFile(path, handle);
      const afterSync = await handle.stat();
      if (!afterSync.isFile() || !sameIdentity(identity, afterSync)) {
        throw vaultWriterError();
      }
      await handle.close();
      handle = undefined;
      await this.assertOwnedTemporary(temporary);
      return temporary;
    } catch {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (temporary !== undefined) {
        await this.removeOwnedTemporary(temporary).catch(() => undefined);
      }
      throw vaultWriterError();
    }
  }

  private async assertOwnedTemporary(temporary: TemporaryFile): Promise<void> {
    const parent = dirname(temporary.path);
    await this.assertExistingDirectory(parent);
    const entry = await lstat(temporary.path);
    if (
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      (entry.mode & 0o777) !== PRIVATE_FILE_MODE ||
      !sameIdentity(temporary.identity, entry)
    ) {
      throw vaultWriterError();
    }
  }

  private async removeOwnedTemporary(temporary: TemporaryFile): Promise<void> {
    try {
      await this.assertOwnedTemporary(temporary);
      await unlink(temporary.path);
    } catch {
      return;
    }
  }

  private async syncDirectory(directoryPath: string): Promise<void> {
    await this.assertExistingDirectory(directoryPath);
    const handle = await open(directoryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const entry = await handle.stat();
      if (!entry.isDirectory()) {
        throw vaultWriterError();
      }
      const sync = async (): Promise<void> => handle.sync();
      if (this.testHooks.syncDirectory === undefined) {
        await sync();
      } else {
        await this.testHooks.syncDirectory(directoryPath, sync);
      }
    } finally {
      await handle.close();
    }
  }

  private async syncFile(filePath: string, handle: Awaited<ReturnType<typeof open>>): Promise<void> {
    const sync = async (): Promise<void> => handle.sync();
    if (this.testHooks.syncFile === undefined) {
      await sync();
    } else {
      await this.testHooks.syncFile(filePath, sync);
    }
  }
}

const JOURNAL_SAFE_SUFFIX = /^[A-Za-z0-9-]{1,128}$/;
