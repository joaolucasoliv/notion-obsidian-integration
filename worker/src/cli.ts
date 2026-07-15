import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
  parseBridgeConfig,
  parseBridgeRunSummary,
  type BridgeRunSummary,
} from "@grandbox-bridge/shared";
import { FileConfigStore } from "./persistence/config-store.js";
import { FileJournalStore } from "./persistence/journal-store.js";
import { FileStateStore } from "./persistence/state-store.js";
import { readStrictJson } from "./runtime/atomic-json.js";
import { MacOSKeychainCredentialStore, type ProcessRunner } from "./runtime/keychain.js";
import { withInstallationLock } from "./runtime/lock.js";
import { redactSensitiveOutput, SafeFileLogger } from "./runtime/safe-log.js";
import { fromNotionMarkdown } from "./markdown/notion-mapping.js";
import { semanticHash } from "./markdown/normalize.js";
import { FetchNotionTransport } from "./notion/transport.js";
import { NotionClient, type NotionObservationDecoder, type RawNotionPageRecord } from "./notion/client.js";
import { persistedLinkMapping } from "./sync/reconcile.js";
import { canonicalVaultRoot } from "./vault/safety.js";
import { GrandboxBridgeWorker, type BridgeWorker, type WorkerLock } from "./worker.js";

const MAX_SUMMARY_BYTES = 8 * 1_024;
const CLI_FAILURE_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export type ParsedCliArguments =
  | { readonly kind: "help" }
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

export function parseCliArguments(argv: readonly string[]): ParsedCliArguments {
  if (argv.length === 1 && argv[0] === "--help") return Object.freeze({ kind: "help" as const });
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

function decoderFor(state: Parameters<typeof persistedLinkMapping>[0]): NotionObservationDecoder {
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
        complete: !record.truncated,
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
  const runtimeRoot = dirname(configPath);
  const statePath = join(runtimeRoot, "state.json");
  const lockPath = join(runtimeRoot, "sync.lock");
  const journalDir = join(runtimeRoot, "journal");
  const logger = new SafeFileLogger(join(runtimeRoot, "bridge.log"));
  const credentials = new MacOSKeychainCredentialStore(bootstrap.installationId, processRunner());
  return new GrandboxBridgeWorker({
    config: new FileConfigStore(configPath, bootstrap.installationId),
    state: new FileStateStore(statePath, bootstrap.installationId),
    journal: new FileJournalStore(journalDir, bootstrap.installationId),
    credentials,
    lock: runtimeLock(lockPath),
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
      decoderFor(context.state),
      { clock: { now: () => new Date(), sleep: async (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)) } },
    ),
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runCli(argv, { stdout: process.stdout, stderr: process.stderr, createWorker: createProductionWorker });
}

if (process.argv[1]?.endsWith("bridge-worker.cjs")) {
  void main().then((code) => { process.exitCode = code; });
}
