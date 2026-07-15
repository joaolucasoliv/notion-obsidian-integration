import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NotionClient } from "./notion/client.js";
import type { NotionTransport, NotionTransportResponse } from "./notion/transport.js";
import {
  createProductionNotionObservationDecoder,
  deriveProductionRuntimePaths,
  parseCliArguments,
  runCli,
} from "./cli.js";

const CONFIG = "/private/tmp/grandbox/config.json";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
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
