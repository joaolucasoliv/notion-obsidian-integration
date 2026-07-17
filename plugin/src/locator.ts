const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ExternalLocator {
  readonly installationId: string;
  readonly homeDirectory: string;
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly configPath: string;
  readonly nodeExecutable: string;
  readonly workerPath: string;
}

export interface ExternalLocatorInput {
  readonly installationId: string;
  readonly homeDirectory: string;
  readonly vaultRoot: string;
  readonly nodeExecutable: string;
  readonly workerPath: string;
}

function invalidLocator(): Error {
  return new Error("Bridge runtime unavailable");
}

function isAbsoluteNormalizedPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.length > 1 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes("//") &&
    !value.includes("/./") &&
    !value.includes("/../") &&
    !value.endsWith("/") &&
    value !== "/.." &&
    value !== "/."
  );
}

export function isCanonicalInstallationId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Creates transient runtime paths from the opaque installation identity.  The
 * caller must never save this locator into Obsidian plugin data.
 */
export function deriveExternalLocator(input: ExternalLocatorInput): ExternalLocator {
  if (
    !isCanonicalInstallationId(input.installationId) ||
    !isAbsoluteNormalizedPath(input.homeDirectory) ||
    !isAbsoluteNormalizedPath(input.vaultRoot) ||
    !isAbsoluteNormalizedPath(input.nodeExecutable) ||
    !isAbsoluteNormalizedPath(input.workerPath)
  ) {
    throw invalidLocator();
  }
  const runtimeRoot = `${input.homeDirectory}/Library/Application Support/Grandbox Bridge/${input.installationId}`;
  return Object.freeze({
    installationId: input.installationId,
    homeDirectory: input.homeDirectory,
    vaultRoot: input.vaultRoot,
    runtimeRoot,
    configPath: `${runtimeRoot}/config.json`,
    nodeExecutable: input.nodeExecutable,
    workerPath: input.workerPath,
  });
}
