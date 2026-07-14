import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
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
  readonly processId: number;
  readonly now: () => Date;
  readonly staleAfterMs: number;
  readonly isProcessAlive: (pid: number, startedAt: string) => Promise<boolean | null>;
  readonly randomUUID: () => string;
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

async function removeIfSame(lockPath: string, identity: FileIdentity, parent: string): Promise<boolean> {
  await assertCanonicalRuntimePath(lockPath);
  let current;
  try {
    current = await lstat(lockPath);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw caught;
  }
  if (!sameIdentity(identity, asIdentity(current))) {
    return false;
  }
  await unlink(lockPath);
  await fsyncDirectory(parent);
  return true;
}

async function removeIfOwned(
  lockPath: string,
  identity: FileIdentity,
  ownerToken: string,
  parent: string,
): Promise<boolean> {
  try {
    await assertCanonicalRuntimePath(lockPath);
    const metadata = await readStrictJson(lockPath, (input) => lockMetadataSchema.parse(input), {
      maxBytes: MAX_LOCK_BYTES,
    });
    const current = await lstat(lockPath);
    if (!sameIdentity(identity, asIdentity(current)) || metadata.ownerToken !== ownerToken) {
      return false;
    }
    await assertCanonicalRuntimePath(lockPath);
    await unlink(lockPath);
    await fsyncDirectory(parent);
    return true;
  } catch {
    return false;
  }
}

async function createLock(
  lockPath: string,
  parent: string,
  metadata: LockMetadata,
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
    await assertCanonicalRuntimePath(lockPath);
    await fsyncDirectory(parent);
    return identity;
  } catch (caught) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (identity !== undefined) {
      await removeIfSame(lockPath, identity, parent).catch(() => undefined);
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

  let identity = await createLock(lockPath, parent, ownMetadata);
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

    const removed = await removeIfOwned(
      lockPath,
      existing.identity,
      existing.metadata.ownerToken,
      parent,
    );
    if (!removed) {
      throw activeLockError();
    }
    identity = await createLock(lockPath, parent, ownMetadata);
    if (identity === null) {
      throw activeLockError();
    }
  }

  try {
    return await operation();
  } finally {
    await removeIfOwned(lockPath, identity, ownMetadata.ownerToken, parent);
  }
}
