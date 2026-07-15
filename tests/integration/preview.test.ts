import { readdir, readFile } from "node:fs/promises";
import { sha256Hex } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import { BridgeHarness, INSTALLATION_ID, optedIn } from "../fakes/bridge-harness.js";

async function snapshot(root: string): Promise<string> {
  const names = await readdir(root);
  const files = await Promise.all(names.sort().map(async (name) => `${name}:${await readFile(`${root}/${name}`, "utf8")}`));
  return files.join("\n");
}

describe("preview", () => {
  it("plans through safe reads without mutating the vault, state, Notion, journal, or UUID source", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Preview.md", optedIn("preview\n"));
    const beforeFiles = await snapshot(harness.root.canonicalRealPath);
    const beforeState = JSON.stringify(harness.state.value);
    const beforeNotion = harness.notion.snapshot();

    const result = await harness.preview("reconciliation");

    expect(result).toMatchObject({ mode: "preview", planned: 2, writes: 0, errors: 0 });
    expect(await snapshot(harness.root.canonicalRealPath)).toBe(beforeFiles);
    expect(JSON.stringify(harness.state.value)).toBe(beforeState);
    expect(harness.notion.snapshot()).toBe(beforeNotion);
    expect(harness.journal.begun).toEqual([]);
    expect(harness.uuid.calls).toBe(0);
  });

  it("fails closed on a pending journal entry without completing it in preview", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Pending.md", optedIn("pending\n"));
    harness.journal.begun.push({
      schemaVersion: 1,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      installationId: INSTALLATION_ID,
      effectKind: "write-local",
      relativePath: "Pending.md",
      remoteId: null,
      allocationId: null,
      expectedByteHash: await sha256Hex(await harness.note("Pending.md")),
      expectedSemanticHash: null,
      resultByteHash: "c".repeat(64),
      resultSemanticHash: null,
      expectedRemoteEditedAt: null,
      createdAt: "2026-07-14T12:34:56.000Z",
    });
    const beforeState = JSON.stringify(harness.state.value);
    const beforeNotion = harness.notion.snapshot();

    const result = await harness.preview();

    expect(result).toMatchObject({ outcome: "recovery-required", writes: 0, errors: 0 });
    expect(harness.journal.completed).toEqual([]);
    expect(JSON.stringify(harness.state.value)).toBe(beforeState);
    expect(harness.notion.snapshot()).toBe(beforeNotion);
    expect(harness.uuid.calls).toBe(0);
    expect(harness.notion.verifies).toBe(0);
  });
});
