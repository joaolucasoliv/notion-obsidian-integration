import { randomUUID as createRandomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { readStrictJson } from "./atomic-json.js";
import { assertCanonicalRuntimePath } from "./paths.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_LOCK_BYTES = 1_024;

const lockMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    pid: z.number().int().positive().max(2_147_483_647),
    startedAt: z.string().max(64).datetime({ offset: true }),
    ownerToken: z.uuid(),
  })
  .strict()
  .readonly();

type LockMetadata = z.infer<typeof lockMetadataSchema>;

interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
}

export interface InstallationLockOptions {
  readonly afterLockQuarantineRename?: (context: LockQuarantineContext) => Promise<void>;
  readonly afterLockCreateWrite?: (lockPath: string) => Promise<void>;
  readonly beforeLockQuarantine?: (context: LockQuarantineContext) => Promise<void>;
  readonly processId: number;
  readonly now: () => Date;
  readonly staleAfterMs: number;
  readonly isProcessAlive: (pid: number, startedAt: string) => Promise<boolean | null>;
  readonly randomUUID: () => string;
}

export interface LockQuarantineContext {
  readonly lockPath: string;
  readonly quarantinePath: string;
  readonly reason: "create-failure" | "release" | "stale";
}

function activeLockError(): Error {
  return new Error("Active installation lock");
}

function lockOperationError(): Error {
  return new Error("Installation lock operation failed");
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function asIdentity(stats: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateParent(lockPath: string): Promise<string> {
  const parent = dirname(lockPath);
  await assertCanonicalRuntimePath(lockPath);
  await mkdir(parent, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertCanonicalRuntimePath(lockPath);
  const before = await lstat(parent);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw lockOperationError();
  }
  await chmod(parent, PRIVATE_DIRECTORY_MODE);
  const after = await lstat(parent);
  if (!after.isDirectory() || after.isSymbolicLink() || (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw lockOperationError();
  }
  return parent;
}

async function matchesLockExpectation(
  filePath: string,
  identity: FileIdentity,
  ownerToken: string | undefined,
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertCanonicalRuntimePath(filePath);
    const before = await lstat(filePath);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
      !sameIdentity(identity, asIdentity(before))
    ) {
      return false;
    }

    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(identity, asIdentity(opened))) {
      return false;
    }

    if (ownerToken !== undefined) {
      const metadata = await readStrictJson(filePath, (input) => lockMetadataSchema.parse(input), {
        maxBytes: MAX_LOCK_BYTES,
      });
      if (metadata.ownerToken !== ownerToken) {
        return false;
      }
    }

    const after = await lstat(filePath);
    if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(identity, asIdentity(after))) {
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
}

async function chooseQuarantinePath(lockPath: string, parent: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = join(parent, `.${basename(lockPath)}.${createRandomUUID()}.quarantine`);
    try {
      await lstat(candidate);
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
        return candidate;
      }
      throw caught;
    }
  }
  throw lockOperationError();
}

async function unlinkMatchingQuarantine(
  quarantinePath: string,
  identity: FileIdentity,
  parent: string,
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertCanonicalRuntimePath(quarantinePath);
    const before = await lstat(quarantinePath);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
      !sameIdentity(identity, asIdentity(before))
    ) {
      return false;
    }

    handle = await open(quarantinePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(identity, asIdentity(opened))) {
      return false;
    }
    await handle.close();
    handle = undefined;

    const afterClose = await lstat(quarantinePath);
    if (afterClose.isSymbolicLink() || !afterClose.isFile() || !sameIdentity(identity, asIdentity(afterClose))) {
      return false;
    }
    await unlink(quarantinePath);
    await fsyncDirectory(parent);
    return true;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
}

async function restoreQuarantineWithoutOverwrite(
  quarantinePath: string,
  lockPath: string,
  parent: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertCanonicalRuntimePath(quarantinePath);
    const before = await lstat(quarantinePath);
    if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o777) !== PRIVATE_FILE_MODE) {
      return;
    }
    const identity = asIdentity(before);

    handle = await open(quarantinePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(identity, asIdentity(opened))) {
      return;
    }

    await link(quarantinePath, lockPath);
    const quarantined = await lstat(quarantinePath);
    const restored = await lstat(lockPath);
    if (
      quarantined.isSymbolicLink() ||
      restored.isSymbolicLink() ||
      !quarantined.isFile() ||
      !restored.isFile() ||
      !sameIdentity(identity, asIdentity(quarantined)) ||
      !sameIdentity(identity, asIdentity(restored))
    ) {
      return;
    }

    await handle.close();
    handle = undefined;
    const afterClose = await lstat(quarantinePath);
    const canonicalAfterClose = await lstat(lockPath);
    if (
      afterClose.isSymbolicLink() ||
      canonicalAfterClose.isSymbolicLink() ||
      !sameIdentity(identity, asIdentity(afterClose)) ||
      !sameIdentity(identity, asIdentity(canonicalAfterClose))
    ) {
      return;
    }
    await unlink(quarantinePath);
    await fsyncDirectory(parent);
  } catch {
    // A competing canonical lock or ambiguous quarantine is deliberately retained.
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
}

async function removeThroughQuarantine(
  lockPath: string,
  identity: FileIdentity,
  ownerToken: string | undefined,
  parent: string,
  reason: LockQuarantineContext["reason"],
  options: InstallationLockOptions,
): Promise<boolean> {
  let quarantinePath = "";
  let quarantined = false;
  try {
    if (!(await matchesLockExpectation(lockPath, identity, ownerToken))) {
      return false;
    }
    quarantinePath = await chooseQuarantinePath(lockPath, parent);
    const context: LockQuarantineContext = { lockPath, quarantinePath, reason };
    await options.beforeLockQuarantine?.(context);
    await rename(lockPath, quarantinePath);
    quarantined = true;
    await options.afterLockQuarantineRename?.(context);

    if (
      (await matchesLockExpectation(quarantinePath, identity, ownerToken)) &&
      (await unlinkMatchingQuarantine(quarantinePath, identity, parent))
    ) {
      return true;
    }
    await restoreQuarantineWithoutOverwrite(quarantinePath, lockPath, parent);
    return false;
  } catch {
    if (quarantined) {
      await restoreQuarantineWithoutOverwrite(quarantinePath, lockPath, parent);
    }
    return false;
  }
}

async function createLock(
  lockPath: string,
  parent: string,
  metadata: LockMetadata,
  options: InstallationLockOptions,
): Promise<FileIdentity | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: FileIdentity | undefined;

  try {
    await assertCanonicalRuntimePath(lockPath);
    handle = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    const opened = await handle.stat();
    identity = { dev: String(opened.dev), ino: String(opened.ino) };
    if (!opened.isFile() || (opened.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw lockOperationError();
    }
    const serialized = `${JSON.stringify(metadata)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_LOCK_BYTES) {
      throw lockOperationError();
    }
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.afterLockCreateWrite?.(lockPath);
    await fsyncDirectory(parent);
    if (!(await matchesLockExpectation(lockPath, identity, metadata.ownerToken))) {
      throw lockOperationError();
    }
    return identity;
  } catch (caught) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (identity !== undefined) {
      await removeThroughQuarantine(
        lockPath,
        identity,
        metadata.ownerToken,
        parent,
        "create-failure",
        options,
      ).catch(() => undefined);
    }
    if ((caught as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    throw lockOperationError();
  }
}

async function inspectExistingLock(lockPath: string): Promise<{ metadata: LockMetadata; identity: FileIdentity }> {
  try {
    const before = await lstat(lockPath);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw activeLockError();
    }
    const metadata = await readStrictJson(lockPath, (input) => lockMetadataSchema.parse(input), {
      maxBytes: MAX_LOCK_BYTES,
    });
    const after = await lstat(lockPath);
    if (!sameIdentity(asIdentity(before), asIdentity(after))) {
      throw activeLockError();
    }
    return { metadata, identity: asIdentity(after) };
  } catch {
    throw activeLockError();
  }
}

function validateOptions(options: InstallationLockOptions): LockMetadata {
  const startedAt = options.now();
  const ownerToken = options.randomUUID();
  if (
    !Number.isSafeInteger(options.processId) ||
    options.processId < 1 ||
    options.processId > 2_147_483_647 ||
    !Number.isSafeInteger(options.staleAfterMs) ||
    options.staleAfterMs < 1 ||
    !Number.isFinite(startedAt.getTime())
  ) {
    throw lockOperationError();
  }
  return lockMetadataSchema.parse({
    schemaVersion: 1,
    pid: options.processId,
    startedAt: startedAt.toISOString(),
    ownerToken,
  });
}

export async function withInstallationLock<T>(
  lockPath: string,
  options: InstallationLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    await assertCanonicalRuntimePath(lockPath);
  } catch {
    throw lockOperationError();
  }
  let ownMetadata: LockMetadata;
  try {
    ownMetadata = validateOptions(options);
  } catch {
    throw lockOperationError();
  }
  const parent = await ensurePrivateParent(lockPath);

  let identity = await createLock(lockPath, parent, ownMetadata, options);
  if (identity === null) {
    const existing = await inspectExistingLock(lockPath);
    const currentTime = new Date(ownMetadata.startedAt).getTime();
    const ownerStart = new Date(existing.metadata.startedAt).getTime();
    const oldEnough = currentTime - ownerStart > options.staleAfterMs;
    if (!oldEnough) {
      throw activeLockError();
    }

    let isAlive: boolean | null;
    try {
      isAlive = await options.isProcessAlive(existing.metadata.pid, existing.metadata.startedAt);
    } catch {
      throw activeLockError();
    }
    if (isAlive !== false) {
      throw activeLockError();
    }

    const removed = await removeThroughQuarantine(
      lockPath,
      existing.identity,
      existing.metadata.ownerToken,
      parent,
      "stale",
      options,
    );
    if (!removed) {
      throw activeLockError();
    }
    identity = await createLock(lockPath, parent, ownMetadata, options);
    if (identity === null) {
      throw activeLockError();
    }
  }

  try {
    return await operation();
  } finally {
    await removeThroughQuarantine(
      lockPath,
      identity,
      ownMetadata.ownerToken,
      parent,
      "release",
      options,
    );
  }
}
