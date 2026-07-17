import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import {
  parseBridgeConfig,
  parseBridgeRunSummary,
  SAFE_ERROR_CODES,
  type BridgeRunSummary,
  type SafeErrorCode,
} from "@grandbox-bridge/shared";
import { FileConfigStore } from "./persistence/config-store.js";
import { FileJournalStore } from "./persistence/journal-store.js";
import { FileStateStore } from "./persistence/state-store.js";
import { readStrictJson } from "./runtime/atomic-json.js";
import { MacOSKeychainCredentialStore, type ProcessRunner } from "./runtime/keychain.js";
import { withInstallationLock } from "./runtime/lock.js";
import { deriveRuntimePaths, type RuntimePaths } from "./runtime/paths.js";
import { redactSensitiveOutput, SafeFileLogger } from "./runtime/safe-log.js";
import { fromNotionMarkdown } from "./markdown/notion-mapping.js";
import { semanticHash } from "./markdown/normalize.js";
import { FetchNotionTransport } from "./notion/transport.js";
import { NotionClient, type NotionObservationDecoder, type RawNotionPageRecord } from "./notion/client.js";
import { createNotionWorkspaceProvisioner, NotionSetupError } from "./setup/notion-provision.js";
import {
  InstallationInitializer,
  type CortexRootValidator,
  type NotionWorkspaceProvisioner,
} from "./setup/installation.js";
import { readInstallationIdFromVault } from "./setup/vault-locator.js";
import { persistedLinkMapping } from "./sync/reconcile.js";
import { canonicalVaultRoot } from "./vault/safety.js";
import { GrandboxBridgeWorker, type BridgeWorker, type WorkerLock } from "./worker.js";

const MAX_SUMMARY_BYTES = 8 * 1_024;
const MAX_SETUP_SUMMARY_BYTES = 1_024;
const CLI_FAILURE_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export type ParsedCliArguments =
  | { readonly kind: "help" }
  | {
      readonly kind: "setup";
      readonly mode: "preview" | "apply" | "status";
      readonly vaultRoot: string;
      readonly parentPageId: string | null;
    }
  | {
      readonly kind: "setup-cortex";
      readonly mode: "apply" | "status";
      readonly vaultRoot: string;
      readonly rootPageId: string | null;
    }
  | {
      readonly kind: "run";
      readonly configPath: string;
      readonly mode: "preview" | "apply";
      readonly reason: "manual" | "obsidian-event" | "schedule" | "reconciliation";
    };

export interface CliWritable {
  write(value: string): boolean | void;
}

export interface CliDependencies {
  readonly stdout: CliWritable;
  readonly stderr: CliWritable;
  readonly createWorker: (configPath: string) => Promise<BridgeWorker>;
  readonly readSetupInstallationId?: (vaultRoot: string) => Promise<string>;
  readonly readSetupToken?: () => Promise<string | null>;
  readonly createInstallationInitializer?: (installationId: string) => Promise<Pick<InstallationInitializer, "initialize" | "status">>;
  readonly createCortexInstallationInitializer?: (installationId: string) => Promise<Pick<InstallationInitializer, "configureCortex" | "cortexStatus">>;
}

function cliError(): Error {
  return new Error("Invalid bridge worker invocation");
}

function isReason(value: string): value is Extract<ParsedCliArguments, { readonly kind: "run" }> ["reason"] {
  return value === "manual" || value === "obsidian-event" || value === "schedule" || value === "reconciliation";
}

function validConfigPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    normalize(value) === value &&
    resolve(value) === value
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function validPageId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function parseSetupArguments(argv: readonly string[]): Extract<ParsedCliArguments, { readonly kind: "setup" }> {
  const mode = argv[1];
  if (mode !== "preview" && mode !== "apply" && mode !== "status") throw cliError();
  let vaultRoot: string | null = null;
  let parentPageId: string | null = null;
  let json = false;
  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--vault" || current === "--parent-page-id") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw cliError();
      index += 1;
      if (current === "--vault") {
        if (vaultRoot !== null || !validConfigPath(value)) throw cliError();
        vaultRoot = value;
      } else {
        if (parentPageId !== null || !validPageId(value)) throw cliError();
        parentPageId = value;
      }
      continue;
    }
    if (current === "--json") {
      if (json) throw cliError();
      json = true;
      continue;
    }
    throw cliError();
  }
  if (vaultRoot === null || !json || ((mode === "preview" || mode === "apply") && parentPageId === null)) {
    throw cliError();
  }
  if (mode === "status" && parentPageId !== null) throw cliError();
  return Object.freeze({ kind: "setup" as const, mode, vaultRoot, parentPageId });
}

function parseCortexSetupArguments(argv: readonly string[]): Extract<ParsedCliArguments, { readonly kind: "setup-cortex" }> {
  const mode = argv[2];
  if (mode !== "apply" && mode !== "status") throw cliError();
  let vaultRoot: string | null = null;
  let rootPageId: string | null = null;
  let json = false;
  for (let index = 3; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--vault" || current === "--root-page-id") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw cliError();
      index += 1;
      if (current === "--vault") {
        if (vaultRoot !== null || !validConfigPath(value)) throw cliError();
        vaultRoot = value;
      } else {
        if (rootPageId !== null || !validPageId(value)) throw cliError();
        rootPageId = value;
      }
      continue;
    }
    if (current === "--json") {
      if (json) throw cliError();
      json = true;
      continue;
    }
    throw cliError();
  }
  if (vaultRoot === null || !json || (mode === "apply" && rootPageId === null)) throw cliError();
  if (mode === "status" && rootPageId !== null) throw cliError();
  return Object.freeze({ kind: "setup-cortex" as const, mode, vaultRoot, rootPageId });
}

export function parseCliArguments(argv: readonly string[]): ParsedCliArguments {
  if (argv.length === 1 && argv[0] === "--help") return Object.freeze({ kind: "help" as const });
  if (argv[0] === "setup" && argv[1] === "cortex") return parseCortexSetupArguments(argv);
  if (argv[0] === "setup") return parseSetupArguments(argv);
  let configPath: string | null = null;
  let reason: Extract<ParsedCliArguments, { readonly kind: "run" }> ["reason"] | null = null;
  let dryRun = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--config" || current === "--reason") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw cliError();
      index += 1;
      if (current === "--config") {
        if (configPath !== null || !validConfigPath(value)) throw cliError();
        configPath = value;
      } else {
        if (reason !== null || !isReason(value)) throw cliError();
        reason = value;
      }
      continue;
    }
    if (current === "--dry-run") {
      if (dryRun) throw cliError();
      dryRun = true;
      continue;
    }
    if (current === "--json") {
      if (json) throw cliError();
      json = true;
      continue;
    }
    throw cliError();
  }
  if (configPath === null || reason === null || !json) throw cliError();
  return Object.freeze({ kind: "run" as const, configPath, mode: dryRun ? "preview" : "apply", reason });
}

function helpText(): string {
  return [
    "Usage: bridge-worker.cjs --config <absolute-path> [--dry-run] --reason <manual|obsidian-event|schedule|reconciliation> --json",
    "       bridge-worker.cjs setup <preview|apply|status> --vault <absolute-path> [--parent-page-id <uuid>] --json",
    "       bridge-worker.cjs setup cortex <apply|status> --vault <absolute-path> [--root-page-id <uuid>] --json",
    "",
    "--config   Absolute normalized bridge configuration path.",
    "--dry-run  Plan safely without applying local, Notion, journal, state, or UUID mutations.",
    "--reason   Invocation source: manual, obsidian-event, schedule, or reconciliation.",
    "--json     Emit exactly one JSON BridgeRunSummary on stdout.",
    "--help     Print this help text and exit successfully.",
    "",
  ].join("\n");
}

function fallbackSummary(mode: "preview" | "apply"): BridgeRunSummary {
  return {
    mode,
    outcome: "failed",
    planned: 0,
    writes: 0,
    pushed: 0,
    pulled: 0,
    conflicts: 0,
    errors: 1,
    graphUploads: 0,
    startedAt: CLI_FAILURE_TIMESTAMP,
    completedAt: CLI_FAILURE_TIMESTAMP,
  };
}

function writeSummary(output: CliWritable, value: BridgeRunSummary): void {
  const parsed = parseBridgeRunSummary(value);
  const line = `${JSON.stringify(parsed)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_SUMMARY_BYTES) {
    throw new Error("Bridge summary exceeds output budget");
  }
  output.write(line);
}

function writeSetupSummary(output: CliWritable, value: unknown): void {
  if (
    typeof value !== "object" ||
    value === null ||
    ((value as { readonly configuration?: unknown }).configuration !== "unconfigured" &&
      (value as { readonly configuration?: unknown }).configuration !== "ready") ||
    typeof (value as { readonly created?: unknown }).created !== "boolean"
  ) {
    throw new Error("Invalid setup summary");
  }
  const line = `${JSON.stringify({
    configuration: (value as { readonly configuration: "unconfigured" | "ready" }).configuration,
    created: (value as { readonly created: boolean }).created,
  })}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_SETUP_SUMMARY_BYTES) throw new Error("Setup summary exceeds output budget");
  output.write(line);
}

function isSafeErrorCode(value: unknown): value is SafeErrorCode {
  return typeof value === "string" && (SAFE_ERROR_CODES as readonly string[]).includes(value);
}

function setupFailureCode(caught: unknown): SafeErrorCode {
  if (caught instanceof NotionSetupError && isSafeErrorCode(caught.code)) return caught.code;
  return "internal-error";
}

function writeSetupFailure(output: CliWritable, code: SafeErrorCode): void {
  const line = `${JSON.stringify({ configuration: "unconfigured", created: false, error: code })}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_SETUP_SUMMARY_BYTES) throw new Error("Setup failure exceeds output budget");
  output.write(line);
}

/** Reads one credential from stdin so it never appears in argv, a file, or a log. */
export async function readSetupToken(source: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of source) {
      const next = Buffer.from(chunk);
      bytes += next.byteLength;
      if (bytes > 8_193) throw new Error("setup credential unavailable");
      chunks.push(next);
    }
  } catch (caught) {
    if (caught instanceof Error && caught.message === "setup credential unavailable") throw caught;
    throw new Error("setup credential unavailable");
  }
  const input = Buffer.concat(chunks).toString("utf8");
  const token = input.endsWith("\n") ? input.slice(0, -1) : input;
  if (
    token.length === 0 ||
    Buffer.byteLength(token, "utf8") > 8_192 ||
    /[\r\n\0]/u.test(token) ||
    !Buffer.from(token, "utf8").equals(Buffer.concat(chunks).subarray(0, Buffer.byteLength(input.endsWith("\n") ? token : input, "utf8")))
  ) {
    throw new Error("setup credential unavailable");
  }
  return token;
}

function safeDiagnostic(stderr: CliWritable, message: string): void {
  try {
    stderr.write(`${redactSensitiveOutput(message)}\n`);
  } catch {
    // stdout remains the only data channel for a normal invocation.
  }
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies): Promise<number> {
  let parsed: ParsedCliArguments;
  try {
    parsed = parseCliArguments(argv);
  } catch {
    safeDiagnostic(dependencies.stderr, "bridge-worker: invalid invocation");
    return 2;
  }
  if (parsed.kind === "help") {
    dependencies.stdout.write(helpText());
    return 0;
  }
  if (parsed.kind === "setup-cortex") {
    try {
      if (
        dependencies.readSetupInstallationId === undefined ||
        dependencies.createCortexInstallationInitializer === undefined
      ) {
        throw new Error("setup unavailable");
      }
      const installationId = await dependencies.readSetupInstallationId(parsed.vaultRoot);
      const initializer = await dependencies.createCortexInstallationInitializer(installationId);
      const result = parsed.mode === "status"
        ? await initializer.cortexStatus({ installationId, vaultRoot: parsed.vaultRoot })
        : await initializer.configureCortex({
          installationId,
          vaultRoot: parsed.vaultRoot,
          rootPageId: parsed.rootPageId as string,
        });
      writeSetupSummary(dependencies.stdout, result);
      return 0;
    } catch (caught) {
      try {
        writeSetupFailure(dependencies.stdout, setupFailureCode(caught));
      } catch {
        // A failed stdout must not leak provider details through stderr.
      }
      safeDiagnostic(dependencies.stderr, "bridge-worker: Cortex setup failed");
      return 1;
    }
  }
  if (parsed.kind === "setup") {
    try {
      if (
        dependencies.readSetupInstallationId === undefined ||
        dependencies.createInstallationInitializer === undefined ||
        (parsed.mode === "apply" && dependencies.readSetupToken === undefined)
      ) {
        throw new Error("setup unavailable");
      }
      const installationId = await dependencies.readSetupInstallationId(parsed.vaultRoot);
      const initializer = await dependencies.createInstallationInitializer(installationId);
      const result = parsed.mode === "status"
        ? await initializer.status({ installationId, vaultRoot: parsed.vaultRoot })
        : await initializer.initialize({
          installationId,
          vaultRoot: parsed.vaultRoot,
          parentPageId: parsed.parentPageId as string,
          token: parsed.mode === "apply" ? await dependencies.readSetupToken?.() ?? null : null,
          mode: parsed.mode,
        });
      writeSetupSummary(dependencies.stdout, result);
      return 0;
    } catch (caught) {
      try {
        writeSetupFailure(dependencies.stdout, setupFailureCode(caught));
      } catch {
        // A failed stdout must not leak provider details through stderr.
      }
      safeDiagnostic(dependencies.stderr, "bridge-worker: setup failed");
      return 1;
    }
  }
  try {
    const worker = await dependencies.createWorker(parsed.configPath);
    const result = await worker.run({ mode: parsed.mode, reason: parsed.reason });
    writeSummary(dependencies.stdout, result);
    return result.outcome === "failed" || result.outcome === "recovery-required" ? 1 : 0;
  } catch {
    const fallback = fallbackSummary(parsed.mode);
    try {
      writeSummary(dependencies.stdout, fallback);
    } catch {
      // A failed output stream must not leak an exception or request context.
    }
    safeDiagnostic(dependencies.stderr, "bridge-worker: run failed");
    return 1;
  }
}

/** Derives the only supported private runtime tree, including the user-scoped rotating log path. */
export function deriveProductionRuntimePaths(configPath: string, installationId: string): RuntimePaths {
  if (!validConfigPath(configPath)) {
    throw new Error("Invalid bridge runtime configuration path");
  }
  const installationRoot = dirname(configPath);
  const bridgeRoot = dirname(installationRoot);
  const supportRoot = dirname(bridgeRoot);
  const libraryRoot = dirname(supportRoot);
  const homeDirectory = dirname(libraryRoot);
  const paths = deriveRuntimePaths(homeDirectory, installationId);
  if (paths.configPath !== configPath) {
    throw new Error("Invalid bridge runtime configuration path");
  }
  return paths;
}

function processRunner(): ProcessRunner {
  return {
    run: async (input) => new Promise((resolveResult, reject) => {
      let child;
      try {
        child = spawn(input.executable, input.args, {
          stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        });
      } catch {
        reject(new Error("process failed"));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      const append = (target: Buffer[], chunk: Buffer): void => {
        size += chunk.byteLength;
        if (size > input.maxBytes * 2) {
          child.kill();
          reject(new Error("process output too large"));
          return;
        }
        target.push(chunk);
      };
      child.stdout?.on("data", (chunk: Buffer) => append(stdout, Buffer.from(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => append(stderr, Buffer.from(chunk)));
      child.on("error", () => reject(new Error("process failed")));
      child.on("close", (code) => {
        try {
          resolveResult({
            code: typeof code === "number" ? code : 1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        } catch {
          reject(new Error("process failed"));
        }
      });
      if (input.stdin !== undefined) child.stdin?.end(input.stdin, "utf8");
    }),
  };
}

async function fileMissing(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return false;
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw new Error("Runtime setup unavailable");
  }
}

function initialInstallationState(installationId: string) {
  return {
    schemaVersion: 1 as const,
    installationId,
    pairs: {},
    graph: null,
    lastFullReconciliationAt: null,
    lastRun: null,
  };
}

function productionCortexRootValidator(state: FileStateStore): CortexRootValidator {
  return async ({ token, rootPageId }) => {
    const notion = new NotionClient(
      token,
      new FetchNotionTransport(),
      createProductionNotionObservationDecoder(await state.load()),
      { clock: { now: () => new Date(), sleep: async (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)) } },
    );
    const discovery = await notion.cortexTree.discoverCortexTree({ rootPageId, maxDepth: 32, maxPages: 5_000 });
    const root = discovery.pages.find((page) => page.pageId === rootPageId) ?? null;
    if (!discovery.complete || root === null || root.parentPageId !== null || !root.complete) {
      throw new Error("Cortex root validation failed");
    }
    return Object.freeze(discovery.pages.map((page) => page.pageId));
  };
}

export interface ProductionInstallationInitializerOptions {
  readonly processRunner?: ProcessRunner;
  readonly provisionNotion?: NotionWorkspaceProvisioner;
  readonly validateCortexRoot?: CortexRootValidator;
}

export interface ProductionCliDependenciesInput {
  readonly stdout: CliWritable;
  readonly stderr: CliWritable;
  readonly homeDirectory: string;
  readonly setupTokenSource: AsyncIterable<Uint8Array | string>;
  readonly processRunner?: ProcessRunner;
  readonly provisionNotion?: NotionWorkspaceProvisioner;
}

/** Composes file, Keychain, vault, and Notion adapters only for an explicit local setup action. */
export function createProductionInstallationInitializer(
  configPath: string,
  installationId: string,
  options: ProductionInstallationInitializerOptions = {},
): InstallationInitializer {
  const runtimePaths = deriveProductionRuntimePaths(configPath, installationId);
  const config = new FileConfigStore(configPath, installationId);
  const state = new FileStateStore(runtimePaths.statePath, installationId);
  const credentials = new MacOSKeychainCredentialStore(installationId, options.processRunner ?? processRunner());
  return new InstallationInitializer({
    canonicalizeVault: async (vaultRoot, requestedInstallationId) => canonicalVaultRoot(vaultRoot, requestedInstallationId, {
      mode: "bootstrap",
    }),
    config: {
      load: async () => await fileMissing(configPath) ? null : config.load(),
      save: async (value) => config.save(value),
    },
    state: {
      ensureInitial: async (requestedInstallationId) => {
        if (requestedInstallationId !== installationId) throw new Error("Runtime setup unavailable");
        if (await fileMissing(runtimePaths.statePath)) {
          await state.save(initialInstallationState(installationId));
          return;
        }
        await state.load();
      },
      load: async () => await state.load(),
    },
    credentials,
    provisionNotion: options.provisionNotion ?? createNotionWorkspaceProvisioner(),
    validateCortexRoot: options.validateCortexRoot ?? productionCortexRootValidator(state),
  });
}

/** Production command composition; the setup-only dependencies remain inert until the setup subcommand is invoked. */
export function createProductionCliDependencies(input: ProductionCliDependenciesInput): CliDependencies {
  return Object.freeze({
    stdout: input.stdout,
    stderr: input.stderr,
    createWorker: createProductionWorker,
    readSetupInstallationId: readInstallationIdFromVault,
    readSetupToken: async () => readSetupToken(input.setupTokenSource),
    createInstallationInitializer: async (installationId: string) => {
      const runtimePaths = deriveRuntimePaths(input.homeDirectory, installationId);
      return createProductionInstallationInitializer(runtimePaths.configPath, installationId, {
        ...(input.processRunner === undefined ? {} : { processRunner: input.processRunner }),
        ...(input.provisionNotion === undefined ? {} : { provisionNotion: input.provisionNotion }),
      });
    },
    createCortexInstallationInitializer: async (installationId: string) => {
      const runtimePaths = deriveRuntimePaths(input.homeDirectory, installationId);
      return createProductionInstallationInitializer(runtimePaths.configPath, installationId, {
        ...(input.processRunner === undefined ? {} : { processRunner: input.processRunner }),
        ...(input.provisionNotion === undefined ? {} : { provisionNotion: input.provisionNotion }),
      });
    },
  });
}

function runtimeLock(lockPath: string): WorkerLock {
  return {
    runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => withInstallationLock(lockPath, {
      processId: process.pid,
      now: () => new Date(),
      staleAfterMs: 10 * 60 * 1_000,
      randomUUID,
      isProcessAlive: async (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (caught) {
          return (caught as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
        }
      },
    }, operation),
  };
}

/** Production decoder composition shared with the real Notion client boundary. */
export function createProductionNotionObservationDecoder(
  state: Parameters<typeof persistedLinkMapping>[0],
): NotionObservationDecoder {
  return {
    decode: async (record: Readonly<RawNotionPageRecord>) => {
      const mapped = fromNotionMarkdown(record.sourceMarkdown, persistedLinkMapping(state), record.managed.tags);
      const unsupported = [...new Set([
        ...mapped.unsupportedKinds,
        ...(record.unknownBlockIds.length === 0 ? [] : ["unknown-notion-block"]),
      ])].sort();
      return {
        kind: "present" as const,
        pageId: record.pageId,
        bridgeId: record.bridgeId,
        editedAt: record.editedAt,
        pageUrl: record.pageUrl,
        sourceMarkdown: record.sourceMarkdown,
        complete: !record.truncated && record.unknownBlockIds.length === 0,
        unsupportedKinds: unsupported,
        semantic: mapped.semantic,
        semanticHash: await semanticHash(mapped.semantic),
        managed: {
          title: record.managed.title,
          obsidianPath: record.managed.obsidianPath,
          status: record.managed.status,
        },
      };
    },
  };
}

/** Composes real local adapters only after argument validation; it never makes a request during construction. */
export async function createProductionWorker(configPath: string): Promise<BridgeWorker> {
  const bootstrap = await readStrictJson(configPath, parseBridgeConfig);
  const runtimePaths = deriveProductionRuntimePaths(configPath, bootstrap.installationId);
  const logger = new SafeFileLogger(runtimePaths.logPath);
  const credentials = new MacOSKeychainCredentialStore(bootstrap.installationId, processRunner());
  return new GrandboxBridgeWorker({
    config: new FileConfigStore(configPath, bootstrap.installationId),
    state: new FileStateStore(runtimePaths.statePath, bootstrap.installationId),
    journal: new FileJournalStore(runtimePaths.journalDir, bootstrap.installationId),
    credentials,
    lock: runtimeLock(runtimePaths.lockPath),
    clock: { now: () => new Date(), sleep: async (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)) },
    uuid: { randomUUID },
    logger,
    canonicalizeVault: async (config) => canonicalVaultRoot(config.vaultRoot, config.installationId, {
      mode: "verify",
      expectedFingerprint: config.vaultFingerprint,
    }),
    createNotionApi: async (token, context) => new NotionClient(
      token,
      new FetchNotionTransport(),
      createProductionNotionObservationDecoder(context.state),
      { clock: { now: () => new Date(), sleep: async (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)) } },
    ),
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runCli(argv, createProductionCliDependencies({
    stdout: process.stdout,
    stderr: process.stderr,
    homeDirectory: process.env.HOME ?? "",
    setupTokenSource: process.stdin,
  }));
}

if (process.argv[1]?.endsWith("bridge-worker.cjs")) {
  void main().then((code) => { process.exitCode = code; });
}
