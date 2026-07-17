import { describe, expect, it } from "vitest";
import type { BridgeRunSummary } from "@grandbox-bridge/shared";
import { LocalWorkerController, type WorkerCommand, type WorkerProcessRunner } from "./controller.js";
import { deriveExternalLocator } from "./locator.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_PAGE_ID = "22222222-2222-4222-8222-222222222222";

function summary(overrides: Partial<BridgeRunSummary> = {}): BridgeRunSummary {
  return {
    mode: "preview",
    outcome: "success",
    planned: 1,
    writes: 0,
    pushed: 0,
    pulled: 0,
    conflicts: 0,
    errors: 0,
    graphUploads: 0,
    startedAt: "2026-07-15T12:00:00.000Z",
    completedAt: "2026-07-15T12:00:01.000Z",
    ...overrides,
  };
}

function locator() {
  return deriveExternalLocator({
    installationId: INSTALLATION_ID,
    homeDirectory: "/Users/synthetic",
    vaultRoot: "/synthetic/vault",
    nodeExecutable: "/usr/local/bin/node",
    workerPath: "/synthetic/vault/.obsidian/plugins/grandbox-bridge/bridge-worker.cjs",
  });
}

describe("LocalWorkerController", () => {
  it("delegates through an absolute argv-only worker command", async () => {
    const commands: WorkerCommand[] = [];
    const runner: WorkerProcessRunner = {
      run: async (command) => {
        commands.push(command);
        return { code: 0, stdout: JSON.stringify(summary()) };
      },
    };
    const controller = new LocalWorkerController(locator(), runner, {
      install: async () => ({ enabled: true }),
      disable: async () => ({ enabled: false }),
      status: async () => ({ configuration: "ready", service: "disabled" }),
    });

    await expect(controller.preview()).resolves.toMatchObject({ mode: "preview", outcome: "success" });
    expect(commands).toEqual([{
      executable: "/usr/local/bin/node",
      args: [
        "/synthetic/vault/.obsidian/plugins/grandbox-bridge/bridge-worker.cjs",
        "--config",
        "/Users/synthetic/Library/Application Support/Grandbox Bridge/11111111-1111-4111-8111-111111111111/config.json",
        "--dry-run",
        "--reason",
        "manual",
        "--json",
      ],
      shell: false,
    }]);
  });

  it("sends a Notion connection token through stdin only to the installed setup worker", async () => {
    const commands: WorkerCommand[] = [];
    const runner: WorkerProcessRunner = {
      run: async (command) => {
        commands.push(command);
        return { code: 0, stdout: '{"configuration":"ready","created":true}\n' };
      },
    };
    const controller = new LocalWorkerController(locator(), runner, {
      install: async () => ({ enabled: true }),
      disable: async () => ({ enabled: false }),
      status: async () => ({ configuration: "ready", service: "disabled" }),
    });

    await expect(controller.connectNotion({
      parentPageId: PARENT_PAGE_ID,
      token: "ntn_stdin_only_token",
    })).resolves.toEqual({ configuration: "ready", created: true });

    expect(commands).toEqual([{
      executable: "/usr/local/bin/node",
      args: [
        "/synthetic/vault/.obsidian/plugins/grandbox-bridge/bridge-worker.cjs",
        "setup",
        "apply",
        "--vault",
        "/synthetic/vault",
        "--parent-page-id",
        PARENT_PAGE_ID,
        "--json",
      ],
      shell: false,
      stdin: "ntn_stdin_only_token\n",
    }]);
  });

  it("configures The Cortex through a token-free fixed argv command", async () => {
    const commands: WorkerCommand[] = [];
    const runner: WorkerProcessRunner = {
      run: async (command) => {
        commands.push(command);
        return { code: 0, stdout: '{"configuration":"ready","created":true}\n' };
      },
    };
    const controller = new LocalWorkerController(locator(), runner, {
      install: async () => ({ enabled: true }),
      disable: async () => ({ enabled: false }),
      status: async () => ({ configuration: "ready", service: "disabled" }),
    });

    await expect(controller.configureCortex({ rootPageId: PARENT_PAGE_ID })).resolves.toEqual({
      configuration: "ready",
      created: true,
    });

    expect(commands).toEqual([{
      executable: "/usr/local/bin/node",
      args: [
        "/synthetic/vault/.obsidian/plugins/grandbox-bridge/bridge-worker.cjs",
        "setup",
        "cortex",
        "apply",
        "--vault",
        "/synthetic/vault",
        "--root-page-id",
        PARENT_PAGE_ID,
        "--json",
      ],
      shell: false,
    }]);
  });

  it("reads The Cortex status through the bounded local command", async () => {
    const commands: WorkerCommand[] = [];
    const runner: WorkerProcessRunner = {
      run: async (command) => {
        commands.push(command);
        return { code: 0, stdout: '{"configuration":"ready","created":false}\n' };
      },
    };
    const controller = new LocalWorkerController(locator(), runner, {
      install: async () => ({ enabled: true }),
      disable: async () => ({ enabled: false }),
      status: async () => ({ configuration: "ready", service: "disabled" }),
    });

    await expect(controller.cortexStatus()).resolves.toEqual({
      configuration: "ready",
      created: false,
    });

    expect(commands).toEqual([{
      executable: "/usr/local/bin/node",
      args: [
        "/synthetic/vault/.obsidian/plugins/grandbox-bridge/bridge-worker.cjs",
        "setup",
        "cortex",
        "status",
        "--vault",
        "/synthetic/vault",
        "--json",
      ],
      shell: false,
    }]);
  });

  it("returns a safe setup failure result from the worker instead of discarding it", async () => {
    const runner: WorkerProcessRunner = {
      run: async () => ({
        code: 1,
        stdout: '{"configuration":"unconfigured","created":false,"error":"not-found"}\n',
      }),
    };
    const controller = new LocalWorkerController(locator(), runner, {
      install: async () => ({ enabled: true }),
      disable: async () => ({ enabled: false }),
      status: async () => ({ configuration: "ready", service: "disabled" }),
    });

    await expect(controller.connectNotion({
      parentPageId: PARENT_PAGE_ID,
      token: "ntn_stdin_only_token",
    })).resolves.toEqual({ configuration: "unconfigured", created: false, error: "not-found" });
  });

  it("rejects a nonzero worker exit even when stdout looks like a summary", async () => {
    const runner: WorkerProcessRunner = {
      run: async () => ({ code: 1, stdout: JSON.stringify(summary()) }),
    };
    const controller = new LocalWorkerController(locator(), runner, {
      install: async () => ({ enabled: true }),
      disable: async () => ({ enabled: false }),
      status: async () => ({ configuration: "ready", service: "disabled" }),
    });

    await expect(controller.preview()).rejects.toThrow(/controller unavailable/i);
  });

  it("serializes concurrent manual worker actions", async () => {
    const commands: WorkerCommand[] = [];
    const resolves: Array<(result: { code: number; stdout: string }) => void> = [];
    const runner: WorkerProcessRunner = {
      run: async (command) => new Promise((resolve) => {
        commands.push(command);
        resolves.push(resolve);
      }),
    };
    const controller = new LocalWorkerController(locator(), runner, {
      install: async () => ({ enabled: true }),
      disable: async () => ({ enabled: false }),
      status: async () => ({ configuration: "ready", service: "disabled" }),
    });

    const preview = controller.preview();
    const sync = controller.syncNow();
    await Promise.resolve();
    expect(commands).toHaveLength(1);
    resolves.shift()?.({ code: 0, stdout: JSON.stringify(summary()) });
    await preview;
    await Promise.resolve();
    expect(commands).toHaveLength(2);
    resolves.shift()?.({ code: 0, stdout: JSON.stringify(summary({ mode: "apply", writes: 1 })) });
    await expect(sync).resolves.toMatchObject({ mode: "apply", writes: 1 });
    expect(commands.map((command) => command.args.at(-2))).toEqual(["manual", "manual"]);
  });

  it("rejects a forged non-absolute locator before it can reach the worker runner", () => {
    const calls: WorkerCommand[] = [];
    const runner: WorkerProcessRunner = {
      run: async (command) => {
        calls.push(command);
        return { code: 0, stdout: JSON.stringify(summary()) };
      },
    };

    expect(() => new LocalWorkerController({ ...locator(), nodeExecutable: "node" }, runner, {
      install: async () => ({ enabled: true }),
      disable: async () => ({ enabled: false }),
      status: async () => ({ configuration: "ready", service: "disabled" }),
    })).toThrow(/controller unavailable/i);
    expect(calls).toEqual([]);
  });
});
