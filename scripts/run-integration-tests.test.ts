import { describe, expect, it } from "vitest";
import { IntegrationRunnerError, runIntegrationTests, type IntegrationProcessAdapter } from "./run-integration-tests.mjs";

type Call = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: { readonly cwd: string; readonly shell: false; readonly maxOutputBytes: number; readonly env?: Readonly<Record<string, string>> };
};

class RecordingProcessAdapter implements IntegrationProcessAdapter {
  readonly calls: Call[] = [];
  readonly signalHandlers = new Map<string, () => void>();
  readonly root = "/repo";
  readonly secrets = ["local-anon-secret", "local-service-secret", "local-jwt-secret"];
  statusCode = 1;
  failStart = false;
  failReset = false;
  failVitest = false;
  invokeSignalDuringVitest: string | null = null;

  async run(executable: string, args: readonly string[], options: Call["options"]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
    this.calls.push({ executable, args, options });
    if (args.includes("status")) {
      return {
        code: this.statusCode,
        stdout: this.statusCode === 0 ? "API_URL=http://127.0.0.1:54321\nANON_KEY=local-anon-secret\nSERVICE_ROLE_KEY=local-service-secret\nJWT_SECRET=local-jwt-secret\n" : "",
        stderr: this.statusCode === 0 ? "" : "not running",
      };
    }
    if (args.includes("start")) {
      if (!this.failStart) {
        this.statusCode = 0;
      }
      return { code: this.failStart ? 1 : 0, stdout: "", stderr: this.failStart ? "start failed" : "" };
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
      vitest: "/repo/node_modules/.bin/vitest",
    },
    configToml: "[api]\nenabled = true\n",
    adapter,
  };
}

describe("local relay integration runner", () => {
  it("uses only local argv commands, resets the local database, and stops a stack it started", async () => {
    const adapter = new RecordingProcessAdapter();
    await runIntegrationTests(["tests/integration/relay-local.test.ts"], runnerOptions(adapter));

    expect(adapter.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ executable: "/repo/node_modules/.bin/supabase", args: ["--workdir", "relay", "status", "--output", "env"] }),
      expect.objectContaining({ executable: "/repo/node_modules/.bin/supabase", args: ["--workdir", "relay", "start"] }),
      expect.objectContaining({ executable: "/repo/node_modules/.bin/supabase", args: ["--workdir", "relay", "db", "reset", "--local"] }),
      expect.objectContaining({ executable: "/repo/node_modules/.bin/vitest", args: ["run", "--config", "vitest.integration.config.ts", "tests/integration/relay-local.test.ts"] }),
      expect.objectContaining({ executable: "/repo/node_modules/.bin/supabase", args: ["--workdir", "relay", "stop", "--no-backup"] }),
    ]));
    expect(adapter.calls.every((call) => call.options.shell === false)).toBe(true);
    expect(adapter.calls.every((call) => call.options.maxOutputBytes > 0)).toBe(true);
    expect(adapter.calls.some((call) => call.options.env && Object.values(call.options.env).includes("local-anon-secret"))).toBe(true);
  });

  it("does not stop a pre-existing local stack", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.statusCode = 0;
    await runIntegrationTests([], runnerOptions(adapter));

    expect(supabaseCalls(adapter).some((call) => call.args.includes("start"))).toBe(false);
    expect(supabaseCalls(adapter).some((call) => call.args.includes("stop"))).toBe(false);
  });

  it.each([
    ["test failure", (adapter: RecordingProcessAdapter) => { adapter.failVitest = true; }],
    ["reset failure", (adapter: RecordingProcessAdapter) => { adapter.failReset = true; }],
  ])("stops a stack it started after %s", async (_label, configure) => {
    const adapter = new RecordingProcessAdapter();
    configure(adapter);

    await expect(runIntegrationTests([], runnerOptions(adapter))).rejects.toBeInstanceOf(IntegrationRunnerError);
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(1);
  });

  it("cleans up a local stack after startup itself fails", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.failStart = true;

    await expect(runIntegrationTests([], runnerOptions(adapter))).rejects.toBeInstanceOf(IntegrationRunnerError);
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(1);
  });

  it("cleans up exactly once when a signal arrives during tests", async () => {
    const adapter = new RecordingProcessAdapter();
    adapter.invokeSignalDuringVitest = "SIGINT";

    await expect(runIntegrationTests([], runnerOptions(adapter))).rejects.toThrow(/SIGINT/i);
    expect(supabaseCalls(adapter).filter((call) => call.args.includes("stop"))).toHaveLength(1);
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
});
