import { describe, expect, it } from "vitest";
import { BridgeHarness, optedIn } from "../fakes/bridge-harness.js";

describe("global preflight and batch safety", () => {
  it("fails a missing credential before any UUID, journal, local, or Notion mutation", async () => {
    const harness = await BridgeHarness.create({ credential: null });
    await harness.writeNote("Credential.md", optedIn("private\n"));
    const beforeState = JSON.stringify(harness.state.value);

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "failed", writes: 0, errors: 1 });
    expect(harness.uuid.calls).toBe(0);
    expect(harness.journal.begun).toEqual([]);
    expect(harness.notion.creates).toBe(0);
    expect(JSON.stringify(harness.state.value)).toBe(beforeState);
  });

  it("fails closed on a duplicate bridge identity without changing either side", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Original.md", optedIn("original\n"));
    await harness.apply();
    await harness.writeNote("Duplicate.md", await harness.note("Original.md"));
    const beforeJournal = harness.journal.begun.length;
    const beforeState = JSON.stringify(harness.state.value);
    const beforeNotion = harness.notion.snapshot();

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "failed", planned: 0, writes: 0, errors: 1 });
    expect(harness.journal.begun).toHaveLength(beforeJournal);
    expect(JSON.stringify(harness.state.value)).toBe(beforeState);
    expect(harness.notion.snapshot()).toBe(beforeNotion);
  });

  it.each([
    ["vault fingerprint", { vaultFingerprintMismatch: true }],
    ["installation lock", { lockFails: true }],
    ["provider verification", { verifyFails: true }],
  ] as const)("makes zero mutations when %s preflight fails", async (_name, options) => {
    const harness = await BridgeHarness.create(options);
    await harness.writeNote("Blocked.md", optedIn("blocked\n"));

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "failed", writes: 0, errors: 1 });
    expect(harness.journal.begun).toEqual([]);
    expect(harness.notion.creates).toBe(0);
    expect(harness.uuid.calls).toBe(0);
    expect(harness.state.saves).toBe(0);
  });
});
