import { describe, expect, it } from "vitest";
import { parseCliArguments, runCli } from "./cli.js";

const CONFIG = "/private/tmp/grandbox/config.json";

describe("worker CLI", () => {
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
      createWorker: async () => { throw new Error("ntn_synthetic_private_token"); },
    });

    expect(exit).toBe(1);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "{}")).toMatchObject({ outcome: "failed", errors: 1 });
    expect(stderr.join("")).not.toContain("ntn_synthetic_private_token");
  });
});
