import { spawn } from "node:child_process";
import {
  disableService,
  installService,
  readServiceStatus,
  type ServiceCommand,
  type ServiceCommandResult,
  type ServiceCommandRunner,
} from "@grandbox-bridge/worker/runtime/service";
import type { BridgeStatus, ServiceManager, ServiceStatus } from "./controller.js";
import { deriveExternalLocator, type ExternalLocator } from "./locator.js";

const LAUNCHCTL_PATH = "/bin/launchctl";

export interface ServiceProcessCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly shell: false;
}

export interface ServiceProcessRunner {
  run(command: ServiceProcessCommand): Promise<ServiceCommandResult>;
}

function serviceManagerError(): Error {
  return new Error("Bridge service unavailable");
}

function validServiceResult(value: unknown): value is ServiceCommandResult {
  return typeof value === "object" && value !== null && Number.isSafeInteger((value as ServiceCommandResult).code);
}

function validServiceCommand(command: ServiceCommand): boolean {
  if (
    command.executable !== LAUNCHCTL_PATH ||
    !Array.isArray(command.args) ||
    !command.args.every((argument) => typeof argument === "string" && argument.length > 0 && !argument.includes("\0"))
  ) {
    return false;
  }
  const action = command.args[0];
  return (
    (action === "print" && command.args.length === 2) ||
    ((action === "bootstrap" || action === "bootout") && command.args.length === 3)
  );
}

function validUserId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkedLocator(locator: ExternalLocator): ExternalLocator {
  try {
    const expected = deriveExternalLocator({
      installationId: locator.installationId,
      homeDirectory: locator.homeDirectory,
      vaultRoot: locator.vaultRoot,
      nodeExecutable: locator.nodeExecutable,
      workerPath: locator.workerPath,
    });
    if (
      locator.runtimeRoot !== expected.runtimeRoot ||
      locator.configPath !== expected.configPath ||
      locator.vaultRoot !== expected.vaultRoot ||
      locator.installationId !== expected.installationId
    ) {
      throw serviceManagerError();
    }
    return expected;
  } catch {
    throw serviceManagerError();
  }
}

function spawnServiceProcess(command: ServiceProcessCommand): Promise<ServiceCommandResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command.executable, command.args, {
        shell: command.shell,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      reject(serviceManagerError());
      return;
    }
    child.on("error", () => reject(serviceManagerError()));
    child.on("close", (code) => resolve(Object.freeze({ code: typeof code === "number" ? code : 1 })));
  });
}

/** Adapts the hardened worker service boundary to Electron's shell-free process API. */
export class NodeServiceCommandRunner implements ServiceCommandRunner {
  public constructor(
    private readonly processRunner: ServiceProcessRunner = Object.freeze({ run: spawnServiceProcess }),
  ) {}

  public async run(command: ServiceCommand): Promise<ServiceCommandResult> {
    if (!validServiceCommand(command)) throw serviceManagerError();
    try {
      const result = await this.processRunner.run(Object.freeze({
        executable: command.executable,
        args: Object.freeze([...command.args]),
        shell: false,
      }));
      if (!validServiceResult(result)) throw serviceManagerError();
      return Object.freeze({ code: result.code });
    } catch {
      throw serviceManagerError();
    }
  }
}

/**
 * The only plugin adapter for visible service controls. It composes the worker's
 * path-validated LaunchAgent routines and maps their output to the bounded UI
 * status vocabulary without exposing locator or command details.
 */
export class RuntimeServiceManager implements ServiceManager {
  public constructor(
    private readonly userId: () => number,
    private readonly runner: ServiceCommandRunner,
  ) {
    if (typeof userId !== "function" || typeof runner !== "object" || runner === null || typeof runner.run !== "function") {
      throw serviceManagerError();
    }
  }

  public async install(locator: ExternalLocator): Promise<ServiceStatus> {
    const safe = checkedLocator(locator);
    const status = await installService({
      ...this.location(safe),
      nodePath: safe.nodeExecutable,
      workerPath: safe.workerPath,
      configPath: safe.configPath,
    });
    return Object.freeze({ enabled: status.enabled });
  }

  public async disable(locator: ExternalLocator): Promise<ServiceStatus> {
    const status = await disableService(this.location(checkedLocator(locator)));
    return Object.freeze({ enabled: status.enabled });
  }

  public async status(locator: ExternalLocator): Promise<BridgeStatus> {
    try {
      const safe = checkedLocator(locator);
      const status = await readServiceStatus({
        ...this.location(safe),
        nodePath: safe.nodeExecutable,
        workerPath: safe.workerPath,
        configPath: safe.configPath,
      });
      if (!status.configured) return Object.freeze({ configuration: "unconfigured", service: "unknown" });
      return Object.freeze({ configuration: "ready", service: status.enabled ? "enabled" : "disabled" });
    } catch {
      return Object.freeze({ configuration: "attention", service: "unknown" });
    }
  }

  private location(locator: ExternalLocator): Readonly<{
    homeDirectory: string;
    installationId: string;
    uid: number;
    runner: ServiceCommandRunner;
  }> {
    const uid = this.userId();
    if (!validUserId(uid)) throw serviceManagerError();
    return Object.freeze({
      homeDirectory: locator.homeDirectory,
      installationId: locator.installationId,
      uid,
      runner: this.runner,
    });
  }
}
