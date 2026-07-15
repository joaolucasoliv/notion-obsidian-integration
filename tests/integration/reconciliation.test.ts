import { describe, expect, it, vi } from "vitest";
import { BridgeHarness, optedIn } from "../fakes/bridge-harness.js";

describe("reconciliation", () => {
  it("pulls an independently changed Notion body through an exact local baseline", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Remote.md", optedIn("local v1\n"));
    await harness.apply();
    await harness.remoteBodyFor("Remote.md", "remote v2\n");

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "success", pulled: 1, errors: 0 });
    await expect(harness.note("Remote.md")).resolves.toContain("remote v2");
  });

  it("pushes a local body edit, then sends a tag-only edit as managed metadata", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Push.md", optedIn("initial\n", ["alpha"]));
    await harness.apply();
    await harness.writeNote("Push.md", (await harness.note("Push.md")).replace("initial", "local update"));

    const pushed = await harness.apply();

    expect(pushed).toMatchObject({ outcome: "success", pushed: 1, errors: 0 });
    expect(harness.notion.bodyUpdates).toBe(1);
    const bodyUpdateCount = harness.notion.bodyUpdates;
    await harness.writeNote("Push.md", (await harness.note("Push.md")).replace("tags: [alpha]", "tags: [alpha, beta]"));

    const metadata = await harness.apply();

    expect(metadata).toMatchObject({ outcome: "success", pushed: 1, errors: 0 });
    expect(harness.notion.bodyUpdates).toBe(bodyUpdateCount);
    expect(harness.notion.propertyUpdates).toBeGreaterThanOrEqual(1);
  });

  it("preserves Bridge identity across a local rename and updates remote managed properties", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Original.md", optedIn("same body\n"));
    await harness.apply();
    const prior = Object.values(harness.state.value.pairs)[0];
    if (prior === undefined) throw new Error("synthetic pair was not created");
    const createsBeforeRename = harness.notion.creates;
    const propertiesBeforeRename = harness.notion.propertyUpdates;
    await harness.renameNote("Original.md", "Renamed.md");

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "success", pushed: 1, errors: 0 });
    expect(harness.notion.creates).toBe(createsBeforeRename);
    expect(harness.notion.propertyUpdates).toBe(propertiesBeforeRename + 1);
    expect(Object.values(harness.state.value.pairs)).toEqual([
      expect.objectContaining({
        bridgeId: prior.bridgeId,
        notionPageId: prior.notionPageId,
        localPath: "Renamed.md",
      }),
    ]);
    await expect(harness.notion.retrievePage(prior.notionPageId)).resolves.toMatchObject({
      kind: "present",
      managed: { title: "Renamed", obsidianPath: "Renamed.md", status: "synced" },
    });
  });

  it("does not initialize a renamed claimed note when its remote observation is unavailable", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Unavailable.md", optedIn("claimed\n"));
    await harness.apply();
    await harness.renameNote("Unavailable.md", "RenamedUnavailable.md");
    const createsBeforeUnavailableObservation = harness.notion.creates;
    const retrieve = vi.spyOn(harness.notion, "retrievePage").mockRejectedValueOnce(
      Object.assign(new Error("synthetic remote observation failure"), { code: "network-failed", retryable: true }),
    );

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "failed", writes: 0, errors: 1 });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(harness.notion.creates).toBe(createsBeforeUnavailableObservation);
  });

  it("keeps a valid pair moving when an unrelated note is malformed", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Good.md", optedIn("good\n"));
    await harness.writeNote("Broken.md", "---\nnotion_sync: [\n---\nbroken\n");

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "partial", pushed: 1, errors: 1 });
    expect(harness.notion.creates).toBe(1);
  });

  it("does not mark a partial reconciliation as a full reconciliation", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Good.md", optedIn("good\n"));
    await harness.writeNote("Broken.md", "---\nnotion_sync: [\n---\nbroken\n");

    const result = await harness.apply("reconciliation");

    expect(result).toMatchObject({ outcome: "partial", pushed: 1, errors: 1 });
    expect(harness.state.value.lastFullReconciliationAt).toBeNull();
  });
});
