import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { assertCanonicalRuntimePath, assertValidInstallationId } from "./paths.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LAUNCHCTL_PATH = "/bin/launchctl";
// `launchctl print gui/<uid>/<missing-label>` reports the explicit absent-service result as 113.
const LAUNCHCTL_SERVICE_ABSENT_EXIT_CODE = 113;
const SENSITIVE_PATH_FRAGMENT = /ntn_|relay-token|graph-key|secret_|bearer/i;

export interface LaunchAgentInput {
  readonly installationId: string;
  readonly nodePath: string;
  readonly workerPath: string;
  readonly configPath: string;
}

export interface ServiceCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface ServiceCommandResult {
  readonly code: number;
}

export interface ServiceCommandRunner {
  run(command: ServiceCommand): Promise<ServiceCommandResult>;
}

export interface ServiceLocation {
  readonly homeDirectory: string;
  readonly installationId: string;
  readonly uid: number;
  readonly runner: ServiceCommandRunner;
}

export interface InstallServiceInput extends LaunchAgentInput, ServiceLocation {}

export interface ServiceStatus {
  readonly label: string;
  readonly plistPath: string;
  readonly enabled: boolean;
}

function serviceError(): Error {
  return new Error("Unsafe service path");
}

function serviceCommandError(): Error {
  return new Error("Service command failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServiceCommandRunner(value: unknown): value is ServiceCommandRunner {
  return isRecord(value) && typeof value.run === "function";
}

function serviceLabel(installationId: string): string {
  try {
    assertValidInstallationId(installationId);
  } catch {
    throw serviceError();
  }
  return `com.grandbox.bridge.${installationId}`;
}

function assertSafeAbsolutePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    resolve(value) !== value ||
    SENSITIVE_PATH_FRAGMENT.test(value)
  ) {
    throw serviceError();
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function validatedLaunchAgentInput(input: unknown): LaunchAgentInput {
  if (!isRecord(input)) {
    throw serviceError();
  }
  const installationId = input.installationId;
  const nodePath = input.nodePath;
  const workerPath = input.workerPath;
  const configPath = input.configPath;
  if (typeof installationId !== "string") {
    throw serviceError();
  }
  serviceLabel(installationId);
  assertSafeAbsolutePath(nodePath);
  assertSafeAbsolutePath(workerPath);
  assertSafeAbsolutePath(configPath);
  return Object.freeze({ installationId, nodePath, workerPath, configPath });
}

function plistPathFor(homeDirectory: string, installationId: string): string {
  assertSafeAbsolutePath(homeDirectory);
  return join(homeDirectory, "Library", "LaunchAgents", `${serviceLabel(installationId)}.plist`);
}

function validateLocation(location: unknown): Readonly<{
  homeDirectory: string;
  installationId: string;
  uid: number;
  runner: ServiceCommandRunner;
  label: string;
  plistPath: string;
}> {
  if (!isRecord(location)) {
    throw serviceError();
  }
  const homeDirectory = location.homeDirectory;
  const installationId = location.installationId;
  const uid = location.uid;
  const runner = location.runner;
  assertSafeAbsolutePath(homeDirectory);
  if (typeof installationId !== "string" || typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) {
    throw serviceError();
  }
  if (!isServiceCommandRunner(runner)) {
    throw serviceError();
  }
  const label = serviceLabel(installationId);
  return Object.freeze({
    homeDirectory,
    installationId,
    uid,
    runner,
    label,
    plistPath: plistPathFor(homeDirectory, installationId),
  });
}

async function assertSafeDirectory(directoryPath: string): Promise<void> {
  try {
    await assertCanonicalRuntimePath(directoryPath);
    const entry = await lstat(directoryPath);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw serviceError();
    }
  } catch {
    throw serviceError();
  }
}

async function assertSafeRegularFile(filePath: string, requirePrivateMode: boolean): Promise<void> {
  try {
    await assertCanonicalRuntimePath(filePath);
    const entry = await lstat(filePath);
    if (
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      (requirePrivateMode && (entry.mode & 0o777) !== PRIVATE_FILE_MODE)
    ) {
      throw serviceError();
    }
  } catch {
    throw serviceError();
  }
}

async function ensureServiceDirectory(directoryPath: string): Promise<void> {
  try {
    await assertCanonicalRuntimePath(directoryPath);
    await mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await assertCanonicalRuntimePath(directoryPath);
    const entry = await lstat(directoryPath);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw serviceError();
    }
  } catch {
    throw serviceError();
  }
}

async function writePrivatePlist(filePath: string, text: string): Promise<void> {
  const parentPath = dirname(filePath);
  let temporaryPath: string | null = null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await ensureServiceDirectory(parentPath);
    await assertCanonicalRuntimePath(filePath);
    try {
      const destination = await lstat(filePath);
      if (destination.isSymbolicLink() || !destination.isFile()) {
        throw serviceError();
      }
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "ENOENT") {
        throw caught;
      }
    }

    temporaryPath = join(parentPath, `.${serviceLabelFromPlistPath(filePath)}.${randomUUID()}.tmp`);
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    const opened = await handle.stat();
    if (!opened.isFile() || (opened.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw serviceError();
    }
    await handle.writeFile(text, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;

    await assertCanonicalRuntimePath(filePath);
    const temporary = await lstat(temporaryPath);
    if (temporary.isSymbolicLink() || !temporary.isFile() || (temporary.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw serviceError();
    }
    await rename(temporaryPath, filePath);
    temporaryPath = null;
    await chmod(filePath, PRIVATE_FILE_MODE);
    const finalEntry = await lstat(filePath);
    if (finalEntry.isSymbolicLink() || !finalEntry.isFile() || (finalEntry.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw serviceError();
    }
  } catch {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
    if (temporaryPath !== null) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    throw serviceError();
  }
}

function serviceLabelFromPlistPath(filePath: string): string {
  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);
  if (!/^com\.grandbox\.bridge\.[0-9a-f-]+\.plist$/.test(fileName)) {
    throw serviceError();
  }
  return fileName.slice(0, -".plist".length);
}

async function runLaunchctl(runner: ServiceCommandRunner, args: readonly string[]): Promise<ServiceCommandResult> {
  let result: ServiceCommandResult;
  try {
    result = await runner.run(Object.freeze({ executable: LAUNCHCTL_PATH, args: Object.freeze([...args]) }));
  } catch {
    throw serviceCommandError();
  }
  if (typeof result !== "object" || result === null || !Number.isSafeInteger(result.code)) {
    throw serviceCommandError();
  }
  return result;
}

/** Renders a launchd plist that can only schedule the local worker through a private external config path. */
export function renderLaunchAgentPlist(input: unknown): string {
  const validated = validatedLaunchAgentInput(input);
  const label = serviceLabel(validated.installationId);
  const argumentsXml = [
    validated.nodePath,
    validated.workerPath,
    "--config",
    validated.configPath,
    "--reason",
    "schedule",
    "--json",
  ].map((argument) => `<string>${escapeXml(argument)}</string>`).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${escapeXml(label)}</string>`,
    `<key>ProgramArguments</key><array>${argumentsXml}</array>`,
    "<key>StartInterval</key><integer>300</integer>",
    "<key>RunAtLoad</key><true/>",
    "<key>StandardOutPath</key><string>/dev/null</string>",
    "<key>StandardErrorPath</key><string>/dev/null</string>",
    "</dict></plist>",
  ].join("");
}

/** Installs and verifies one per-user LaunchAgent through an injected, argv-only launchctl boundary. */
export async function installService(input: InstallServiceInput): Promise<ServiceStatus> {
  const launch = validatedLaunchAgentInput(input);
  const location = validateLocation(input);
  if (launch.installationId !== location.installationId) {
    throw serviceError();
  }
  await assertSafeDirectory(location.homeDirectory);
  await Promise.all([
    assertSafeRegularFile(launch.nodePath, false),
    assertSafeRegularFile(launch.workerPath, false),
    assertSafeRegularFile(launch.configPath, true),
  ]);

  await writePrivatePlist(location.plistPath, renderLaunchAgentPlist(launch));
  await runLaunchctl(location.runner, ["bootout", `gui/${location.uid}`, location.plistPath]);
  const bootstrap = await runLaunchctl(location.runner, ["bootstrap", `gui/${location.uid}`, location.plistPath]);
  if (bootstrap.code !== 0) {
    throw serviceCommandError();
  }
  const printed = await runLaunchctl(location.runner, ["print", `gui/${location.uid}/${location.label}`]);
  if (printed.code !== 0) {
    throw serviceCommandError();
  }
  return Object.freeze({ label: location.label, plistPath: location.plistPath, enabled: true });
}

/** Disables the specific per-user LaunchAgent and verifies that launchd no longer exposes it. */
export async function disableService(input: ServiceLocation): Promise<ServiceStatus> {
  const location = validateLocation(input);
  await assertSafeDirectory(location.homeDirectory);
  const bootout = await runLaunchctl(location.runner, ["bootout", `gui/${location.uid}`, location.plistPath]);
  if (bootout.code !== 0 && bootout.code !== LAUNCHCTL_SERVICE_ABSENT_EXIT_CODE) {
    throw serviceCommandError();
  }
  const printed = await runLaunchctl(location.runner, ["print", `gui/${location.uid}/${location.label}`]);
  if (printed.code !== LAUNCHCTL_SERVICE_ABSENT_EXIT_CODE) {
    throw serviceCommandError();
  }
  return Object.freeze({ label: location.label, plistPath: location.plistPath, enabled: false });
}
