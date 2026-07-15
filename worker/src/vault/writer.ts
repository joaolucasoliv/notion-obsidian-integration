import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { sha256Hex } from "@grandbox-bridge/shared";
import { MAX_LOCAL_NOTE_BYTES } from "../markdown/frontmatter.js";
import type { CanonicalVaultRoot } from "./safety.js";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_RELATIVE_PATH_BYTES = 1_024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

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
}

/** Narrow test-only synchronization hooks; no runtime configuration consumes these. */
export interface AtomicVaultWriterTestHooks {
  readonly beforeWriteRename?: (paths: Readonly<{ targetPath: string; temporaryPath: string }>) => Promise<void>;
  readonly beforeFinalWriteTargetCheck?: (paths: Readonly<{ targetPath: string; temporaryPath: string }>) => Promise<void>;
  readonly beforeCreateFinalize?: (
    paths: Readonly<{ parentPath: string; targetPath: string; temporaryPath: string }>,
  ) => Promise<void>;
  readonly syncDirectory?: (directoryPath: string, sync: () => Promise<void>) => Promise<void>;
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
}

interface TemporaryFile {
  readonly path: string;
  readonly identity: FileIdentity;
}

function vaultWriterError(): Error {
  return new Error("Vault writer failed");
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

export class AtomicVaultWriter implements VaultWriter {
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
      return { ...target, byteHash: await sha256Hex(content) };
    } finally {
      await handle?.close().catch(() => undefined);
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
      await handle.sync();
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
}

const JOURNAL_SAFE_SUFFIX = /^[A-Za-z0-9-]{1,128}$/;
