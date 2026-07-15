import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BridgeHarness, optedIn } from "../fakes/bridge-harness.js";

describe("two-sided conflicts", () => {
  it("writes a separate conflict artifact and marks the remote page without overwriting local content", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Conflict.md", optedIn("common\n"));
    await harness.apply();
    await harness.writeNote("Conflict.md", (await harness.note("Conflict.md")).replace("common", "local change"));
    await harness.remoteBodyFor("Conflict.md", "remote change\n");

    const result = await harness.apply();

    expect(harness.journal.begun.map((intent) => intent.effectKind)).toEqual([
      "commit-state",
      "initialize-pair",
      "create-notion-page",
      "commit-state",
      "create-conflict",
      "set-notion-status",
    ]);
    expect(harness.journal.completed.map((entry) => entry.id)).toEqual([
      harness.journal.begun[1]?.id,
      harness.journal.begun[2]?.id,
      harness.journal.begun[0]?.id,
      harness.journal.begun[4]?.id,
      harness.journal.begun[5]?.id,
      harness.journal.begun[3]?.id,
    ]);
    expect(result).toMatchObject({ outcome: "conflict", conflicts: 1, errors: 0 });
    await expect(harness.note("Conflict.md")).resolves.toContain("local change");
    await expect(readdir(`${harness.root.canonicalRealPath}/Bridge Conflicts`)).resolves.toHaveLength(1);
  });
});
