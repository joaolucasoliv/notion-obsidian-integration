import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { sha256Hex } from "@grandbox-bridge/shared";
import { assertValidInstallationId } from "../runtime/paths.js";

const MAX_RELATIVE_PATH_BYTES = 1_024;

export interface CanonicalVaultRoot {
  readonly canonicalRealPath: string;
  readonly filesystemDeviceId: string;
  readonly vaultFingerprint: string;
}

export type VaultIdentityMode =
  | { readonly mode: "bootstrap" }
  | { readonly mode: "verify"; readonly expectedFingerprint: string };

export type VaultPathIntent = "existing-file" | "write-target";

function unsafeVaultPathError(): Error {
  return new Error("Unsafe vault path");
}

function isBeneath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function expectedFingerprintForMode(identity: VaultIdentityMode): string | null {
  if (
    typeof identity !== "object" ||
    identity === null ||
    !("mode" in identity) ||
    (identity.mode !== "bootstrap" && identity.mode !== "verify")
  ) {
    throw new Error("Invalid vault identity mode");
  }
  const keys = Object.keys(identity);
  if (identity.mode === "bootstrap") {
    if (keys.length !== 1 || keys[0] !== "mode") {
      throw new Error("Invalid vault identity mode");
    }
    return null;
  }
  if (
    keys.length !== 2 ||
    !keys.includes("mode") ||
    !keys.includes("expectedFingerprint") ||
    !/^[0-9a-f]{64}$/.test(identity.expectedFingerprint)
  ) {
    throw new Error("Invalid vault identity mode");
  }
  return identity.expectedFingerprint;
}

function validateRelativePath(relativePath: string): string[] {
  const segments = relativePath.split("/");
  const unsafe =
    relativePath.length === 0 ||
    Buffer.byteLength(relativePath, "utf8") > MAX_RELATIVE_PATH_BYTES ||
    relativePath.startsWith("/") ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    /[\r\n]/.test(relativePath) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");

  if (unsafe) {
    throw unsafeVaultPathError();
  }
  return segments;
}

export async function canonicalVaultRoot(
  configuredPath: string,
  installationId: string,
  identity: VaultIdentityMode,
): Promise<CanonicalVaultRoot> {
  assertValidInstallationId(installationId);
  if (!isAbsolute(configuredPath) || configuredPath.includes("\0") || normalize(configuredPath) !== configuredPath) {
    throw new Error("Invalid vault root");
  }
  const expectedFingerprint = expectedFingerprintForMode(identity);

  let canonicalRealPath: string;
  let filesystemDeviceId: string;
  try {
    canonicalRealPath = await realpath(configuredPath);
    const rootStats = await stat(canonicalRealPath);
    if (!rootStats.isDirectory()) {
      throw new Error("not a directory");
    }
    filesystemDeviceId = String(rootStats.dev);
  } catch {
    throw new Error("Invalid vault root");
  }

  const vaultFingerprint = await sha256Hex(
    `${canonicalRealPath}\0${filesystemDeviceId}\0${installationId}`,
  );
  if (expectedFingerprint !== null && expectedFingerprint !== vaultFingerprint) {
    throw new Error("Vault identity mismatch");
  }

  return { canonicalRealPath, filesystemDeviceId, vaultFingerprint };
}

export async function resolveSafeVaultPath(
  root: CanonicalVaultRoot,
  relativePath: string,
  intent: VaultPathIntent,
): Promise<string> {
  if (intent !== "existing-file" && intent !== "write-target") {
    throw unsafeVaultPathError();
  }
  const segments = validateRelativePath(relativePath);
  const candidate = join(root.canonicalRealPath, ...segments);
  if (!isBeneath(root.canonicalRealPath, candidate)) {
    throw unsafeVaultPathError();
  }

  try {
    const canonicalCheck = await realpath(root.canonicalRealPath);
    const rootStats = await stat(canonicalCheck);
    if (
      canonicalCheck !== root.canonicalRealPath ||
      !rootStats.isDirectory() ||
      String(rootStats.dev) !== root.filesystemDeviceId
    ) {
      throw unsafeVaultPathError();
    }

    let current = root.canonicalRealPath;
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index] as string);
      let entry;
      try {
        entry = await lstat(current);
      } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
          const isLast = index === segments.length - 1;
          if (intent === "write-target" && isLast) {
            return candidate;
          }
          throw unsafeVaultPathError();
        }
        throw caught;
      }

      if (entry.isSymbolicLink()) {
        throw unsafeVaultPathError();
      }
      const isLast = index === segments.length - 1;
      if ((!isLast && !entry.isDirectory()) || (isLast && !entry.isFile())) {
        throw unsafeVaultPathError();
      }
    }

    const resolvedCandidate = await realpath(candidate);
    if (!isBeneath(root.canonicalRealPath, resolvedCandidate)) {
      throw unsafeVaultPathError();
    }
    return candidate;
  } catch {
    throw unsafeVaultPathError();
  }
}
