import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

export interface NodeRuntimeInput {
  readonly homeDirectory: string;
  readonly path: string | undefined;
  readonly isExecutable?: (candidate: string) => boolean;
  readonly canonicalize?: (candidate: string) => string;
}

function runtimeError(): Error {
  return new Error("Node runtime unavailable");
}

function isAbsoluteNormalizedPath(value: string): boolean {
  return (
    value.length > 1 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    normalize(value) === value &&
    resolve(value) === value
  );
}

function executableRegularFile(candidate: string): boolean {
  try {
    const metadata = statSync(candidate);
    return metadata.isFile() && (metadata.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Resolves a standalone Node runtime; Obsidian's Electron executable cannot run the worker directly. */
export function resolveNodeExecutable(input: NodeRuntimeInput): string {
  if (!isAbsoluteNormalizedPath(input.homeDirectory)) throw runtimeError();
  const fromPath = (input.path ?? "")
    .split(":")
    .filter((directory) => isAbsoluteNormalizedPath(directory))
    .map((directory) => join(directory, "node"));
  const candidates = [
    join(input.homeDirectory, ".local", "bin", "node"),
    ...fromPath,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  const isExecutable = input.isExecutable ?? executableRegularFile;
  const canonicalize = input.canonicalize ?? realpathSync;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isAbsoluteNormalizedPath(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (!isExecutable(candidate)) continue;
      const canonical = canonicalize(candidate);
      if (isAbsoluteNormalizedPath(canonical)) return canonical;
    } catch {
      // Treat a failed local stat as an unavailable runtime and continue safely.
    }
  }
  throw runtimeError();
}
