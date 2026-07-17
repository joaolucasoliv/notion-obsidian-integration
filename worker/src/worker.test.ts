import { describe, expect, it, vi } from "vitest";
import { BridgeHarness, optedIn } from "../../tests/fakes/bridge-harness.js";
import { CORTEX_ROOT_ID, FakeCortexTreeApi, RESEARCH_ID } from "../../tests/fakes/cortex-tree-harness.js";

class MovingClock {
  private value = new Date("2026-07-14T12:34:56.000Z").getTime();

  public now(): Date {
    return new Date(this.value);
  }

  public advance(milliseconds: number): void {
    this.value += milliseconds;
  }

  public async sleep(): Promise<void> {}
}

describe("GrandboxBridgeWorker", () => {
  it("reconciles and executes the configured Cortex tree alongside legacy pairs", async () => {
    const events: string[] = [];
    const cortexTree = new FakeCortexTreeApi(events);
    cortexTree.put({
      pageId: CORTEX_ROOT_ID,
      parentPageId: null,
      title: "The Cortex",
      sourceMarkdown: "Cortex root\n",
      editedAt: "2026-07-16T12:00:00.000Z",
    });
    cortexTree.put({
      pageId: RESEARCH_ID,
      parentPageId: CORTEX_ROOT_ID,
      title: "Research",
      sourceMarkdown: "Research note\n",
      editedAt: "2026-07-16T12:00:00.000Z",
    });
    const harness = await BridgeHarness.create({
      cortex: {
        rootPageId: CORTEX_ROOT_ID,
        rootFilePath: "The Cortex.md",
        rootDirectoryPath: "The Cortex",
      },
      cortexTree,
    });
    await harness.writeNote("Legacy.md", optedIn("Legacy bridge note\n"));

    const preview = await harness.preview();

    expect(preview).toMatchObject({ mode: "preview", outcome: "success", planned: 4, writes: 0, errors: 0 });
    expect(events).toContain("remote-discovery");
    await expect(harness.note("The Cortex.md")).rejects.toThrow();

    const applied = await harness.apply();

    expect(applied).toMatchObject({ mode: "apply", outcome: "success", planned: 4, writes: 4, errors: 0 });
    expect(Object.keys(harness.state.value.pairs)).toHaveLength(1);
    expect(harness.state.value.cortex?.pages[CORTEX_ROOT_ID]).toMatchObject({
      pageId: CORTEX_ROOT_ID,
      localPath: "The Cortex.md",
      status: "synced",
    });
    expect(harness.state.value.cortex?.pages[RESEARCH_ID]).toMatchObject({
      pageId: RESEARCH_ID,
      localPath: "The Cortex/Research.md",
      status: "synced",
    });
    await expect(harness.note("The Cortex.md")).resolves.toContain(`cortex_page_id: ${CORTEX_ROOT_ID}`);
    await expect(harness.note("The Cortex/Research.md")).resolves.toContain(`cortex_page_id: ${RESEARCH_ID}`);
  });

  it("retains Cortex state when a verified remote body update loses its journal completion", async () => {
    const events: string[] = [];
    const cortexTree = new FakeCortexTreeApi(events);
    cortexTree.put({
      pageId: CORTEX_ROOT_ID,
      parentPageId: null,
      title: "The Cortex",
      sourceMarkdown: "Cortex root\n",
      editedAt: "2026-07-16T12:00:00.000Z",
    });
    cortexTree.put({
      pageId: RESEARCH_ID,
      parentPageId: CORTEX_ROOT_ID,
      title: "Research",
      sourceMarkdown: "Research note\n",
      editedAt: "2026-07-16T12:00:00.000Z",
    });
    const harness = await BridgeHarness.create({
      cortex: {
        rootPageId: CORTEX_ROOT_ID,
        rootFilePath: "The Cortex.md",
        rootDirectoryPath: "The Cortex",
      },
      cortexTree,
    });
    await harness.apply();
    const local = await harness.note("The Cortex/Research.md");
    await harness.writeNote("The Cortex/Research.md", local.replace("Research note", "Local research update"));

    const complete = harness.journal.complete.bind(harness.journal);
    let interrupted = false;
    vi.spyOn(harness.journal, "complete").mockImplementation(async (id, evidence) => {
      const intent = harness.journal.begun.find((candidate) => candidate.id === id);
      if (!interrupted && intent?.effectKind === "update-cortex-body") {
        interrupted = true;
        throw Object.assign(new Error("synthetic journal completion interruption"), { code: "internal-error" });
      }
      return complete(id, evidence);
    });

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "partial", writes: 1, errors: 1 });
    expect(events.filter((event) => event === "remote-body")).toHaveLength(1);
    await expect(harness.journal.incomplete()).resolves.toEqual([
      expect.objectContaining({ effectKind: "update-cortex-body", cortex: expect.objectContaining({ pageId: RESEARCH_ID }) }),
    ]);
    expect(harness.state.value.cortex?.pages[CORTEX_ROOT_ID]).toMatchObject({ status: "synced" });
    expect(harness.state.value.cortex?.pages[RESEARCH_ID]).toMatchObject({ status: "attention" });
  });

  it("keeps preview side-effect-free while still performing the read-only provider preflight", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Worker.md", optedIn("worker preview\n"));

    const result = await harness.preview();

    expect(result).toMatchObject({ mode: "preview", outcome: "success", planned: 2, writes: 0, errors: 0 });
    expect(harness.notion.verifies).toBe(1);
    expect(harness.journal.begun).toEqual([]);
    expect(harness.state.saves).toBe(0);
    expect(harness.uuid.calls).toBe(0);
  });

  it("does not mutate durable state for scheduled no-ops across distinct clock readings", async () => {
    const clock = new MovingClock();
    const harness = await BridgeHarness.create({ clock });
    await harness.writeNote("Noop.md", optedIn("settled\n"));
    await harness.apply();
    const stateBeforeNoops = structuredClone(harness.state.value);
    const savesBeforeNoops = harness.state.saves;
    const uuidsBeforeNoops = harness.uuid.calls;
    const begunBeforeNoops = harness.journal.begun.length;
    const completedBeforeNoops = harness.journal.completed.length;

    clock.advance(60_000);
    const first = await harness.apply("schedule");
    clock.advance(60_000);
    const second = await harness.apply("schedule");

    expect(first).toMatchObject({ outcome: "noop", planned: 0, writes: 0, errors: 0 });
    expect(second).toMatchObject({ outcome: "noop", planned: 0, writes: 0, errors: 0 });
    expect(harness.state.value).toEqual(stateBeforeNoops);
    expect(harness.state.saves).toBe(savesBeforeNoops);
    expect(harness.uuid.calls).toBe(uuidsBeforeNoops);
    expect(harness.journal.begun).toHaveLength(begunBeforeNoops);
    expect(harness.journal.completed).toHaveLength(completedBeforeNoops);
  });

  it("replaces a stale failed run with a clean no-op result", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Recovered-noop.md", optedIn("settled\n"));
    await harness.apply();
    harness.state.value.lastRun = {
      mode: "apply",
      outcome: "failed",
      planned: 0,
      writes: 0,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      errors: 1,
      graphUploads: 0,
      startedAt: "2026-07-14T12:34:56.000Z",
      completedAt: "2026-07-14T12:34:56.000Z",
    };
    const savesBeforeRecovery = harness.state.saves;

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "noop", planned: 0, writes: 0, errors: 0 });
    expect(harness.state.saves).toBe(savesBeforeRecovery + 1);
    expect(harness.state.value.lastRun).toMatchObject({ outcome: "noop", errors: 0 });
  });

  it("synchronizes an unformatted local soft wrap without leaving a journal intent", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Soft-wrap.md", optedIn("First soft line\nSecond soft line.\n"));

    const first = await harness.apply();
    const second = await harness.apply();

    expect(first).toMatchObject({ outcome: "success", writes: 2, errors: 0 });
    expect(second).toMatchObject({ outcome: "noop", writes: 0, errors: 0 });
    expect(await harness.journal.incomplete()).toEqual([]);
  });

  it("rejects an ambiguous formatted soft wrap before a remote write or incomplete journal intent", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Ambiguous-soft-wrap.md", optedIn("First\n**bold**\n"));

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "failed", planned: 0, writes: 0, errors: 1 });
    expect(harness.notion.creates).toBe(0);
    expect(harness.journal.begun).toHaveLength(1);
    expect(harness.journal.begun[0]?.effectKind).toBe("commit-state");
    expect(harness.journal.completed.map((entry) => entry.id)).toEqual([harness.journal.begun[0]?.id]);
    expect(await harness.journal.incomplete()).toEqual([]);
  });
});
