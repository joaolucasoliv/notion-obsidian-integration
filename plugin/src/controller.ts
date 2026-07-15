import { spawn } from "node:child_process";
import { parseBridgeRunSummary, type BridgeRunSummary } from "@grandbox-bridge/shared";
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

/** An optional extension used only for a debounced vault event reason. */
export interface EventWorkerController extends WorkerController {
  syncFromVaultEvent(): Promise<BridgeRunSummary>;
}

export interface WorkerCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly shell: false;
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

/**
 * Runs the already-installed worker through a fixed argv boundary.  It holds
 * one queue for manual/event/service operations so concurrent UI gestures
 * cannot create overlapping processes.
 */
export class LocalWorkerController implements EventWorkerController {
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
}

/** Electron/Node adapter used only after a user invokes an explicit command. */
export class NodeWorkerProcessRunner implements WorkerProcessRunner {
  public run(command: WorkerCommand): Promise<WorkerProcessResult> {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command.executable, command.args, {
          shell: command.shell,
          stdio: ["ignore", "pipe", "ignore"],
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
    });
  }
}

export function supportsEventSync(controller: WorkerController): controller is EventWorkerController {
  return typeof (controller as Partial<EventWorkerController>).syncFromVaultEvent === "function";
}
