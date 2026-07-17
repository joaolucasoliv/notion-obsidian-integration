import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PUBLIC_PLUGIN_ARTIFACTS = Object.freeze([
  "main.js",
  "bridge-worker.cjs",
  "manifest.json",
  "styles.css",
]);

const SOURCE_ARTIFACTS = Object.freeze({
  "main.js": "plugin/main.js",
  "bridge-worker.cjs": "worker/dist/bridge-worker.cjs",
  "manifest.json": "plugin/manifest.json",
  "styles.css": "plugin/styles.css",
});

const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function unsafePluginArtifactError() {
  return new Error("Unsafe plugin artifact");
}

function unsafeOutputPathError() {
  return new Error("Unsafe plugin release output path");
}

function isBeneath(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith("../") && !isAbsolute(fromRoot);
}

async function assertRegularSource(filePath) {
  let entry;
  try {
    entry = await lstat(filePath);
  } catch {
    throw unsafePluginArtifactError();
  }
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_ARTIFACT_BYTES) {
    throw unsafePluginArtifactError();
  }
  if (await realpath(filePath).catch(() => null) !== filePath) {
    throw unsafePluginArtifactError();
  }
}

async function assertOutputDirectory(directoryPath) {
  const entry = await lstat(directoryPath).catch(() => null);
  if (entry !== null && (entry.isSymbolicLink() || !entry.isDirectory())) {
    throw unsafeOutputPathError();
  }
  if (entry !== null && await realpath(directoryPath).catch(() => null) !== directoryPath) {
    throw unsafeOutputPathError();
  }
}

async function assertReleaseArtifacts(directoryPath) {
  const names = (await readdir(directoryPath)).sort();
  if (names.length !== PUBLIC_PLUGIN_ARTIFACTS.length || names.some((name) => !PUBLIC_PLUGIN_ARTIFACTS.includes(name))) {
    throw unsafePluginArtifactError();
  }
  await Promise.all(PUBLIC_PLUGIN_ARTIFACTS.map((name) => assertRegularSource(join(directoryPath, name))));
}

export async function preparePluginRelease({ projectRoot = process.cwd(), outputDirectory } = {}) {
  const resolvedRoot = resolve(projectRoot);
  const canonicalRoot = await realpath(resolvedRoot).catch(() => null);
  if (canonicalRoot !== resolvedRoot) {
    throw unsafeOutputPathError();
  }
  const resolvedOutput = resolve(outputDirectory ?? join(resolvedRoot, "dist", "grandbox-bridge"));
  if (!isBeneath(resolvedRoot, resolvedOutput)) {
    throw unsafeOutputPathError();
  }

  const sources = new Map();
  for (const artifact of PUBLIC_PLUGIN_ARTIFACTS) {
    const sourcePath = join(resolvedRoot, SOURCE_ARTIFACTS[artifact]);
    await assertRegularSource(sourcePath);
    sources.set(artifact, sourcePath);
  }

  const outputParent = dirname(resolvedOutput);
  await mkdir(outputParent, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (await realpath(outputParent).catch(() => null) !== outputParent) {
    throw unsafeOutputPathError();
  }
  await assertOutputDirectory(resolvedOutput);

  const stagingDirectory = join(outputParent, `.${basename(resolvedOutput)}.staging.${randomUUID()}`);
  const backupDirectory = join(outputParent, `.${basename(resolvedOutput)}.backup.${randomUUID()}`);
  await mkdir(stagingDirectory, { mode: PRIVATE_DIRECTORY_MODE });

  try {
    for (const artifact of PUBLIC_PLUGIN_ARTIFACTS) {
      const destination = join(stagingDirectory, artifact);
      await copyFile(sources.get(artifact), destination);
      await chmod(destination, PRIVATE_FILE_MODE);
    }
    await assertReleaseArtifacts(stagingDirectory);

    const existing = await lstat(resolvedOutput).catch(() => null);
    if (existing !== null) {
      await rename(resolvedOutput, backupDirectory);
    }
    try {
      await rename(stagingDirectory, resolvedOutput);
    } catch (error) {
      if (existing !== null) {
        await rename(backupDirectory, resolvedOutput).catch(() => undefined);
      }
      throw error;
    }
    if (existing !== null) {
      await rm(backupDirectory, { recursive: true, force: true });
    }
    return Object.freeze({ outputDirectory: resolvedOutput, artifacts: [...PUBLIC_PLUGIN_ARTIFACTS] });
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await preparePluginRelease();
  process.stdout.write(`${result.outputDirectory}\n`);
}
