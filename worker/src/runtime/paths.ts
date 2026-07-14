import { lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, normalize, parse, sep } from "node:path";

const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RuntimePaths {
  readonly root: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly lockPath: string;
  readonly journalDir: string;
  readonly logPath: string;
}

export function assertValidInstallationId(installationId: string): void {
  if (!INSTALLATION_ID_PATTERN.test(installationId)) {
    throw new Error("Invalid installation identity");
  }
}

function assertRuntimePathSyntax(filePath: string): void {
  if (!isAbsolute(filePath) || filePath.includes("\0") || normalize(filePath) !== filePath) {
    throw new Error("Unsafe runtime path");
  }
}

function pathComponents(filePath: string): string[] {
  const root = parse(filePath).root;
  return filePath.slice(root.length).split(sep).filter((component) => component.length > 0);
}

export async function assertCanonicalRuntimePath(filePath: string): Promise<void> {
  assertRuntimePathSyntax(filePath);
  const root = parse(filePath).root;
  let current = root;
  for (const component of pathComponents(filePath)) {
    current = join(current, component);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error("Unsafe runtime path");
      }
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw new Error("Unsafe runtime path");
    }
  }
}

export function assertCanonicalRuntimePathSync(filePath: string): void {
  assertRuntimePathSyntax(filePath);
  const root = parse(filePath).root;
  let current = root;
  for (const component of pathComponents(filePath)) {
    current = join(current, component);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink()) {
        throw new Error("Unsafe runtime path");
      }
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw new Error("Unsafe runtime path");
    }
  }
}

export function deriveRuntimePaths(homeDirectory: string, installationId: string): RuntimePaths {
  assertValidInstallationId(installationId);
  if (!isAbsolute(homeDirectory) || homeDirectory.includes("\0")) {
    throw new Error("Invalid home directory");
  }

  const root = join(homeDirectory, "Library", "Application Support", "Grandbox Bridge", installationId);

  return {
    root,
    configPath: join(root, "config.json"),
    statePath: join(root, "state.json"),
    lockPath: join(root, "sync.lock"),
    journalDir: join(root, "journal"),
    logPath: join(homeDirectory, "Library", "Logs", "GrandboxBridge", "bridge.log"),
  };
}
