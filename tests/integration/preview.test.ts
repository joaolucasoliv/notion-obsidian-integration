import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BridgeHarness, optedIn } from "../fakes/bridge-harness.js";

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
});
