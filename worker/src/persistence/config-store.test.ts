import { chmod, lstat, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBridgeConfig } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import { FileConfigStore } from "./config-store.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);

function config(installationId = INSTALLATION_ID) {
  return {
    schemaVersion: 1 as const,
    installationId,
    vaultRoot: "/private/tmp/fixture-vault",
    vaultFingerprint: HASH,
    notion: null,
    relay: null,
    graph: {
      graphId: "fixture-graph",
      webOrigin: null,
      domains: [{ pathPrefix: "Notes", domain: "personal" as const }],
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "grandbox-config-store-")));
}

describe("FileConfigStore", () => {
  it("fails closed instead of bootstrapping a missing config", async () => {
    const directory = await temporaryDirectory();
    const store = new FileConfigStore(join(directory, "config.json"), INSTALLATION_ID);

    await expect(store.load()).rejects.toThrow(/config store failed/i);
  });

  it("strictly loads an immutable private config bound to its installation", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "config.json");
    const fixture = config();
    expect(parseBridgeConfig(fixture)).toEqual(fixture);
    await writeFile(path, JSON.stringify(fixture), { mode: 0o600 });
    await chmod(path, 0o600);
    const store = new FileConfigStore(path, INSTALLATION_ID);

    const loaded = await store.load();

    expect(loaded).toEqual(config());
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.graph)).toBe(true);
    expect(Object.isFrozen(loaded.graph?.domains)).toBe(true);
    expect(Object.isFrozen(loaded.graph?.domains[0])).toBe(true);
  });

  it("rejects another installation and does not reflect malformed persisted bytes", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "config.json");
    const canary = "fixture-config-secret-must-not-leak";
    await writeFile(path, JSON.stringify({ ...config(OTHER_INSTALLATION_ID), canary }), { mode: 0o600 });
    await chmod(path, 0o600);
    const store = new FileConfigStore(path, INSTALLATION_ID);

    const error = await store.load().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/config store failed/i);
    expect(String(error)).not.toContain(canary);
    expect(String(error)).not.toContain(OTHER_INSTALLATION_ID);
  });

  it("atomically saves only the bound private config", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "config.json");
    const store = new FileConfigStore(path, INSTALLATION_ID);
    await store.save(config());

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config());
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(store.save(config(OTHER_INSTALLATION_ID))).rejects.toThrow(/config store failed/i);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config());
  });
});
