import { spawn } from "node:child_process";
import { parseBridgeRunSummary, SAFE_ERROR_CODES, type BridgeRunSummary, type SafeErrorCode } from "@grandbox-bridge/shared";
import { isCanonicalInstallationId, type ExternalLocator } from "./locator.js";

const MAX_WORKER_SUMMARY_BYTES = 8 * 1_024;

export type BridgeConfiguration = "unconfigured" | "ready" | "attention";
export type BridgeServiceState = "enabled" | "disabled" | "unknown";

export interface BridgeStatus {
  readonly configuration: BridgeConfiguration;
  readonly service: BridgeServiceState;
}

/** Only the enabled flag crosses from the service manager into the plugin UI. */
export interface ServiceStatus {
  readonly enabled: boolean;
}

/** The narrow boundary consumed by the Obsidian plugin. */
export interface WorkerController {
  preview(): Promise<BridgeRunSummary>;
  syncNow(): Promise<BridgeRunSummary>;
  installService(): Promise<ServiceStatus>;
  disableService(): Promise<ServiceStatus>;
  status(): Promise<BridgeStatus>;
}

export interface NotionConnectionInput {
  readonly parentPageId: string;
  readonly token: string;
}

export interface NotionConnectionResult {
  readonly configuration: "unconfigured" | "ready";
  readonly created: boolean;
  readonly error?: SafeErrorCode;
}

/** Optional extension used only by the explicit settings onboarding control. */
export interface SetupWorkerController extends WorkerController {
  connectNotion(input: NotionConnectionInput): Promise<NotionConnectionResult>;
}

/** An optional extension used only for a debounced vault event reason. */
export interface EventWorkerController extends WorkerController {
  syncFromVaultEvent(): Promise<BridgeRunSummary>;
}

export interface WorkerCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly shell: false;
  readonly stdin?: string;
}

export interface WorkerProcessResult {
  readonly code: number;
  readonly stdout: string;
}

export interface WorkerProcessRunner {
  run(command: WorkerCommand): Promise<WorkerProcessResult>;
}

export interface ServiceManager {
  install(locator: ExternalLocator): Promise<ServiceStatus>;
  disable(locator: ExternalLocator): Promise<ServiceStatus>;
  status(locator: ExternalLocator): Promise<BridgeStatus>;
}

function controllerError(): Error {
  return new Error("Bridge controller unavailable");
}

function validWorkerResult(value: unknown): value is WorkerProcessResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as WorkerProcessResult).code) &&
    typeof (value as WorkerProcessResult).stdout === "string"
  );
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
    !value.endsWith("/")
  );
}

function validExternalLocator(value: unknown): value is ExternalLocator {
  if (typeof value !== "object" || value === null) return false;
  const locator = value as ExternalLocator;
  if (
      !isCanonicalInstallationId(locator.installationId) ||
      !isAbsoluteNormalizedPath(locator.homeDirectory) ||
      !isAbsoluteNormalizedPath(locator.vaultRoot) ||
    !isAbsoluteNormalizedPath(locator.runtimeRoot) ||
    !isAbsoluteNormalizedPath(locator.configPath) ||
    !isAbsoluteNormalizedPath(locator.nodeExecutable) ||
    !isAbsoluteNormalizedPath(locator.workerPath)
  ) {
    return false;
  }
  return (
    locator.runtimeRoot === `${locator.homeDirectory}/Library/Application Support/Grandbox Bridge/${locator.installationId}` &&
    locator.runtimeRoot.endsWith(`/Library/Application Support/Grandbox Bridge/${locator.installationId}`) &&
    locator.configPath === `${locator.runtimeRoot}/config.json`
  );
}

function parseWorkerSummary(stdout: string): BridgeRunSummary {
  if (Buffer.byteLength(stdout, "utf8") > MAX_WORKER_SUMMARY_BYTES) throw controllerError();
  const line = stdout.trim();
  if (line.length === 0 || line.includes("\n")) throw controllerError();
  try {
    return parseBridgeRunSummary(JSON.parse(line));
  } catch {
    throw controllerError();
  }
}

function validServiceStatus(value: unknown): value is ServiceStatus {
  return typeof value === "object" && value !== null && typeof (value as ServiceStatus).enabled === "boolean";
}

function validBridgeStatus(value: unknown): value is BridgeStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as BridgeStatus;
  return (
    (status.configuration === "unconfigured" || status.configuration === "ready" || status.configuration === "attention") &&
    (status.service === "enabled" || status.service === "disabled" || status.service === "unknown")
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function validConnectionInput(value: unknown): value is NotionConnectionInput {
  return (
    typeof value === "object" &&
    value !== null &&
    UUID_PATTERN.test((value as NotionConnectionInput).parentPageId) &&
    typeof (value as NotionConnectionInput).token === "string" &&
    (value as NotionConnectionInput).token.length > 0 &&
    Buffer.byteLength((value as NotionConnectionInput).token, "utf8") <= 8_192 &&
    !/[\r\n\0]/u.test((value as NotionConnectionInput).token)
  );
}

function isSafeErrorCode(value: unknown): value is SafeErrorCode {
  return typeof value === "string" && (SAFE_ERROR_CODES as readonly string[]).includes(value);
}

function parseConnectionResult(stdout: string): NotionConnectionResult {
  if (Buffer.byteLength(stdout, "utf8") > MAX_WORKER_SUMMARY_BYTES) throw controllerError();
  const line = stdout.trim();
  if (line.length === 0 || line.includes("\n")) throw controllerError();
  try {
    const value = JSON.parse(line) as unknown;
    if (typeof value !== "object" || value === null) throw controllerError();
    const result = value as Record<string, unknown>;
    if (
      Object.keys(result).length === 2 &&
      (result.configuration === "unconfigured" || result.configuration === "ready") &&
      typeof result.created === "boolean"
    ) {
      return Object.freeze({
        configuration: result.configuration,
        created: result.created,
      });
    }
    if (
      Object.keys(result).length === 3 &&
      result.configuration === "unconfigured" &&
      result.created === false &&
      isSafeErrorCode(result.error)
    ) {
      return Object.freeze({ configuration: "unconfigured", created: false, error: result.error });
    }
    throw controllerError();
  } catch {
    throw controllerError();
  }
}

function workerArguments(
  locator: ExternalLocator,
  mode: "preview" | "apply",
  reason: "manual" | "obsidian-event",
): readonly string[] {
  const args = [locator.workerPath, "--config", locator.configPath];
  if (mode === "preview") args.push("--dry-run");
  args.push("--reason", reason, "--json");
  return Object.freeze(args);
}

function setupArguments(locator: ExternalLocator, input: NotionConnectionInput): WorkerCommand {
  if (!validConnectionInput(input)) throw controllerError();
  return Object.freeze({
    executable: locator.nodeExecutable,
    args: Object.freeze([
      locator.workerPath,
      "setup",
      "apply",
      "--vault",
      locator.vaultRoot,
      "--parent-page-id",
      input.parentPageId,
      "--json",
    ]),
    shell: false,
    stdin: `${input.token}\n`,
  });
}

/**
 * Runs the already-installed worker through a fixed argv boundary.  It holds
 * one queue for manual/event/service operations so concurrent UI gestures
 * cannot create overlapping processes.
 */
export class LocalWorkerController implements EventWorkerController, SetupWorkerController {
  private tail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly locator: ExternalLocator,
    private readonly runner: WorkerProcessRunner,
    private readonly services: ServiceManager,
  ) {
    if (!validExternalLocator(locator)) throw controllerError();
  }

  public preview(): Promise<BridgeRunSummary> {
    return this.enqueue(() => this.runWorker("preview", "manual"));
  }

  public syncNow(): Promise<BridgeRunSummary> {
    return this.enqueue(() => this.runWorker("apply", "manual"));
  }

  public syncFromVaultEvent(): Promise<BridgeRunSummary> {
    return this.enqueue(() => this.runWorker("apply", "obsidian-event"));
  }

  public connectNotion(input: NotionConnectionInput): Promise<NotionConnectionResult> {
    return this.enqueue(() => this.runSetup(input));
  }

  public installService(): Promise<ServiceStatus> {
    return this.enqueue(async () => {
      try {
        const status = await this.services.install(this.locator);
        if (!validServiceStatus(status)) throw controllerError();
        return Object.freeze({ enabled: status.enabled });
      } catch {
        throw controllerError();
      }
    });
  }

  public disableService(): Promise<ServiceStatus> {
    return this.enqueue(async () => {
      try {
        const status = await this.services.disable(this.locator);
        if (!validServiceStatus(status)) throw controllerError();
        return Object.freeze({ enabled: status.enabled });
      } catch {
        throw controllerError();
      }
    });
  }

  public status(): Promise<BridgeStatus> {
    return this.enqueue(async () => {
      try {
        const status = await this.services.status(this.locator);
        if (!validBridgeStatus(status)) throw controllerError();
        return Object.freeze({ configuration: status.configuration, service: status.service });
      } catch {
        throw controllerError();
      }
    });
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async runWorker(mode: "preview" | "apply", reason: "manual" | "obsidian-event"): Promise<BridgeRunSummary> {
    try {
      const result = await this.runner.run(Object.freeze({
        executable: this.locator.nodeExecutable,
        args: workerArguments(this.locator, mode, reason),
        shell: false,
      }));
      if (!validWorkerResult(result) || result.code !== 0) throw controllerError();
      return parseWorkerSummary(result.stdout);
    } catch {
      throw controllerError();
    }
  }

  private async runSetup(input: NotionConnectionInput): Promise<NotionConnectionResult> {
    try {
      const result = await this.runner.run(setupArguments(this.locator, input));
      if (!validWorkerResult(result)) throw controllerError();
      const connection = parseConnectionResult(result.stdout);
      if (result.code === 0 && connection.error === undefined) return connection;
      if (result.code === 1 && connection.error !== undefined) return connection;
      throw controllerError();
    } catch {
      throw controllerError();
    }
  }
}

/** Electron/Node adapter used only after a user invokes an explicit command. */
export class NodeWorkerProcessRunner implements WorkerProcessRunner {
  public run(command: WorkerCommand): Promise<WorkerProcessResult> {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command.executable, command.args, {
          shell: command.shell,
        stdio: [command.stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        reject(controllerError());
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_WORKER_SUMMARY_BYTES) {
          child.kill();
          reject(controllerError());
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      child.on("error", () => reject(controllerError()));
      child.on("close", (code) => {
        resolve(Object.freeze({ code: typeof code === "number" ? code : 1, stdout: Buffer.concat(chunks).toString("utf8") }));
      });
      if (command.stdin !== undefined) child.stdin?.end(command.stdin, "utf8");
    });
  }
}

export function supportsEventSync(controller: WorkerController): controller is EventWorkerController {
  return typeof (controller as Partial<EventWorkerController>).syncFromVaultEvent === "function";
}

export function supportsNotionSetup(controller: WorkerController): controller is SetupWorkerController {
  return typeof (controller as Partial<SetupWorkerController>).connectNotion === "function";
}
