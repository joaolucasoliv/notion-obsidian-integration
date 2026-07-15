import { describe, expect, it } from "vitest";
import { semanticHash } from "../../worker/src/markdown/normalize.js";
import { BridgeHarness, optedIn } from "../fakes/bridge-harness.js";

describe("executor remote-result integrity", () => {
  it("does not complete or advance a pair when create returns a different Bridge ID", async () => {
    const harness = await BridgeHarness.create({ corruptCreateBridgeResult: true });
    await harness.writeNote("CorruptCreate.md", optedIn("create\n"));

    const result = await harness.apply();

    const createIntent = harness.journal.begun.find((entry) => entry.effectKind === "create-notion-page");
    expect(result).toMatchObject({ errors: 1 });
    expect(Object.keys(harness.state.value.pairs)).toEqual([]);
    expect(harness.journal.completed.some((entry) => entry.id === createIntent?.id)).toBe(false);
  });

  it("journals the body-before-tags semantic hash from its own intermediate remote result", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Atomic.md", optedIn("common\n", ["alpha"]));
    await harness.apply();
    const pair = Object.values(harness.state.value.pairs)[0];
    if (pair === undefined) throw new Error("synthetic pair was not created");
    const before = await harness.notion.retrievePage(pair.notionPageId);
    if (before.kind !== "present") throw new Error("synthetic page disappeared");
    await harness.writeNote(
      "Atomic.md",
      (await harness.note("Atomic.md"))
        .replace("common", "local body")
        .replace("tags: [alpha]", "tags: [alpha, beta]"),
    );

    const result = await harness.apply();

    const expectedIntermediateHash = await semanticHash({ ...before.semantic, bodyMarkdown: "local body\n" });
    const finalHash = await semanticHash({ bodyMarkdown: "local body\n", tags: ["alpha", "beta"] });
    const bodyIntent = [...harness.journal.begun].reverse().find((entry) => entry.effectKind === "update-notion-body-exact");
    const bodyCompletion = harness.journal.completed.find((entry) => entry.id === bodyIntent?.id);
    expect(result).toMatchObject({ outcome: "success", errors: 0 });
    expect(bodyIntent?.resultSemanticHash).toBe(expectedIntermediateHash);
    expect(bodyCompletion?.evidence.resultSemanticHash).toBe(expectedIntermediateHash);
    expect(expectedIntermediateHash).not.toBe(finalHash);
  });

  it("does not complete or advance a body effect when its returned semantic content is wrong", async () => {
    const harness = await BridgeHarness.create({ corruptBodyResult: true });
    await harness.writeNote("CorruptBody.md", optedIn("before\n"));
    await harness.apply();
    const beforeCommonHash = Object.values(harness.state.value.pairs)[0]?.lastCommonSemanticHash;
    await harness.writeNote("CorruptBody.md", (await harness.note("CorruptBody.md")).replace("before", "after"));

    const result = await harness.apply();

    const bodyIntent = [...harness.journal.begun].reverse().find((entry) => entry.effectKind === "update-notion-body-exact");
    expect(result).toMatchObject({ errors: 1 });
    expect(Object.values(harness.state.value.pairs)[0]?.lastCommonSemanticHash).toBe(beforeCommonHash);
    expect(harness.journal.completed.some((entry) => entry.id === bodyIntent?.id)).toBe(false);
  });

  it("does not complete or advance a status effect when its returned managed status is wrong", async () => {
    const harness = await BridgeHarness.create({ corruptManagedStatusResult: true });
    await harness.writeNote("CorruptStatus.md", optedIn("status\n"));
    await harness.apply();
    await harness.writeNote(
      "CorruptStatus.md",
      (await harness.note("CorruptStatus.md")).replace("notion_sync: true", "notion_sync: false"),
    );

    const result = await harness.apply();

    const statusIntent = [...harness.journal.begun].reverse().find((entry) => entry.effectKind === "set-notion-status");
    expect(result).toMatchObject({ errors: 1 });
    expect(Object.values(harness.state.value.pairs)[0]?.status).toBe("synced");
    expect(harness.journal.completed.some((entry) => entry.id === statusIntent?.id)).toBe(false);
  });
});
