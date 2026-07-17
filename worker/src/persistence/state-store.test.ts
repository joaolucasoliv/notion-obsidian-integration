import { chmod, lstat, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBridgeState } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import { FileStateStore } from "./state-store.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const HASH = "b".repeat(64);
const PAIR_ID = "33333333-3333-4333-8333-333333333333";
const PAGE_ID = "44444444-4444-4444-8444-444444444444";
const TIMESTAMP = "2026-07-14T12:34:56.000Z";

function state(installationId = INSTALLATION_ID) {
  return {
    schemaVersion: 1 as const,
    installationId,
    pairs: {
      [PAIR_ID]: {
        bridgeId: PAIR_ID,
        localPath: "Notes/Bridge.md",
        notionPageId: PAGE_ID,
        status: "synced" as const,
        lastLocalSemanticHash: HASH,
        lastNotionSemanticHash: HASH,
        lastCommonSemanticHash: HASH,
        lastCommonLocalByteHash: HASH,
        lastNotionEditedAt: TIMESTAMP,
        lastSyncedAt: TIMESTAMP,
      },
    },
    graph: null,
    lastFullReconciliationAt: null,
    lastRun: null,
  };
}

async function temporaryDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "grandbox-state-store-")));
}

describe("FileStateStore", () => {
  it("fails closed instead of bootstrapping a missing state", async () => {
    const directory = await temporaryDirectory();
    const store = new FileStateStore(join(directory, "state.json"), INSTALLATION_ID);

    await expect(store.load()).rejects.toThrow(/state store failed/i);
  });

  it("normalizes a strict persisted V1 state to immutable V2 and writes V2 on its next save", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "state.json");
    const fixture = state();
    const normalized = { ...fixture, schemaVersion: 2, cortex: null };
    expect(parseBridgeState(fixture)).toEqual(normalized);
    await writeFile(path, JSON.stringify(fixture), { mode: 0o600 });
    await chmod(path, 0o600);
    const store = new FileStateStore(path, INSTALLATION_ID);

    const loaded = await store.load();

    expect(loaded).toEqual(normalized);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.pairs)).toBe(true);
    expect(Object.isFrozen(loaded.pairs[PAIR_ID])).toBe(true);

    await store.save(loaded);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(normalized);
  });

  it("rejects another installation and does not reflect malformed persisted bytes", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "state.json");
    const canary = "fixture-state-secret-must-not-leak";
    await writeFile(path, JSON.stringify({ ...state(OTHER_INSTALLATION_ID), canary }), { mode: 0o600 });
    await chmod(path, 0o600);
    const store = new FileStateStore(path, INSTALLATION_ID);

    const error = await store.load().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/state store failed/i);
    expect(String(error)).not.toContain(canary);
    expect(String(error)).not.toContain(OTHER_INSTALLATION_ID);
  });

  it("atomically saves only the bound private state", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "state.json");
    const store = new FileStateStore(path, INSTALLATION_ID);
    const normalized = parseBridgeState(state());
    await store.save(normalized);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...state(), schemaVersion: 2, cortex: null });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(store.save(parseBridgeState(state(OTHER_INSTALLATION_ID)))).rejects.toThrow(/state store failed/i);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...state(), schemaVersion: 2, cortex: null });
  });
});
