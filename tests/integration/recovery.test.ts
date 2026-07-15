import { sha256Hex } from "@grandbox-bridge/shared";
import { describe, expect, it, vi } from "vitest";
import { BridgeHarness, optedIn } from "../fakes/bridge-harness.js";

describe("recovery and journal order", () => {
  it("records intents before each confirmed first-pair mutation", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Journal.md", optedIn("journal\n"));

    await harness.apply();

    expect(harness.journal.begun.map((entry) => entry.effectKind)).toEqual(["commit-state", "initialize-pair", "create-notion-page"]);
    expect(harness.journal.begun[0]).toMatchObject({
      relativePath: null,
      remoteId: null,
      allocationId: null,
      expectedByteHash: null,
      expectedSemanticHash: null,
      resultByteHash: null,
      resultSemanticHash: null,
      expectedRemoteEditedAt: null,
    });
    expect(harness.journal.completed.map((entry) => entry.id)).toEqual([
      harness.journal.begun[1]?.id,
      harness.journal.begun[2]?.id,
      harness.journal.begun[0]?.id,
    ]);
    expect(harness.journal.begun[1]?.allocationId).toMatch(/^[0-9a-f]{64}$/u);
    expect(harness.journal.begun[2]?.allocationId).toBe(harness.journal.begun[1]?.allocationId);
    expect(JSON.stringify(harness.journal.begun)).not.toContain("journal\\n");
  });

  it("does not create a second remote page after state persistence fails", async () => {
    const harness = await BridgeHarness.create({ stateSaveFailures: 1 });
    await harness.writeNote("DurableState.md", optedIn("durable\n"));

    const first = await harness.apply();

    expect(first).toMatchObject({ outcome: "failed", errors: 1 });
    expect(Object.keys(harness.state.value.pairs)).toEqual([]);
    expect(harness.notion.creates).toBe(1);
    const stateFence = harness.journal.begun.find((entry) => entry.effectKind === "commit-state");
    expect(stateFence).toMatchObject({
      relativePath: null,
      remoteId: null,
      allocationId: null,
      expectedByteHash: null,
      resultSemanticHash: null,
    });
    expect(harness.journal.completed.some((entry) => entry.id === stateFence?.id)).toBe(false);

    const second = await harness.apply();

    expect(second).toMatchObject({ outcome: "recovery-required", writes: 0, errors: 0 });
    expect(harness.notion.creates).toBe(1);
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
    expect(harness.journal.completed.some((entry) => entry.id === "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")).toBe(true);
    expect(harness.notion.bodyUpdates).toBe(beforeBodyUpdates);
    await expect(harness.note(pair.localPath)).resolves.toContain("remote post");
  });

  it("fails closed when body recovery receives a forged page and declared semantic hash", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("ForgedRecovery.md", optedIn("common\n"));
    await harness.apply();
    const pair = Object.values(harness.state.value.pairs)[0];
    if (pair === undefined) throw new Error("synthetic pair was not created");
    const observed = await harness.notion.retrievePage(pair.notionPageId);
    if (observed.kind !== "present") throw new Error("synthetic page disappeared");
    const intentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    harness.journal.begun.push({
      schemaVersion: 1,
      id: intentId,
      installationId: "11111111-1111-4111-8111-111111111111",
      effectKind: "update-notion-body-exact",
      relativePath: null,
      remoteId: pair.notionPageId,
      allocationId: null,
      expectedByteHash: null,
      expectedSemanticHash: observed.semanticHash,
      resultByteHash: null,
      resultSemanticHash: observed.semanticHash,
      expectedRemoteEditedAt: pair.lastNotionEditedAt,
      createdAt: "2026-07-14T12:34:56.000Z",
    });
    vi.spyOn(harness.notion, "retrievePage").mockResolvedValueOnce({
      ...observed,
      pageId: "99999999-9999-4999-8999-999999999999",
      semantic: { ...observed.semantic, bodyMarkdown: "forged body\n" },
      semanticHash: observed.semanticHash,
    });

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "recovery-required", writes: 0, errors: 0 });
    expect(harness.journal.completed.some((entry) => entry.id === intentId)).toBe(false);
  });

  it("fails closed when a matching page declares a semantic hash for different content", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("ForgedHashRecovery.md", optedIn("common\n"));
    await harness.apply();
    const pair = Object.values(harness.state.value.pairs)[0];
    if (pair === undefined) throw new Error("synthetic pair was not created");
    const observed = await harness.notion.retrievePage(pair.notionPageId);
    if (observed.kind !== "present") throw new Error("synthetic page disappeared");
    const intentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    harness.journal.begun.push({
      schemaVersion: 1,
      id: intentId,
      installationId: "11111111-1111-4111-8111-111111111111",
      effectKind: "update-notion-body-exact",
      relativePath: null,
      remoteId: pair.notionPageId,
      allocationId: null,
      expectedByteHash: null,
      expectedSemanticHash: observed.semanticHash,
      resultByteHash: null,
      resultSemanticHash: observed.semanticHash,
      expectedRemoteEditedAt: pair.lastNotionEditedAt,
      createdAt: "2026-07-14T12:34:56.000Z",
    });
    vi.spyOn(harness.notion, "retrievePage").mockResolvedValueOnce({
      ...observed,
      semantic: { ...observed.semantic, bodyMarkdown: "forged body\n" },
      semanticHash: observed.semanticHash,
    });

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "recovery-required", writes: 0, errors: 0 });
    expect(harness.journal.completed.some((entry) => entry.id === intentId)).toBe(false);
  });

  it("fails closed when no persisted pair claims a valid body-recovery page", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("UnclaimedRecovery.md", optedIn("common\n"));
    await harness.apply();
    const pair = Object.values(harness.state.value.pairs)[0];
    if (pair === undefined) throw new Error("synthetic pair was not created");
    const observed = await harness.notion.retrievePage(pair.notionPageId);
    if (observed.kind !== "present") throw new Error("synthetic page disappeared");
    harness.state.value = { ...harness.state.value, pairs: {} };
    const intentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    harness.journal.begun.push({
      schemaVersion: 1,
      id: intentId,
      installationId: "11111111-1111-4111-8111-111111111111",
      effectKind: "update-notion-body-exact",
      relativePath: null,
      remoteId: pair.notionPageId,
      allocationId: null,
      expectedByteHash: null,
      expectedSemanticHash: observed.semanticHash,
      resultByteHash: null,
      resultSemanticHash: observed.semanticHash,
      expectedRemoteEditedAt: pair.lastNotionEditedAt,
      createdAt: "2026-07-14T12:34:56.000Z",
    });
    const beforeCreates = harness.notion.creates;

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "recovery-required", writes: 0, errors: 0 });
    expect(harness.journal.completed.some((entry) => entry.id === intentId)).toBe(false);
    expect(harness.notion.creates).toBe(beforeCreates);
  });
});
