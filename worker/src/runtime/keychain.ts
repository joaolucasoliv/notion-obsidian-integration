import type { CredentialSlot, CredentialStore } from "@grandbox-bridge/shared";
import { assertValidInstallationId } from "./paths.js";

const SECURITY_EXECUTABLE = "/usr/bin/security";
const MAX_RUNNER_BYTES = 8_192;
const VALID_SLOTS = new Set<CredentialSlot>(["notion-token", "relay-token", "graph-key"]);

export interface ProcessRunnerInput {
  readonly executable: string;
  readonly args: string[];
  readonly stdin?: string;
  readonly maxBytes: number;
}

export interface ProcessRunnerResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(input: ProcessRunnerInput): Promise<ProcessRunnerResult>;
}

function keychainError(): Error {
  return new Error("Keychain operation failed");
}

function assertCredentialSlot(slot: string): asserts slot is CredentialSlot {
  if (!VALID_SLOTS.has(slot as CredentialSlot)) {
    throw new Error("Invalid credential slot");
  }
}

function serviceName(slot: CredentialSlot): string {
  return `GrandboxBridge/${slot}`;
}

export class MacOSKeychainCredentialStore implements CredentialStore {
  private readonly account: string;
  private readonly runner: ProcessRunner;

  constructor(account: string, runner: ProcessRunner) {
    assertValidInstallationId(account);
    this.account = account;
    this.runner = runner;
  }

  async get(slot: CredentialSlot): Promise<string | null> {
    assertCredentialSlot(slot);
    const result = await this.run({
      executable: SECURITY_EXECUTABLE,
      args: ["find-generic-password", "-a", this.account, "-s", serviceName(slot), "-w"],
      maxBytes: MAX_RUNNER_BYTES,
    });
    if (result.code === 44) {
      return null;
    }
    if (result.code !== 0) {
      throw keychainError();
    }

    const withoutTerminalNewline = result.stdout.endsWith("\r\n")
      ? result.stdout.slice(0, -2)
      : result.stdout.endsWith("\n")
        ? result.stdout.slice(0, -1)
        : result.stdout;
    if (/\r|\n|\0/.test(withoutTerminalNewline)) {
      throw keychainError();
    }
    return withoutTerminalNewline;
  }

  async set(slot: CredentialSlot, value: string): Promise<void> {
    assertCredentialSlot(slot);
    if (/\r|\n|\0/.test(value) || Buffer.byteLength(value, "utf8") > MAX_RUNNER_BYTES - 1) {
      throw keychainError();
    }
    const result = await this.run({
      executable: SECURITY_EXECUTABLE,
      args: ["add-generic-password", "-U", "-a", this.account, "-s", serviceName(slot), "-w"],
      stdin: `${value}\n`,
      maxBytes: MAX_RUNNER_BYTES,
    });
    if (result.code !== 0) {
      throw keychainError();
    }
  }

  async delete(slot: CredentialSlot): Promise<void> {
    assertCredentialSlot(slot);
    const result = await this.run({
      executable: SECURITY_EXECUTABLE,
      args: ["delete-generic-password", "-a", this.account, "-s", serviceName(slot)],
      maxBytes: MAX_RUNNER_BYTES,
    });
    if (result.code !== 0 && result.code !== 44) {
      throw keychainError();
    }
  }

  private async run(input: ProcessRunnerInput): Promise<ProcessRunnerResult> {
    try {
      const result = await this.runner.run(input);
      if (
        !Number.isInteger(result.code) ||
        Buffer.byteLength(result.stdout, "utf8") > input.maxBytes ||
        Buffer.byteLength(result.stderr, "utf8") > input.maxBytes
      ) {
        throw keychainError();
      }
      return result;
    } catch {
      throw keychainError();
    }
  }
}
