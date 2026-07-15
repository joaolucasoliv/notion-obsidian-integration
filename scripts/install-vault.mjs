import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const PLUGIN_ID = "grandbox-bridge";
const REQUIRED_ARTIFACTS = Object.freeze(["main.js", "bridge-worker.cjs", "manifest.json", "styles.css"]);
const REQUIRED_ARTIFACT_SET = new Set(REQUIRED_ARTIFACTS);
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_DEPTH = 32;
const UUID_SUFFIX_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BACKUP_NAME_PREFIX = `.${PLUGIN_ID}.backup.`;
const STAGING_NAME_PREFIX = `.${PLUGIN_ID}.staging.`;

class InstallerError extends Error {}

function unsafeInstallPathError() {
  return new InstallerError("Unsafe install path");
}

function unsafeArtifactsError() {
  return new InstallerError("Unsafe install artifacts");
}

function unsafeVaultInstallPathError() {
  return new InstallerError("Unsafe vault install path");
}

function unsafeLogPathError() {
  return new InstallerError("Unsafe log path");
}

function vaultInstallError() {
  return new InstallerError("Vault install failed");
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function assertAbsoluteNormalizedPath(value, errorFactory) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    resolve(value) !== value
  ) {
    throw errorFactory();
  }
}

function assertChildName(name, errorFactory) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("\0") ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw errorFactory();
  }
}

function isBeneath(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertCanonicalDirectory(directoryPath, errorFactory) {
  assertAbsoluteNormalizedPath(directoryPath, errorFactory);
  try {
    const named = await lstat(directoryPath);
    if (named.isSymbolicLink() || !named.isDirectory()) {
      throw errorFactory();
    }
    const canonical = await realpath(directoryPath);
    if (canonical !== directoryPath) {
      throw errorFactory();
    }
    return named;
  } catch (caught) {
    if (caught instanceof InstallerError) throw caught;
    throw errorFactory();
  }
}

async function assertExistingRegularFile(filePath, errorFactory) {
  try {
    const named = await lstat(filePath);
    if (named.isSymbolicLink() || !named.isFile() || named.size > MAX_ARTIFACT_BYTES) {
      throw errorFactory();
    }
    const canonical = await realpath(filePath);
    if (canonical !== filePath) {
      throw errorFactory();
    }
    return named;
  } catch (caught) {
    if (caught instanceof InstallerError) throw caught;
    throw errorFactory();
  }
}

async function ensureChildDirectory(parentPath, name, { privateMode, errorFactory }) {
  assertChildName(name, errorFactory);
  const childPath = join(parentPath, name);
  if (!isBeneath(parentPath, childPath)) {
    throw errorFactory();
  }
  let created = false;
  try {
    const existing = await lstat(childPath);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw errorFactory();
    }
  } catch (caught) {
    if (!isMissing(caught)) {
      if (caught instanceof InstallerError) throw caught;
      throw errorFactory();
    }
    try {
      await mkdir(childPath, { mode: PRIVATE_DIRECTORY_MODE });
      created = true;
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") {
        throw errorFactory();
      }
    }
  }
  try {
    const named = await lstat(childPath);
    if (named.isSymbolicLink() || !named.isDirectory()) {
      throw errorFactory();
    }
    const canonical = await realpath(childPath);
    if (canonical !== childPath) {
      throw errorFactory();
    }
    if (privateMode) {
      if (!created && (named.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        throw errorFactory();
      }
      if (created) {
        await chmod(childPath, PRIVATE_DIRECTORY_MODE);
        const afterChmod = await lstat(childPath);
        if (
          afterChmod.isSymbolicLink() ||
          !afterChmod.isDirectory() ||
          (afterChmod.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
        ) {
          throw errorFactory();
        }
      }
    }
  } catch (caught) {
    if (caught instanceof InstallerError) throw caught;
    throw errorFactory();
  }
  return childPath;
}

async function stagingArtifacts(stagingDirectory) {
  await assertCanonicalDirectory(stagingDirectory, unsafeArtifactsError);
  let names;
  try {
    names = (await readdir(stagingDirectory)).sort();
  } catch {
    throw unsafeArtifactsError();
  }
  if (names.length !== REQUIRED_ARTIFACTS.length || names.some((name) => !REQUIRED_ARTIFACT_SET.has(name))) {
    throw unsafeArtifactsError();
  }
  const artifacts = new Map();
  for (const artifact of REQUIRED_ARTIFACTS) {
    const artifactPath = join(stagingDirectory, artifact);
    await assertExistingRegularFile(artifactPath, unsafeArtifactsError);
    artifacts.set(artifact, artifactPath);
  }
  return artifacts;
}

async function inspectDirectoryTree(directoryPath, rootPath, budget, errorFactory, depth = 0) {
  if (depth > MAX_TREE_DEPTH || budget.entries > MAX_TREE_ENTRIES) {
    throw errorFactory();
  }
  let names;
  try {
    names = (await readdir(directoryPath)).sort();
  } catch {
    throw errorFactory();
  }
  for (const name of names) {
    budget.entries += 1;
    if (budget.entries > MAX_TREE_ENTRIES) {
      throw errorFactory();
    }
    assertChildName(name, errorFactory);
    const childPath = join(directoryPath, name);
    if (!isBeneath(rootPath, childPath)) {
      throw errorFactory();
    }
    let entry;
    try {
      entry = await lstat(childPath);
    } catch {
      throw errorFactory();
    }
    if (entry.isSymbolicLink()) {
      throw errorFactory();
    }
    if (entry.isDirectory()) {
      const canonical = await realpath(childPath).catch(() => null);
      if (canonical !== childPath) {
        throw errorFactory();
      }
      await inspectDirectoryTree(childPath, rootPath, budget, errorFactory, depth + 1);
      continue;
    }
    if (!entry.isFile() || entry.size > MAX_ARTIFACT_BYTES) {
      throw errorFactory();
    }
    const canonical = await realpath(childPath).catch(() => null);
    if (canonical !== childPath) {
      throw errorFactory();
    }
  }
}

function snapshotDirectoryEntry(entry) {
  return Object.freeze({
    kind: "directory",
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode & 0o777,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
  });
}

async function snapshotRegularFile(filePath, errorFactory) {
  let handle;
  try {
    const before = await assertExistingRegularFile(filePath, errorFactory);
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(opened, before) || opened.size > MAX_ARTIFACT_BYTES) {
      throw errorFactory();
    }
    const contents = await handle.readFile();
    const afterRead = await handle.stat();
    if (
      contents.byteLength !== opened.size ||
      !afterRead.isFile() ||
      !sameIdentity(afterRead, before) ||
      afterRead.size !== opened.size
    ) {
      throw errorFactory();
    }
    return Object.freeze({
      kind: "file",
      dev: opened.dev,
      ino: opened.ino,
      mode: opened.mode & 0o777,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  } catch (caught) {
    if (caught instanceof InstallerError) throw caught;
    throw errorFactory();
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

async function snapshotPreservedTechnicalTree(
  directoryPath,
  rootPath,
  budget,
  entries = new Map(),
  relativeDirectory = "",
  depth = 0,
) {
  if (depth > MAX_TREE_DEPTH || budget.entries > MAX_TREE_ENTRIES) {
    throw unsafeVaultInstallPathError();
  }
  let names;
  try {
    names = (await readdir(directoryPath)).sort();
  } catch {
    throw unsafeVaultInstallPathError();
  }
  for (const name of names) {
    assertChildName(name, unsafeVaultInstallPathError);
    if (relativeDirectory === "" && REQUIRED_ARTIFACT_SET.has(name)) {
      continue;
    }
    budget.entries += 1;
    if (budget.entries > MAX_TREE_ENTRIES) {
      throw unsafeVaultInstallPathError();
    }
    const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    const entryPath = join(directoryPath, name);
    if (!isBeneath(rootPath, entryPath)) {
      throw unsafeVaultInstallPathError();
    }
    let entry;
    try {
      entry = await lstat(entryPath);
    } catch {
      throw unsafeVaultInstallPathError();
    }
    if (entry.isSymbolicLink()) {
      throw unsafeVaultInstallPathError();
    }
    if (entry.isDirectory()) {
      const canonical = await realpath(entryPath).catch(() => null);
      if (canonical !== entryPath) {
        throw unsafeVaultInstallPathError();
      }
      entries.set(relativePath, snapshotDirectoryEntry(entry));
      await snapshotPreservedTechnicalTree(entryPath, rootPath, budget, entries, relativePath, depth + 1);
      continue;
    }
    if (!entry.isFile()) {
      throw unsafeVaultInstallPathError();
    }
    entries.set(relativePath, await snapshotRegularFile(entryPath, unsafeVaultInstallPathError));
  }
  return entries;
}

function samePreservedSnapshot(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, expected] of left) {
    const observed = right.get(path);
    if (observed === undefined || expected.kind !== observed.kind) return false;
    if (
      expected.dev !== observed.dev ||
      expected.ino !== observed.ino ||
      expected.mode !== observed.mode ||
      expected.mtimeMs !== observed.mtimeMs ||
      expected.ctimeMs !== observed.ctimeMs
    ) {
      return false;
    }
    if (expected.kind === "file" && (
      expected.size !== observed.size || expected.sha256 !== observed.sha256
    )) {
      return false;
    }
  }
  return true;
}

async function inspectExistingTarget(targetPath) {
  try {
    const target = await lstat(targetPath);
    if (target.isSymbolicLink() || !target.isDirectory()) {
      throw unsafeVaultInstallPathError();
    }
    const canonical = await realpath(targetPath);
    if (canonical !== targetPath) {
      throw unsafeVaultInstallPathError();
    }
    await inspectDirectoryTree(targetPath, targetPath, { entries: 0 }, unsafeVaultInstallPathError);
    const preserved = await snapshotPreservedTechnicalTree(targetPath, targetPath, { entries: 0 });
    return Object.freeze({ exists: true, identity: { dev: target.dev, ino: target.ino }, preserved });
  } catch (caught) {
    if (isMissing(caught)) {
      return Object.freeze({ exists: false, identity: null, preserved: new Map() });
    }
    if (caught instanceof InstallerError) throw caught;
    throw unsafeVaultInstallPathError();
  }
}

async function assertTargetUnchanged(targetPath, expected) {
  if (!expected.exists) {
    try {
      await lstat(targetPath);
    } catch (caught) {
      if (isMissing(caught)) return;
      throw unsafeVaultInstallPathError();
    }
    throw unsafeVaultInstallPathError();
  }
  const current = await inspectExistingTarget(targetPath);
  if (
    !current.exists ||
    !sameIdentity(current.identity, expected.identity) ||
    !samePreservedSnapshot(expected.preserved, current.preserved)
  ) {
    throw unsafeVaultInstallPathError();
  }
}

async function copyRegularFile(sourcePath, destinationPath, errorFactory) {
  let source;
  let destination;
  try {
    const before = await assertExistingRegularFile(sourcePath, errorFactory);
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await source.stat();
    if (!opened.isFile() || !sameIdentity(opened, before) || opened.size > MAX_ARTIFACT_BYTES) {
      throw errorFactory();
    }
    const contents = await source.readFile();
    const afterRead = await source.stat();
    if (
      contents.byteLength !== opened.size ||
      !afterRead.isFile() ||
      !sameIdentity(afterRead, before) ||
      afterRead.size !== opened.size
    ) {
      throw errorFactory();
    }
    await source.close();
    source = undefined;

    destination = await open(
      destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    const destinationStats = await destination.stat();
    if (!destinationStats.isFile() || (destinationStats.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw errorFactory();
    }
    await destination.writeFile(contents);
    await destination.sync();
    await destination.close();
    destination = undefined;
    const written = await lstat(destinationPath);
    if (written.isSymbolicLink() || !written.isFile() || (written.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw errorFactory();
    }
  } catch (caught) {
    if (source !== undefined) await source.close().catch(() => undefined);
    if (destination !== undefined) await destination.close().catch(() => undefined);
    if (caught instanceof InstallerError) throw caught;
    throw errorFactory();
  }
}

async function copyTechnicalChildren(sourceDirectory, destinationDirectory, rootDirectory, budget, depth = 0) {
  if (depth > MAX_TREE_DEPTH || budget.entries > MAX_TREE_ENTRIES) {
    throw unsafeVaultInstallPathError();
  }
  let names;
  try {
    names = (await readdir(sourceDirectory)).sort();
  } catch {
    throw unsafeVaultInstallPathError();
  }
  for (const name of names) {
    assertChildName(name, unsafeVaultInstallPathError);
    if (depth === 0 && REQUIRED_ARTIFACT_SET.has(name)) {
      continue;
    }
    budget.entries += 1;
    if (budget.entries > MAX_TREE_ENTRIES) {
      throw unsafeVaultInstallPathError();
    }
    const sourcePath = join(sourceDirectory, name);
    const destinationPath = join(destinationDirectory, name);
    if (!isBeneath(rootDirectory, sourcePath) || !isBeneath(destinationDirectory, destinationPath)) {
      throw unsafeVaultInstallPathError();
    }
    let entry;
    try {
      entry = await lstat(sourcePath);
    } catch {
      throw unsafeVaultInstallPathError();
    }
    if (entry.isSymbolicLink()) {
      throw unsafeVaultInstallPathError();
    }
    if (entry.isDirectory()) {
      const canonical = await realpath(sourcePath).catch(() => null);
      if (canonical !== sourcePath) {
        throw unsafeVaultInstallPathError();
      }
      await mkdir(destinationPath, { mode: PRIVATE_DIRECTORY_MODE });
      await chmod(destinationPath, PRIVATE_DIRECTORY_MODE);
      await copyTechnicalChildren(sourcePath, destinationPath, rootDirectory, budget, depth + 1);
      continue;
    }
    if (!entry.isFile()) {
      throw unsafeVaultInstallPathError();
    }
    await copyRegularFile(sourcePath, destinationPath, unsafeVaultInstallPathError);
  }
}

async function createTemporaryTarget(parentPath) {
  const temporaryPath = join(parentPath, `.${PLUGIN_ID}.staging.${randomUUID()}`);
  try {
    await mkdir(temporaryPath, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(temporaryPath, PRIVATE_DIRECTORY_MODE);
    const entry = await lstat(temporaryPath);
    if (entry.isSymbolicLink() || !entry.isDirectory() || (entry.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw vaultInstallError();
    }
    const canonical = await realpath(temporaryPath);
    if (canonical !== temporaryPath || !isBeneath(parentPath, temporaryPath)) {
      throw vaultInstallError();
    }
    return temporaryPath;
  } catch (caught) {
    if (caught instanceof InstallerError) throw caught;
    throw vaultInstallError();
  }
}

async function verifyPrivateStagingTree(
  directoryPath,
  rootPath,
  budget,
  synchronizeDirectories,
  errorFactory = vaultInstallError,
  depth = 0,
) {
  if (depth > MAX_TREE_DEPTH || budget.entries > MAX_TREE_ENTRIES) {
    throw errorFactory();
  }
  let directory;
  try {
    directory = await lstat(directoryPath);
  } catch {
    throw errorFactory();
  }
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    (directory.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    await realpath(directoryPath).catch(() => null) !== directoryPath
  ) {
    throw errorFactory();
  }
  let names;
  try {
    names = (await readdir(directoryPath)).sort();
  } catch {
    throw errorFactory();
  }
  for (const name of names) {
    budget.entries += 1;
    if (budget.entries > MAX_TREE_ENTRIES) {
      throw errorFactory();
    }
    assertChildName(name, errorFactory);
    const childPath = join(directoryPath, name);
    if (!isBeneath(rootPath, childPath)) {
      throw errorFactory();
    }
    let child;
    try {
      child = await lstat(childPath);
    } catch {
      throw errorFactory();
    }
    if (child.isSymbolicLink()) {
      throw errorFactory();
    }
    if (child.isDirectory()) {
      await verifyPrivateStagingTree(childPath, rootPath, budget, synchronizeDirectories, errorFactory, depth + 1);
      continue;
    }
    if (
      !child.isFile() ||
      (child.mode & 0o777) !== PRIVATE_FILE_MODE ||
      child.size > MAX_ARTIFACT_BYTES ||
      await realpath(childPath).catch(() => null) !== childPath
    ) {
      throw errorFactory();
    }
  }
  if (synchronizeDirectories) {
    await syncDirectory(directoryPath);
  }
}

async function synchronizePrivateStagingTree(directoryPath) {
  await verifyPrivateStagingTree(directoryPath, directoryPath, { entries: 0 }, true);
}

async function recoveryCandidates(parentPath) {
  let names;
  try {
    names = (await readdir(parentPath)).sort();
  } catch {
    throw unsafeVaultInstallPathError();
  }
  const backups = [];
  const staging = [];
  for (const name of names) {
    assertChildName(name, unsafeVaultInstallPathError);
    const isBackup = name.startsWith(BACKUP_NAME_PREFIX);
    const isStaging = name.startsWith(STAGING_NAME_PREFIX);
    if (!isBackup && !isStaging) continue;
    const prefix = isBackup ? BACKUP_NAME_PREFIX : STAGING_NAME_PREFIX;
    if (!UUID_SUFFIX_PATTERN.test(name.slice(prefix.length))) {
      throw unsafeVaultInstallPathError();
    }
    const candidatePath = join(parentPath, name);
    if (!isBeneath(parentPath, candidatePath)) {
      throw unsafeVaultInstallPathError();
    }
    (isBackup ? backups : staging).push(candidatePath);
  }
  return Object.freeze({ backups, staging });
}

async function assertTargetAbsent(targetPath) {
  try {
    await lstat(targetPath);
  } catch (caught) {
    if (isMissing(caught)) return;
    throw unsafeVaultInstallPathError();
  }
  throw unsafeVaultInstallPathError();
}

async function recoverInterruptedReplacement(parentPath, targetPath) {
  const candidates = await recoveryCandidates(parentPath);
  if (candidates.backups.length === 0 && candidates.staging.length === 0) {
    return;
  }
  const currentTarget = await inspectExistingTarget(targetPath);
  if (candidates.backups.length === 0) {
    if (candidates.staging.length !== 1) {
      throw unsafeVaultInstallPathError();
    }
    const stagingPath = candidates.staging[0];
    if (stagingPath === undefined) {
      throw unsafeVaultInstallPathError();
    }
    await verifyPrivateStagingTree(stagingPath, stagingPath, { entries: 0 }, false, unsafeVaultInstallPathError);
    await rm(stagingPath, { recursive: true, force: false, maxRetries: 1 });
    await syncDirectory(parentPath);
    return;
  }
  if (currentTarget.exists || candidates.backups.length !== 1 || candidates.staging.length > 1) {
    throw unsafeVaultInstallPathError();
  }

  const backupPath = candidates.backups[0];
  if (backupPath === undefined) {
    throw unsafeVaultInstallPathError();
  }
  const backup = await inspectExistingTarget(backupPath);
  if (!backup.exists) {
    throw unsafeVaultInstallPathError();
  }
  for (const stagingPath of candidates.staging) {
    await verifyPrivateStagingTree(stagingPath, stagingPath, { entries: 0 }, false, unsafeVaultInstallPathError);
  }

  await assertTargetAbsent(targetPath);
  for (const stagingPath of candidates.staging) {
    await rm(stagingPath, { recursive: true, force: false, maxRetries: 1 });
    await syncDirectory(parentPath);
  }
  const finalBackup = await inspectExistingTarget(backupPath);
  if (!finalBackup.exists) {
    throw unsafeVaultInstallPathError();
  }
  await assertTargetAbsent(targetPath);
  await rename(backupPath, targetPath);
  await syncDirectory(parentPath);
}

async function removeTemporary(path) {
  await rm(path, { recursive: true, force: true, maxRetries: 1 }).catch(() => undefined);
}

async function ensurePrivateLog(homeDirectory) {
  const library = await ensureChildDirectory(homeDirectory, "Library", {
    privateMode: false,
    errorFactory: unsafeLogPathError,
  });
  const logs = await ensureChildDirectory(library, "Logs", {
    privateMode: false,
    errorFactory: unsafeLogPathError,
  });
  const logDirectory = await ensureChildDirectory(logs, "GrandboxBridge", {
    privateMode: true,
    errorFactory: unsafeLogPathError,
  });
  const logPath = join(logDirectory, "bridge.log");
  let handle;
  try {
    try {
      const existing = await lstat(logPath);
      if (existing.isSymbolicLink() || !existing.isFile() || (existing.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw unsafeLogPathError();
      }
    } catch (caught) {
      if (!isMissing(caught)) throw caught;
      handle = await open(
        logPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      const created = await handle.stat();
      if (!created.isFile() || (created.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw unsafeLogPathError();
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
    }
    const verified = await lstat(logPath);
    if (verified.isSymbolicLink() || !verified.isFile() || (verified.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw unsafeLogPathError();
    }
  } catch (caught) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (caught instanceof InstallerError) throw caught;
    throw unsafeLogPathError();
  }
  return Object.freeze({ logDirectory, logPath });
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    await handle.sync();
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

async function activateTarget({ targetPath, expectedTarget, temporaryPath, beforeActivation, afterBackupRename }) {
  let backupPath = null;
  let oldTargetMoved = false;
  let activated = false;
  const parentPath = dirname(targetPath);
  try {
    await assertTargetUnchanged(targetPath, expectedTarget);
    await beforeActivation?.();
    await assertTargetUnchanged(targetPath, expectedTarget);
    if (expectedTarget.exists) {
      backupPath = join(dirname(targetPath), `.${PLUGIN_ID}.backup.${randomUUID()}`);
      try {
        await lstat(backupPath);
        throw vaultInstallError();
      } catch (caught) {
        if (!isMissing(caught)) throw caught;
      }
      await rename(targetPath, backupPath);
      oldTargetMoved = true;
      await syncDirectory(parentPath);
      await afterBackupRename?.();
    }
    const staged = await lstat(temporaryPath);
    if (staged.isSymbolicLink() || !staged.isDirectory() || (staged.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw vaultInstallError();
    }
    await rename(temporaryPath, targetPath);
    activated = true;
    await syncDirectory(parentPath);
  } catch (caught) {
    if (!activated && oldTargetMoved && backupPath !== null) {
      try {
        await lstat(targetPath);
      } catch (targetError) {
        if (isMissing(targetError)) {
          await rename(backupPath, targetPath).catch(() => undefined);
          await syncDirectory(parentPath).catch(() => undefined);
        }
      }
    }
    if (caught instanceof InstallerError) throw caught;
    throw vaultInstallError();
  }
  if (backupPath !== null) {
    const backup = await lstat(backupPath).catch(() => null);
    if (backup !== null && !backup.isSymbolicLink() && backup.isDirectory()) {
      await rm(backupPath, { recursive: true, force: true, maxRetries: 1 });
      await syncDirectory(parentPath);
    }
  }
}

function validateInput(input) {
  if (typeof input !== "object" || input === null) {
    throw unsafeInstallPathError();
  }
  const candidate = input;
  const { stagingDirectory, vaultRoot, homeDirectory } = candidate;
  assertAbsoluteNormalizedPath(stagingDirectory, unsafeInstallPathError);
  assertAbsoluteNormalizedPath(vaultRoot, unsafeInstallPathError);
  assertAbsoluteNormalizedPath(homeDirectory, unsafeInstallPathError);
  const hooks = candidate.testHooks;
  if (hooks !== undefined && (typeof hooks !== "object" || hooks === null)) {
    throw unsafeInstallPathError();
  }
  const beforeActivation = hooks?.beforeActivation;
  const afterBackupRename = hooks?.afterBackupRename;
  const beforeStagingSync = hooks?.beforeStagingSync;
  if (
    (beforeActivation !== undefined && typeof beforeActivation !== "function") ||
    (afterBackupRename !== undefined && typeof afterBackupRename !== "function") ||
    (beforeStagingSync !== undefined && typeof beforeStagingSync !== "function")
  ) {
    throw unsafeInstallPathError();
  }
  return Object.freeze({
    stagingDirectory,
    vaultRoot,
    homeDirectory,
    beforeActivation,
    afterBackupRename,
    beforeStagingSync,
  });
}

/**
 * Installs only the four public plugin artifacts. Runtime configuration, credentials, state,
 * journals, and note content stay outside the vault; this function never writes log content.
 * `testHooks` is a narrow test-only interruption point used to prove rollback before activation.
 */
export async function installIntoVault(input) {
  let temporaryPath = null;
  try {
    const validated = validateInput(input);
    const artifacts = await stagingArtifacts(validated.stagingDirectory);
    await assertCanonicalDirectory(validated.vaultRoot, unsafeVaultInstallPathError);
    await assertCanonicalDirectory(validated.homeDirectory, unsafeLogPathError);

    const obsidianDirectory = await ensureChildDirectory(validated.vaultRoot, ".obsidian", {
      privateMode: false,
      errorFactory: unsafeVaultInstallPathError,
    });
    const pluginsDirectory = await ensureChildDirectory(obsidianDirectory, "plugins", {
      privateMode: false,
      errorFactory: unsafeVaultInstallPathError,
    });
    const targetPath = join(pluginsDirectory, PLUGIN_ID);
    await recoverInterruptedReplacement(pluginsDirectory, targetPath);
    const expectedTarget = await inspectExistingTarget(targetPath);
    const logs = await ensurePrivateLog(validated.homeDirectory);

    temporaryPath = await createTemporaryTarget(pluginsDirectory);
    if (expectedTarget.exists) {
      await copyTechnicalChildren(targetPath, temporaryPath, targetPath, { entries: 0 });
    }
    for (const artifact of REQUIRED_ARTIFACTS) {
      await copyRegularFile(artifacts.get(artifact), join(temporaryPath, artifact), unsafeArtifactsError);
    }
    await validated.beforeStagingSync?.();
    await synchronizePrivateStagingTree(temporaryPath);

    await activateTarget({
      targetPath,
      expectedTarget,
      temporaryPath,
      beforeActivation: validated.beforeActivation,
      afterBackupRename: validated.afterBackupRename,
    });
    temporaryPath = null;
    return Object.freeze({ pluginDirectory: targetPath, ...logs });
  } catch (caught) {
    if (temporaryPath !== null) {
      await removeTemporary(temporaryPath);
    }
    if (caught instanceof InstallerError) throw caught;
    throw vaultInstallError();
  }
}

export { REQUIRED_ARTIFACTS };
