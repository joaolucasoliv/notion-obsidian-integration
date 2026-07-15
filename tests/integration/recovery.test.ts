import { sha256Hex } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import { BridgeHarness, optedIn } from "../fakes/bridge-harness.js";

describe("recovery and journal order", () => {
  it("records intents before each confirmed first-pair mutation", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Journal.md", optedIn("journal\n"));

    await harness.apply();

    expect(harness.journal.begun.map((entry) => entry.effectKind)).toEqual(["initialize-pair", "create-notion-page"]);
    expect(harness.journal.completed.map((entry) => entry.id)).toEqual(harness.journal.begun.map((entry) => entry.id));
    expect(harness.journal.begun[0]?.allocationId).toMatch(/^[0-9a-f]{64}$/u);
    expect(harness.journal.begun[1]?.allocationId).toBe(harness.journal.begun[0]?.allocationId);
    expect(JSON.stringify(harness.journal.begun)).not.toContain("journal\\n");
  });

  it("completes a retryable local precondition and replans instead of replaying its stale intent", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Retry.md", optedIn("retry\n"));
    await harness.apply();
    const pair = Object.values(harness.state.value.pairs)[0];
    if (pair === undefined) throw new Error("synthetic pair was not created");
    harness.journal.begun.push({
      schemaVersion: 1,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      installationId: "11111111-1111-4111-8111-111111111111",
      effectKind: "write-local",
      relativePath: pair.localPath,
      remoteId: null,
      allocationId: null,
      expectedByteHash: await sha256Hex(await harness.note(pair.localPath)),
      expectedSemanticHash: pair.lastCommonSemanticHash,
      resultByteHash: "c".repeat(64),
      resultSemanticHash: pair.lastCommonSemanticHash,
      expectedRemoteEditedAt: null,
      createdAt: "2026-07-14T12:34:56.000Z",
    });
    const beforeWrites = harness.notion.creates + harness.notion.bodyUpdates + harness.notion.propertyUpdates;

    const result = await harness.apply("reconciliation");

    expect(result).toMatchObject({ outcome: "noop", writes: 0, errors: 0 });
    expect(harness.journal.completed.at(-1)?.id).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(harness.notion.creates + harness.notion.bodyUpdates + harness.notion.propertyUpdates).toBe(beforeWrites);
  });

  it("stops before scan or remote creation when an incomplete remote create cannot be proven", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Blocked.md", optedIn("blocked\n"));
    harness.journal.begun.push({
      schemaVersion: 1,
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      installationId: "11111111-1111-4111-8111-111111111111",
      effectKind: "create-notion-page",
      relativePath: null,
      remoteId: null,
      allocationId: "d".repeat(64),
      expectedByteHash: null,
      expectedSemanticHash: "e".repeat(64),
      resultByteHash: null,
      resultSemanticHash: "e".repeat(64),
      expectedRemoteEditedAt: null,
      createdAt: "2026-07-14T12:34:56.000Z",
    });

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "recovery-required", writes: 0, errors: 0 });
    expect(harness.notion.creates).toBe(0);
    expect(harness.uuid.calls).toBe(0);
  });

  it("classifies an exact remote body precondition, completes it, and replans rather than replaying the stale update", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("RemoteRecovery.md", optedIn("common\n"));
    await harness.apply();
    const pair = Object.values(harness.state.value.pairs)[0];
    if (pair === undefined) throw new Error("synthetic pair was not created");
    harness.journal.begun.push({
      schemaVersion: 1,
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      installationId: "11111111-1111-4111-8111-111111111111",
      effectKind: "update-notion-body-exact",
      relativePath: null,
      remoteId: pair.notionPageId,
      allocationId: null,
      expectedByteHash: null,
      expectedSemanticHash: pair.lastCommonSemanticHash,
      resultByteHash: null,
      resultSemanticHash: "f".repeat(64),
      expectedRemoteEditedAt: pair.lastNotionEditedAt,
      createdAt: "2026-07-14T12:34:56.000Z",
    });
    const beforeBodyUpdates = harness.notion.bodyUpdates;

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "noop", writes: 0, errors: 0 });
    expect(harness.journal.completed.at(-1)?.id).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(harness.notion.bodyUpdates).toBe(beforeBodyUpdates);
  });

  it("classifies a provable remote body postcondition and follows the fresh pull plan", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("RemotePost.md", optedIn("common\n"));
    await harness.apply();
    const pair = Object.values(harness.state.value.pairs)[0];
    if (pair === undefined) throw new Error("synthetic pair was not created");
    await harness.remoteBodyFor(pair.localPath, "remote post\n");
    const observed = await harness.notion.retrievePage(pair.notionPageId);
    if (observed.kind !== "present") throw new Error("synthetic page disappeared");
    harness.journal.begun.push({
      schemaVersion: 1,
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      installationId: "11111111-1111-4111-8111-111111111111",
      effectKind: "update-notion-body-exact",
      relativePath: null,
      remoteId: pair.notionPageId,
      allocationId: null,
      expectedByteHash: null,
      expectedSemanticHash: pair.lastCommonSemanticHash,
      resultByteHash: null,
      resultSemanticHash: observed.semanticHash,
      expectedRemoteEditedAt: pair.lastNotionEditedAt,
      createdAt: "2026-07-14T12:34:56.000Z",
    });
    const beforeBodyUpdates = harness.notion.bodyUpdates;

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "success", pulled: 1, errors: 0 });
    expect(harness.journal.completed.at(-2)?.id).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    expect(harness.notion.bodyUpdates).toBe(beforeBodyUpdates);
    await expect(harness.note(pair.localPath)).resolves.toContain("remote post");
  });
});
