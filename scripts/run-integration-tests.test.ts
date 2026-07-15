import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IntegrationRunnerError, runIntegrationTests, type IntegrationProcessAdapter } from "./run-integration-tests.mjs";

type Call = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: { readonly cwd: string; readonly shell: false; readonly maxOutputBytes: number; readonly env?: Readonly<Record<string, string>> };
};

type StartedCall = Call & {
  readonly stop: () => Promise<void>;
};

class RecordingProcessAdapter implements IntegrationProcessAdapter {
  readonly calls: Call[] = [];
  readonly startedCalls: StartedCall[] = [];
  readonly signalHandlers = new Map<string, () => void>();
  readonly root = "/repo";
  readonly secrets = ["local-anon-secret", "local-service-secret", "local-jwt-secret"];
  statusCode = 1;
  partialStatus = false;
  stoppedServices: string[] = [];
  healthFailureService: string | null = null;
  startFailsUntilStopped = false;
  private stoppedBeforeStart = false;
  failStart = false;
  failFunctionStart = false;
  failReset = false;
  failVitest = false;
  functionStopCount = 0;
  runtimeEnvironmentRemovals = 0;
  runtimeEnvironmentValues: Readonly<Record<string, string>> | null = null;
  invokeSignalDuringVitest: string | null = null;
  pauseOperation: "start" | "reset" | null = null;
  outputCapWhilePaused = false;
  private resolvePauseReached!: () => void;
  readonly pauseReached = new Promise<void>((resolve) => { this.resolvePauseReached = resolve; });
  private pausedResult: { readonly resolve: (result: { readonly code: number; readonly stdout: string; readonly stderr: string }) => void; readonly reject: (error: Error) => void } | null = null;
  private resolveActiveChild!: () => void;
  private activeChild = Promise.resolve();

  waitForActiveChild(): Promise<void> {
    return this.activeChild;
  }

  releasePaused(): void {
    const paused = this.pausedResult;
    if (!paused) throw new Error("No paused process");
    this.resolveActiveChild();
    paused.resolve({ code: 0, stdout: "", stderr: "" });
    this.pausedResult = null;
  }

  settleActiveChild(): void {
    this.resolveActiveChild();
  }

  async run(executable: string, args: readonly string[], options: Call["options"]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
    this.calls.push({ executable, args, options });
    if (args.includes("status")) {
      return {
        code: this.statusCode,
        stdout: this.statusCode === 0
          ? this.partialStatus
            ? "API_URL=http://127.0.0.1:54321\n"
            : "API_URL=http://127.0.0.1:54321\nANON_KEY=local-anon-secret\nSERVICE_ROLE_KEY=local-service-secret\nJWT_SECRET=local-jwt-secret\n"
          : "",
        stderr: this.statusCode === 0
          ? [
            this.stoppedServices.length === 0 ? "" : `Stopped services: [${this.stoppedServices.join(" ")}]`,
            this.healthFailureService === null ? "" : `failed to inspect container health: No such container: ${this.healthFailureService}`,
          ].filter(Boolean).join("\n")
          : "not running",
      };
    }
    const operation = args.includes("start") ? "start" : args.includes("db") && args.includes("reset") ? "reset" : null;
    if (operation !== null && operation === this.pauseOperation) {
      if (operation === "start" && !this.failStart) {
        this.statusCode = 0;
      }
      this.activeChild = new Promise<void>((resolve) => { this.resolveActiveChild = resolve; });
      this.resolvePauseReached();
      if (this.outputCapWhilePaused) {
        return Promise.reject(new IntegrationRunnerError("Local subprocess output exceeded the safety limit"));
      }
      return new Promise((resolve, reject) => {
        this.pausedResult = { resolve, reject };
      });
    }
    if (args.includes("start")) {
      if (this.startFailsUntilStopped && !this.stoppedBeforeStart) {
        return { code: 1, stdout: "", stderr: "partial stack must be stopped first" };
      }
      if (!this.failStart) {
        this.statusCode = 0;
        this.partialStatus = false;
        this.stoppedServices = [];
        this.healthFailureService = null;
      }
      return { code: this.failStart ? 1 : 0, stdout: "", stderr: this.failStart ? "start failed" : "" };
    }
    if (args.includes("stop")) {
      this.stoppedBeforeStart = true;
      this.statusCode = 0;
      this.stoppedServices = [
        "supabase_auth_relay",
        "supabase_db_relay",
        "supabase_edge_runtime_relay",
        "supabase_kong_relay",
        "supabase_rest_relay",
      ];
      this.healthFailureService = "supabase_db_relay";
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args.includes("db") && args.includes("reset")) {
      return { code: this.failReset ? 1 : 0, stdout: "", stderr: this.failReset ? "reset failed" : "" };
    }
    if (args.includes("vitest.integration.config.ts")) {
      if (this.invokeSignalDuringVitest) {
        this.signalHandlers.get(this.invokeSignalDuringVitest)?.();
      }
      return { code: this.failVitest ? 1 : 0, stdout: "", stderr: this.failVitest ? "test failed" : "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  async start(executable: string, args: readonly string[], options: Call["options"]): Promise<{ readonly stop: () => Promise<void> }> {
    if (this.failFunctionStart) {
      throw new IntegrationRunnerError("Local Edge Functions process could not start");
    }
    const call: StartedCall = {
      executable,
      args,
      options,
      stop: async () => { this.functionStopCount += 1; },
    };
    this.startedCalls.push(call);
    return { stop: call.stop };
  }

  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void {
    this.signalHandlers.set(signal, handler);
    return () => this.signalHandlers.delete(signal);
  }
}

function supabaseCalls(adapter: RecordingProcessAdapter): Call[] {
  return adapter.calls.filter((call) => call.executable.endsWith("/supabase"));
}

function runnerOptions(adapter: RecordingProcessAdapter) {
  return {
    cwd: adapter.root,
    localBinaries: {
      supabase: "/repo/node_modules/.bin/supabase",
      supabaseNative: "/repo/node_modules/@supabase/cli-darwin-arm64/bin/supabase",
      tsc: "/repo/node_modules/.bin/tsc",
      vitest: "/repo/node_modules/.bin/vitest",
    },
    configToml: "[api]\nenabled = true\n",
    filesystem: {
      readDirectory: async () => ["cli-latest"],
      readText: async () => "[api]\nenabled = true\n",
    },
    adapter,
    createRuntimeEnvironment: async (values: Readonly<Record<string, string>>) => {
      adapter.runtimeEnvironmentValues = values;
      return {
      path: "/tmp/grandbox-bridge-edge-functions.env",
      remove: async () => { adapter.runtimeEnvironmentRemovals += 1; },
      };
    },
    waitForFunctionRoutes: async () => undefined,
  };
}

describe("local relay integration runner", () => {
  it("does not stage ignored build artifacts before serving Edge Functions", async () => {
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const runner = await readFile(resolve(root, "scripts/run-integration-tests.mjs"), "utf8");

    expect(runner).not.toContain("stageEdgeFunctions");
    expect(runner).not.toContain("_generated");
  });

  it("keeps each Edge entrypoint wired to committed TypeScript source", async () => {
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const [bridgeApi, notionWebhook, bridgeConfig, webhookConfig] = await Promise.all([
      readFile(resolve(root, "relay/supabase/functions/bridge-api/index.ts"), "utf8"),
      readFile(resolve(root, "relay/supabase/functions/notion-webhook/index.ts"), "utf8"),
      readFile(resolve(root, "relay/supabase/functions/bridge-api/deno.json"), "utf8"),
      readFile(resolve(root, "relay/supabase/functions/notion-webhook/deno.json"), "utf8"),
    ]);

    for (const entrypoint of [bridgeApi, notionWebhook]) {
      expect(entrypoint).not.toContain("_generated");
      expect(entrypoint).toContain("../../../src/");
    }
    for (const configuration of [bridgeConfig, webhookConfig]) {
      expect(configuration).toContain("../../../../shared/src/index.ts");
      expect(configuration).not.toContain("_generated");
    }
  });

  it("uses only local argv commands, resets the local database, and stops a stack it started", async () => {
    const adapter = new RecordingProcessAdapter();
    await runIntegrationTests(["tests/integration/relay-local.test.ts"], runnerOptions(adapter));

    expect(adapter.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ executable: "/repo/node_modules/.bin/supabase", args: ["--workdir", "relay", "status", "--output", "env"] }),
      expect.objectContaining({ executable: "/repo/node_modules/.bin/supabase", args: ["--workdir", "relay", "start", "--ignore-health-check", "--exclude", "vector,logflare"] }),
      expect.objectContaining({ executable: "/repo/node_modules/.bin/tsc", args: ["-b", "shared", "relay"] }),
      expect.objectContaining({ executable: "/repo/node_modules/.bin/supabase", args: ["--workdir", "relay", "db", "reset", "--local"] }),
      expect.objectContaining({ executable: "/repo/node_modules/.bin/vitest", args: ["run", "--config", "vitest.integration.config.ts", "tests/integration/relay-local.test.ts"] }),
      expect.objectContaining({ executable: "/repo/node_modules/.bin/supabase", args: ["--workdir", "relay", "stop", "--no-backup"] }),
    ]));
    expect(adapter.calls.every((call) => call.options.shell === false)).toBe(true);
    expect(adapter.calls.every((call) => call.options.maxOutputBytes > 0)).toBe(true);
    expect(adapter.calls.some((call) => call.options.env && Object.values(call.options.env).includes("local-anon-secret"))).toBe(true);
    expect(adapter.runtimeEnvironmentValues).toMatchObject({
      RELAY_SERVICE_ROLE_KEY: "local-service-secret",
      RELAY_TOKEN_PEPPER: "edge-local-fixture-pepper",
    });
  });

  it("owns an explicit no-JWT Edge Functions server and stops it after an intended integration failure", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.failVitest = true;

    await expect(runIntegrationTests(["tests/integration/relay-edge-local.test.ts"], runnerOptions(adapter))).rejects.toThrow(/Integration tests failed/i);

    expect(adapter.startedCalls).toEqual([
      expect.objectContaining({
        executable: "/repo/node_modules/@supabase/cli-darwin-arm64/bin/supabase",
        args: ["--workdir", "relay", "functions", "serve", "--no-verify-jwt", "--env-file", expect.any(String)],
      }),
    ]);
    expect(adapter.startedCalls[0]?.options.shell).toBe(false);
    expect(adapter.functionStopCount).toBe(1);
    expect(adapter.runtimeEnvironmentRemovals).toBe(1);
  });

  it("does not stop a pre-existing local stack", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.statusCode = 0;
    await runIntegrationTests([], runnerOptions(adapter));

    expect(supabaseCalls(adapter).some((call) => call.args.includes("start"))).toBe(false);
    expect(supabaseCalls(adapter).some((call) => call.args.includes("stop"))).toBe(false);
  });

  it("starts and owns a stack when status exits successfully before its local test environment is ready", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.statusCode = 0;
    adapter.partialStatus = true;

    await runIntegrationTests([], runnerOptions(adapter));

    expect(supabaseCalls(adapter).some((call) => call.args.includes("start"))).toBe(true);
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(2);
  });

  it("starts and owns a stack when status has a full environment but a required service is stopped", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.statusCode = 0;
    adapter.stoppedServices = ["supabase_edge_runtime_relay"];

    await runIntegrationTests([], runnerOptions(adapter));

    expect(supabaseCalls(adapter).some((call) => call.args.includes("start"))).toBe(true);
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(2);
  });

  it("starts and owns a stack when status reports a missing database container despite a full environment", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.statusCode = 0;
    adapter.healthFailureService = "supabase_db_relay";

    await runIntegrationTests([], runnerOptions(adapter));

    expect(supabaseCalls(adapter).some((call) => call.args.includes("start"))).toBe(true);
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(2);
  });

  it("stops a partially healthy local stack before restarting and owning it", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.statusCode = 0;
    adapter.stoppedServices = ["supabase_edge_runtime_relay"];
    adapter.startFailsUntilStopped = true;

    await runIntegrationTests([], runnerOptions(adapter));

    const calls = supabaseCalls(adapter);
    const firstStop = calls.findIndex((call) => call.args.includes("stop"));
    const start = calls.findIndex((call) => call.args.includes("start"));
    expect(firstStop).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(firstStop);
  });

  it("recovers a status-command failure by stopping before it starts an owned stack", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.startFailsUntilStopped = true;

    await runIntegrationTests([], runnerOptions(adapter));

    const calls = supabaseCalls(adapter);
    const firstStop = calls.findIndex((call) => call.args.includes("stop"));
    const start = calls.findIndex((call) => call.args.includes("start"));
    expect(firstStop).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(firstStop);
  });

  it.each([
    ["test failure", (adapter: RecordingProcessAdapter) => { adapter.failVitest = true; }],
    ["reset failure", (adapter: RecordingProcessAdapter) => { adapter.failReset = true; }],
  ])("stops a stack it started after %s", async (_label, configure) => {
    const adapter = new RecordingProcessAdapter();
    configure(adapter);

    await expect(runIntegrationTests([], runnerOptions(adapter))).rejects.toBeInstanceOf(IntegrationRunnerError);
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(2);
  });

  it("cleans up a local stack after startup itself fails", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.failStart = true;

    await expect(runIntegrationTests([], runnerOptions(adapter))).rejects.toBeInstanceOf(IntegrationRunnerError);
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(2);
  });

  it("adds exactly one cleanup stop after recovery when a signal arrives during tests", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.invokeSignalDuringVitest = "SIGINT";

    await expect(runIntegrationTests([], runnerOptions(adapter))).rejects.toThrow(/SIGINT/i);
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(2);
  });

  it("waits for an active start to settle before signal cleanup", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.pauseOperation = "start";
    const running = runIntegrationTests([], runnerOptions(adapter));

    await adapter.pauseReached;
    adapter.signalHandlers.get("SIGINT")?.();
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(1);

    adapter.releasePaused();
    await expect(running).rejects.toThrow(/SIGINT/i);
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(2);
  });

  it("waits for an output-capped reset to settle before owned cleanup", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.pauseOperation = "reset";
    adapter.outputCapWhilePaused = true;
    const running = runIntegrationTests([], runnerOptions(adapter));

    await adapter.pauseReached;
    await Promise.resolve();
    await Promise.resolve();
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(1);

    adapter.settleActiveChild();
    await expect(running).rejects.toThrow(/output exceeded/i);
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(2);
  });

  it.each(["--linked", "--project-ref", "--remote", "--unknown"]) ("rejects unsafe runner flag %s before spawning", async (flag) => {
    const adapter = new RecordingProcessAdapter();
    await expect(runIntegrationTests([flag], runnerOptions(adapter))).rejects.toThrow(/local|flag|remote/i);
    expect(adapter.calls).toEqual([]);
  });

  it("rejects a configured project reference before spawning", async () => {
    const adapter = new RecordingProcessAdapter();
    await expect(runIntegrationTests([], {
      ...runnerOptions(adapter),
      configToml: "project_id = 'remote-project-ref'\n",
    })).rejects.toThrow(/remote|linked/i);
    expect(adapter.calls).toEqual([]);
  });

  it("rejects repository-local linked temporary state before spawning", async () => {
    const adapter = new RecordingProcessAdapter();
    await expect(runIntegrationTests([], {
      ...runnerOptions(adapter),
      filesystem: {
        readDirectory: async () => ["project-ref"],
        readText: async () => "[api]\nenabled = true\n",
      },
    })).rejects.toThrow(/linked|temporary|remote/i);
    expect(adapter.calls).toEqual([]);
  });
});
