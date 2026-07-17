import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

const MAX_LOCATOR_BYTES = 8 * 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function locatorError(): Error {
  return new Error("Bridge setup unavailable");
}

function sameIdentity(left: Readonly<{ dev: number; ino: number }>, right: Readonly<{ dev: number; ino: number }>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function safeDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw locatorError();
}

function parseLocator(bytes: Uint8Array): string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw locatorError();
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "installationId") ||
    !UUID_PATTERN.test((value as { readonly installationId?: unknown }).installationId as string)
  ) {
    throw locatorError();
  }
  return (value as { readonly installationId: string }).installationId;
}

/** Reads the only non-secret plugin datum needed by the setup worker. */
export async function readInstallationIdFromVault(vaultRoot: string): Promise<string> {
  if (!isAbsolute(vaultRoot) || vaultRoot.includes("\0") || normalize(vaultRoot) !== vaultRoot) throw locatorError();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const root = await realpath(vaultRoot);
    await safeDirectory(root);
    const obsidian = join(root, ".obsidian");
    const plugins = join(obsidian, "plugins");
    const plugin = join(plugins, "grandbox-bridge");
    await safeDirectory(obsidian);
    await safeDirectory(plugins);
    await safeDirectory(plugin);
    const dataPath = join(plugin, "data.json");
    const before = await lstat(dataPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LOCATOR_BYTES) throw locatorError();
    handle = await open(dataPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size > MAX_LOCATOR_BYTES) throw locatorError();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== opened.size || !after.isFile() || !sameIdentity(before, after)) throw locatorError();
    return parseLocator(bytes);
  } catch {
    throw locatorError();
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}
