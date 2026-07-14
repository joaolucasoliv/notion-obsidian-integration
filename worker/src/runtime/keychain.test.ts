import { describe, expect, it } from "vitest";
import {
  MacOSKeychainCredentialStore,
  type ProcessRunner,
  type ProcessRunnerInput,
  type ProcessRunnerResult,
} from "./keychain.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

class RecordingRunner implements ProcessRunner {
  readonly calls: ProcessRunnerInput[] = [];

  constructor(private readonly results: ProcessRunnerResult[] = [{ code: 0, stdout: "", stderr: "" }]) {}

  get last(): ProcessRunnerInput | undefined {
    return this.calls.at(-1);
  }

  async run(input: ProcessRunnerInput): Promise<ProcessRunnerResult> {
    this.calls.push(input);
    return this.results.shift() ?? { code: 0, stdout: "", stderr: "" };
  }
}

describe("MacOSKeychainCredentialStore", () => {
  it("writes a secret through stdin and never argv", async () => {
    const runner = new RecordingRunner();
    const store = new MacOSKeychainCredentialStore(INSTALLATION_ID, runner);

    await store.set("notion-token", "fixture-notion-value");

    expect(runner.last).toEqual({
      executable: "/usr/bin/security",
      args: [
        "add-generic-password",
        "-U",
        "-a",
        INSTALLATION_ID,
        "-s",
        "GrandboxBridge/notion-token",
        "-w",
      ],
      stdin: "fixture-notion-value\n",
      maxBytes: 8_192,
    });
    expect(JSON.stringify(runner.last?.args)).not.toContain("fixture-notion-value");
  });

  it("reads a secret with an explicit bounded no-shell command", async () => {
    const runner = new RecordingRunner([{ code: 0, stdout: "fixture-relay-value\n", stderr: "" }]);
    const store = new MacOSKeychainCredentialStore(INSTALLATION_ID, runner);

    await expect(store.get("relay-token")).resolves.toBe("fixture-relay-value");
    expect(runner.last).toEqual({
      executable: "/usr/bin/security",
      args: ["find-generic-password", "-a", INSTALLATION_ID, "-s", "GrandboxBridge/relay-token", "-w"],
      maxBytes: 8_192,
    });
  });

  it("returns null only for the Keychain not-found status", async () => {
    const runner = new RecordingRunner([{ code: 44, stdout: "", stderr: "fixture missing detail" }]);
    const store = new MacOSKeychainCredentialStore(INSTALLATION_ID, runner);

    await expect(store.get("graph-key")).resolves.toBeNull();
  });

  it("deletes with explicit arguments and treats a missing item as already deleted", async () => {
    const runner = new RecordingRunner([{ code: 44, stdout: "", stderr: "fixture missing detail" }]);
    const store = new MacOSKeychainCredentialStore(INSTALLATION_ID, runner);

    await expect(store.delete("graph-key")).resolves.toBeUndefined();
    expect(runner.last).toEqual({
      executable: "/usr/bin/security",
      args: ["delete-generic-password", "-a", INSTALLATION_ID, "-s", "GrandboxBridge/graph-key"],
      maxBytes: 8_192,
    });
  });

  it("never includes a secret or runner output in a failure", async () => {
    const secret = "fixture-pairing-and-credential-secret";
    const runner = new RecordingRunner([{ code: 1, stdout: secret, stderr: `provider says ${secret}` }]);
    const store = new MacOSKeychainCredentialStore(INSTALLATION_ID, runner);

    const error = await store.set("notion-token", secret).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/keychain operation failed/i);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(runner.last?.args)).not.toContain(secret);
  });

  it("rejects overlong runner output even if a runner violates the byte contract", async () => {
    const runner = new RecordingRunner([{ code: 0, stdout: "x".repeat(8_193), stderr: "" }]);
    const store = new MacOSKeychainCredentialStore(INSTALLATION_ID, runner);

    await expect(store.get("notion-token")).rejects.toThrow(/keychain operation failed/i);
  });

  it("rejects an unsafe account or runtime slot before invoking the runner", async () => {
    const runner = new RecordingRunner();

    expect(() => new MacOSKeychainCredentialStore("../../other-account", runner)).toThrow(/installation identity/i);
    const store = new MacOSKeychainCredentialStore(INSTALLATION_ID, runner);
    await expect(store.get("notion-token/other" as never)).rejects.toThrow(/credential slot/i);
    expect(runner.calls).toHaveLength(0);
  });
});
