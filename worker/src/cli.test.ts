import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotionClient } from "./notion/client.js";
import type { NotionTransport, NotionTransportResponse } from "./notion/transport.js";
import {
  createProductionNotionObservationDecoder,
  createProductionInstallationInitializer,
  createProductionCliDependencies,
  deriveProductionRuntimePaths,
  parseCliArguments,
  readSetupToken,
  runCli,
} from "./cli.js";

const CONFIG = "/private/tmp/grandbox/config.json";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const PARENT_PAGE_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_BLOCK_ID = "44444444-4444-4444-8444-444444444444";
const REDACTION_CANARY = readFileSync(
  new URL("../../tests/fixtures/safe/credential-canary.txt", import.meta.url),
  "utf8",
).trim();

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../tests/fixtures/notion/${name}`, import.meta.url), "utf8")) as T;
}

function response<T>(data: T): NotionTransportResponse<T> {
  return { status: 200, headers: {}, data };
}

class LocalNotionTransport implements NotionTransport {
  public readonly requests: Parameters<NotionTransport["request"]>[0][] = [];

  public constructor(private readonly responses: NotionTransportResponse<unknown>[]) {}

  public async request<T>(input: Parameters<NotionTransport["request"]>[0]): Promise<NotionTransportResponse<T>> {
    this.requests.push(structuredClone(input));
    const next = this.responses.shift();
    if (next === undefined) throw new Error("unexpected local Notion request");
    return next as NotionTransportResponse<T>;
  }
}

describe("worker CLI", () => {
  it("derives the production logger path from the external runtime root", () => {
    const paths = deriveProductionRuntimePaths(
      "/Users/jo/Library/Application Support/Grandbox Bridge/11111111-1111-4111-8111-111111111111/config.json",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(paths.logPath).toBe("/Users/jo/Library/Logs/GrandboxBridge/bridge.log");
    expect(paths.statePath).toBe(
      "/Users/jo/Library/Application Support/Grandbox Bridge/11111111-1111-4111-8111-111111111111/state.json",
    );
  });

  it("keeps a valid unknown Notion block incomplete through the production decoder without a network request", async () => {
    const markdown = fixture<Record<string, unknown>>("page-markdown.json");
    markdown.truncated = false;
    markdown.unknown_block_ids = [UNKNOWN_BLOCK_ID];
    const transport = new LocalNotionTransport([
      response(fixture<Record<string, unknown>>("page.json")),
      response(markdown),
    ]);
    const client = new NotionClient(
      "local-test-token",
      transport,
      createProductionNotionObservationDecoder({ pairs: {} }),
    );

    const observation = await client.retrievePage(PAGE_ID);

    expect(observation.kind).toBe("present");
    if (observation.kind !== "present") throw new Error("expected a present observation");
    expect(observation.complete).toBe(false);
    expect(observation.unsupportedKinds).toContain("unknown-notion-block");
    expect(transport.requests.map((request) => request.path)).toEqual([
      `/v1/pages/${PAGE_ID}`,
      `/v1/pages/${PAGE_ID}/markdown`,
    ]);
  });

  it("accepts only the exact JSON apply invocation", () => {
    expect(parseCliArguments(["--config", CONFIG, "--reason", "manual", "--json"])).toEqual({
      kind: "run",
      configPath: CONFIG,
      mode: "apply",
      reason: "manual",
    });
  });

  it("accepts a setup apply invocation without a credential on argv", () => {
    expect(parseCliArguments([
      "setup",
      "apply",
      "--vault",
      "/private/tmp/grandbox-vault",
      "--parent-page-id",
      PARENT_PAGE_ID,
      "--json",
    ])).toEqual({
      kind: "setup",
      mode: "apply",
      vaultRoot: "/private/tmp/grandbox-vault",
      parentPageId: PARENT_PAGE_ID,
    });
  });

  it("accepts a Cortex apply invocation without a credential or config path", () => {
    expect(parseCliArguments([
      "setup",
      "cortex",
      "apply",
      "--vault",
      "/private/tmp/grandbox-vault",
      "--root-page-id",
      PARENT_PAGE_ID,
      "--json",
    ])).toEqual({
      kind: "setup-cortex",
      mode: "apply",
      vaultRoot: "/private/tmp/grandbox-vault",
      rootPageId: PARENT_PAGE_ID,
    });
    expect(parseCliArguments([
      "setup",
      "cortex",
      "status",
      "--vault",
      "/private/tmp/grandbox-vault",
      "--json",
    ])).toEqual({
      kind: "setup-cortex",
      mode: "status",
      vaultRoot: "/private/tmp/grandbox-vault",
      rootPageId: null,
    });
  });

  it("prints help without composing a worker", async () => {
    const stdout: string[] = [];
    const exit = await runCli(["--help"], {
      stdout: { write: (value: string) => { stdout.push(value); return true; } },
      stderr: { write: () => true },
      createWorker: async () => { throw new Error("must not compose"); },
    });

    expect(exit).toBe(0);
    expect(stdout.join("")).toContain("--config");
    expect(stdout.join("")).toContain("--dry-run");
    expect(stdout.join("")).toContain("--reason");
    expect(stdout.join("")).toContain("--json");
  });

  it("passes a setup credential through stdin only and emits a bounded safe setup result", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const received: unknown[] = [];
    const exit = await runCli([
      "setup",
      "apply",
      "--vault",
      "/private/tmp/grandbox-vault",
      "--parent-page-id",
      PARENT_PAGE_ID,
      "--json",
    ], {
      stdout: { write: (value: string) => { stdout.push(value); return true; } },
      stderr: { write: (value: string) => { stderr.push(value); return true; } },
      createWorker: async () => { throw new Error("must not compose a sync worker"); },
      readSetupInstallationId: async (vaultRoot) => {
        expect(vaultRoot).toBe("/private/tmp/grandbox-vault");
        return INSTALLATION_ID;
      },
      readSetupToken: async () => "ntn_stdin_only_token",
      createInstallationInitializer: async (installationId) => {
        expect(installationId).toBe(INSTALLATION_ID);
        return {
          initialize: async (input) => {
            received.push(input);
            return { configuration: "ready" as const, created: true };
          },
        };
      },
    });

    expect(exit).toBe(0);
    expect(received).toEqual([{
      installationId: INSTALLATION_ID,
      vaultRoot: "/private/tmp/grandbox-vault",
      parentPageId: PARENT_PAGE_ID,
      token: "ntn_stdin_only_token",
      mode: "apply",
    }]);
    expect(stdout).toEqual(["{\"configuration\":\"ready\",\"created\":true}\n"]);
    expect(`${stdout.join("")}\n${stderr.join("")}`).not.toContain("ntn_stdin_only_token");
  });

  it("emits a bounded safe setup failure result without provider details", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await runCli([
      "setup",
      "apply",
      "--vault",
      "/private/tmp/grandbox-vault",
      "--parent-page-id",
      PARENT_PAGE_ID,
      "--json",
    ], {
      stdout: { write: (value: string) => { stdout.push(value); return true; } },
      stderr: { write: (value: string) => { stderr.push(value); return true; } },
      createWorker: async () => { throw new Error("must not compose a sync worker"); },
      readSetupInstallationId: async () => INSTALLATION_ID,
      readSetupToken: async () => "ntn_stdin_only_token",
      createInstallationInitializer: async () => ({
        initialize: async () => { throw new Error(`provider rejected ${REDACTION_CANARY}`); },
      }),
    });

    expect(exit).toBe(1);
    expect(stdout).toEqual(["{\"configuration\":\"unconfigured\",\"created\":false,\"error\":\"internal-error\"}\n"]);
    expect(`${stdout.join("")}\n${stderr.join("")}`).not.toContain(REDACTION_CANARY);
  });

  it("reports setup status without reading a credential or invoking Notion", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const received: string[] = [];
    const initializer = {
      initialize: async () => { throw new Error("must not initialize while reading status"); },
      status: async (input: { readonly installationId: string; readonly vaultRoot: string }) => {
        received.push(`${input.installationId}:${input.vaultRoot}`);
        return { configuration: "ready" as const, created: false };
      },
    };
    const exit = await runCli([
      "setup",
      "status",
      "--vault",
      "/private/tmp/grandbox-vault",
      "--json",
    ], {
      stdout: { write: (value: string) => { stdout.push(value); return true; } },
      stderr: { write: (value: string) => { stderr.push(value); return true; } },
      createWorker: async () => { throw new Error("must not compose a sync worker"); },
      readSetupInstallationId: async () => INSTALLATION_ID,
      createInstallationInitializer: async () => initializer,
    });

    expect(exit).toBe(0);
    expect(received).toEqual([`${INSTALLATION_ID}:/private/tmp/grandbox-vault`]);
    expect(stdout).toEqual(["{\"configuration\":\"ready\",\"created\":false}\n"]);
    expect(stderr).toEqual([]);
  });

  it("routes Cortex apply through the stored-credential setup boundary only", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const received: unknown[] = [];
    const exit = await runCli([
      "setup",
      "cortex",
      "apply",
      "--vault",
      "/private/tmp/grandbox-vault",
      "--root-page-id",
      PARENT_PAGE_ID,
      "--json",
    ], {
      stdout: { write: (value: string) => { stdout.push(value); return true; } },
      stderr: { write: (value: string) => { stderr.push(value); return true; } },
      createWorker: async () => { throw new Error("must not compose a sync worker"); },
      readSetupInstallationId: async () => INSTALLATION_ID,
      readSetupToken: async () => { throw new Error("must not read a Cortex token from stdin"); },
      createInstallationInitializer: async () => { throw new Error("must not use legacy setup initializer"); },
      createCortexInstallationInitializer: async (installationId) => {
        expect(installationId).toBe(INSTALLATION_ID);
        return {
          cortexStatus: async () => { throw new Error("must not read status during apply"); },
          configureCortex: async (input) => {
            received.push(input);
            return { configuration: "ready" as const, created: true };
          },
        };
      },
    });

    expect(exit).toBe(0);
    expect(received).toEqual([{
      installationId: INSTALLATION_ID,
      vaultRoot: "/private/tmp/grandbox-vault",
      rootPageId: PARENT_PAGE_ID,
    }]);
    expect(stdout).toEqual(["{\"configuration\":\"ready\",\"created\":true}\n"]);
    expect(stderr).toEqual([]);
  });

  it("routes Cortex status without a root ID, credential, or remote output", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const received: unknown[] = [];
    const exit = await runCli([
      "setup",
      "cortex",
      "status",
      "--vault",
      "/private/tmp/grandbox-vault",
      "--json",
    ], {
      stdout: { write: (value: string) => { stdout.push(value); return true; } },
      stderr: { write: (value: string) => { stderr.push(value); return true; } },
      createWorker: async () => { throw new Error("must not compose a sync worker"); },
      readSetupInstallationId: async () => INSTALLATION_ID,
      readSetupToken: async () => { throw new Error("must not read a Cortex token from stdin"); },
      createInstallationInitializer: async () => { throw new Error("must not use legacy setup initializer"); },
      createCortexInstallationInitializer: async () => ({
        cortexStatus: async (input) => {
          received.push(input);
          return { configuration: "ready" as const, created: false };
        },
        configureCortex: async () => { throw new Error("must not configure during status"); },
      }),
    });

    expect(exit).toBe(0);
    expect(received).toEqual([{
      installationId: INSTALLATION_ID,
      vaultRoot: "/private/tmp/grandbox-vault",
    }]);
    expect(stdout).toEqual(["{\"configuration\":\"ready\",\"created\":false}\n"]);
    expect(stderr).toEqual([]);
  });

  it("accepts one newline-terminated setup token from stdin and rejects ambiguous input", async () => {
    async function* one(value: string): AsyncIterable<string> {
      yield value;
    }

    await expect(readSetupToken(one("ntn_stdin_only_token\n"))).resolves.toBe("ntn_stdin_only_token");
    await expect(readSetupToken(one("ntn_one\nntn_two\n"))).rejects.toThrow(/setup credential/i);
    await expect(readSetupToken(one("\n"))).rejects.toThrow(/setup credential/i);
  });

  it("composes the production setup adapters with private config, state, and Keychain-only credential storage", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "grandbox-setup-home-")));
    const vault = await realpath(await mkdtemp(join(tmpdir(), "grandbox-setup-vault-")));
    const configPath = join(home, "Library", "Application Support", "Grandbox Bridge", INSTALLATION_ID, "config.json");
    const keychainCommands: Array<{ readonly executable: string; readonly args: string[]; readonly stdin?: string }> = [];
    const initializer = createProductionInstallationInitializer(configPath, INSTALLATION_ID, {
      processRunner: {
        run: async (input) => {
          keychainCommands.push({ executable: input.executable, args: input.args, stdin: input.stdin });
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      provisionNotion: async () => ({
        databaseId: "33333333-3333-4333-8333-333333333333",
        dataSourceId: "44444444-4444-4444-8444-444444444444",
      }),
    });

    await expect(initializer.initialize({
      installationId: INSTALLATION_ID,
      vaultRoot: vault,
      parentPageId: PARENT_PAGE_ID,
      token: "ntn_local_only_token",
      mode: "apply",
    })).resolves.toEqual({ configuration: "ready", created: true });

    const config = await readFile(configPath, "utf8");
    const state = await readFile(join(home, "Library", "Application Support", "Grandbox Bridge", INSTALLATION_ID, "state.json"), "utf8");
    expect(config).toContain('"dataSourceId"');
    expect(config).not.toContain("ntn_local_only_token");
    expect(state).toContain(`"installationId":"${INSTALLATION_ID}"`);
    expect(keychainCommands).toHaveLength(1);
    expect(keychainCommands[0]).toMatchObject({
      executable: "/usr/bin/expect",
      args: [
        "-c",
        expect.stringContaining(`spawn /usr/bin/security add-generic-password -U -a ${INSTALLATION_ID} -s GrandboxBridge/notion-token -w`),
      ],
      stdin: "ntn_local_only_token\n",
    });
    expect(keychainCommands[0]?.args.join("\n")).not.toContain("ntn_local_only_token");
  });

  it("routes an installed plugin locator through the complete local setup command", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "grandbox-cli-home-")));
    const vault = await realpath(await mkdtemp(join(tmpdir(), "grandbox-cli-vault-")));
    const pluginDirectory = join(vault, ".obsidian", "plugins", "grandbox-bridge");
    await mkdir(pluginDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(pluginDirectory, "data.json"), JSON.stringify({ installationId: INSTALLATION_ID }), { mode: 0o600 });
    const stdout: string[] = [];
    const stderr: string[] = [];
    async function* tokenSource(): AsyncIterable<string> {
      yield "ntn_local_stdin_token\n";
    }
    const dependencies = createProductionCliDependencies({
      stdout: { write: (value: string) => { stdout.push(value); return true; } },
      stderr: { write: (value: string) => { stderr.push(value); return true; } },
      homeDirectory: home,
      setupTokenSource: tokenSource(),
      processRunner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      provisionNotion: async () => ({
        databaseId: "33333333-3333-4333-8333-333333333333",
        dataSourceId: "44444444-4444-4444-8444-444444444444",
      }),
    });

    await expect(runCli([
      "setup",
      "apply",
      "--vault",
      vault,
      "--parent-page-id",
      PARENT_PAGE_ID,
      "--json",
    ], dependencies)).resolves.toBe(0);

    expect(stdout).toEqual(["{\"configuration\":\"ready\",\"created\":true}\n"]);
    expect(stderr).toEqual([]);
    expect((await readFile(join(home, "Library", "Application Support", "Grandbox Bridge", INSTALLATION_ID, "config.json"), "utf8"))).not.toContain("ntn_local_stdin_token");
  });

  it.each([
    ["--config", "relative.json", "--reason", "manual", "--json"],
    ["--config", CONFIG, "--reason", "manual", "--json", "--json"],
    ["--config", CONFIG, "--reason", "unknown", "--json"],
    ["--config", CONFIG, "--reason", "manual"],
    ["--unknown"],
  ])("rejects an unsafe or ambiguous invocation", (argv) => {
    expect(() => parseCliArguments(argv)).toThrow("Invalid bridge worker invocation");
  });

  it("writes one bounded JSON summary and redacts a worker failure", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const received: unknown[] = [];
    const exit = await runCli(["--config", CONFIG, "--dry-run", "--reason", "manual", "--json"], {
      stdout: { write: (value: string) => { stdout.push(value); return true; } },
      stderr: { write: (value: string) => { stderr.push(value); return true; } },
      createWorker: async () => ({
        run: async (input) => {
          received.push(input);
          return {
          mode: "preview" as const,
          outcome: "failed" as const,
          planned: 0,
          writes: 0,
          pushed: 0,
          pulled: 0,
          conflicts: 0,
          errors: 1,
          graphUploads: 0,
          startedAt: "2026-07-14T12:34:56.000Z",
          completedAt: "2026-07-14T12:34:56.000Z",
          };
        },
      }),
    });

    expect(exit).toBe(1);
    expect(received).toEqual([{ mode: "preview", reason: "manual" }]);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toMatch(/^\{.*\}\n$/u);
    expect(stderr.join("")).not.toContain("ntn_");
  });

  it("returns a fixed fallback JSON and never echoes a secret-looking construction error", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exit = await runCli(["--config", CONFIG, "--reason", "manual", "--json"], {
      stdout: { write: (value: string) => { stdout.push(value); return true; } },
      stderr: { write: (value: string) => { stderr.push(value); return true; } },
      createWorker: async () => { throw new Error(REDACTION_CANARY); },
    });

    expect(exit).toBe(1);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "{}")).toMatchObject({ outcome: "failed", errors: 1 });
    expect(stderr.join("")).not.toContain(REDACTION_CANARY);
  });
});
