import { describe, expect, it } from "vitest";
import { CortexTreeHarness, CORTEX_ROOT_ID, INSTALLATION_ID, RESEARCH_ID } from "../../tests/fakes/cortex-tree-harness.js";
import { executeCortexTreePlan } from "./cortex/executor.js";
import { planCortexTree } from "./cortex/planner.js";
import { reconcileCortexTree } from "./cortex/reconcile.js";
import { recoverIncompleteJournal } from "./persistence/recovery.js";
import { createCortexRecoveryObserver } from "./worker.js";
import * as workerModule from "./worker.js";

const config = {
  rootPageId: CORTEX_ROOT_ID,
  rootFilePath: "The Cortex.md" as const,
  rootDirectoryPath: "The Cortex" as const,
};

async function plan(harness: CortexTreeHarness, state: ReturnType<CortexTreeHarness["initialState"]>["cortex"]) {
  const reconciliation = await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() });
  return planCortexTree({ config, state, reconciliation, now: () => "2026-07-16T12:00:00.000Z" });
}

function dependencies(harness: CortexTreeHarness) {
  return {
    installationId: INSTALLATION_ID,
    journal: harness.journal,
    notion: harness.notion,
    writer: harness.writer,
    uuid: harness.uuid,
    clock: harness.clock,
    readLocalBytes: (path: string) => harness.readLocalBytes(path),
  };
}

describe("worker Cortex recovery observer", () => {
  it("proves an interrupted ID-bound local rebind after remote page creation", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.putCandidateLocal("The Cortex/Research/Local child.md", "Local child\n");
    const before = harness.initialState((await plan(harness, null)).nextCortex);
    // The remote create completes first; the ID-frontmatter local write reaches
    // disk and then loses its journal completion, just like an interruption.
    harness.journal.failCompletionAttempt = 2;

    const interrupted = await executeCortexTreePlan(
      { state: before, plan: await plan(harness, before.cortex ?? null) },
      dependencies(harness),
    );
    const rebind = (await harness.journal.incomplete()).find((intent) =>
      intent.effectKind === "write-cortex-local" &&
      intent.cortex?.pageId === "77777777-7777-4777-8777-777777777777",
    );
    if (rebind === undefined) throw new Error("missing ID-bound local rebind intent");
    const attention: string[] = [];
    const observer = createCortexRecoveryObserver({
      notion: harness.notion,
      clock: harness.clock,
      readLocalBytes: (path: string) => harness.readLocalBytes(path),
      markAttention: async (intent) => { attention.push(intent.id); },
    });

    const recovery = await recoverIncompleteJournal({
      journal: harness.journal,
      localObserver: { observe: async () => ({ kind: "missing" as const }) },
      remoteObserver: { classify: async () => ({ kind: "unprovable" as const }) },
      cortexObserver: observer,
      now: () => "2026-07-16T12:00:00.000Z",
    });

    expect(interrupted).toMatchObject({ outcome: "attention" });
    expect(recovery).toMatchObject({ status: "reconciled", reconciled: 1 });
    expect(await harness.journal.incomplete()).toEqual([]);
    expect(attention).toEqual([]);
  });

  it("uses the worker's durable parent fallback for an ambiguous ID-bound local rebind without replaying it", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.putCandidateLocal("The Cortex/Research/Local child.md", "Local child\n");
    const before = harness.initialState((await plan(harness, null)).nextCortex);
    harness.writer.failWritePaths.add("The Cortex/Research/Local child.md");
    await executeCortexTreePlan(
      { state: before, plan: await plan(harness, before.cortex ?? null) },
      dependencies(harness),
    );
    const rebind = (await harness.journal.incomplete()).find((intent) =>
      intent.effectKind === "write-cortex-local" &&
      intent.cortex?.pageId === "77777777-7777-4777-8777-777777777777",
    );
    if (rebind === undefined) throw new Error("missing ambiguous ID-bound local rebind");
    const saved: Array<typeof before> = [];
    const stateStore = {
      load: async () => before,
      save: async (state: typeof before) => { saved.push(structuredClone(state)); },
    };
    const workerMarkAttention = Reflect.get(workerModule, "markCortexRecoveryAttention");
    expect(workerMarkAttention).toBeTypeOf("function");
    if (typeof workerMarkAttention !== "function") throw new Error("missing worker attention fallback");
    const markAttention = workerMarkAttention as (
      store: typeof stateStore,
      state: typeof before,
      intent: typeof rebind,
    ) => Promise<void>;
    const observer = createCortexRecoveryObserver({
      notion: harness.notion,
      clock: harness.clock,
      readLocalBytes: (path: string) => harness.readLocalBytes(path),
      markAttention: async (intent) => markAttention(stateStore, before, intent),
    });

    const recovery = await recoverIncompleteJournal({
      journal: harness.journal,
      localObserver: { observe: async () => ({ kind: "missing" as const }) },
      remoteObserver: { classify: async () => ({ kind: "unprovable" as const }) },
      cortexObserver: observer,
      now: () => "2026-07-16T12:00:00.000Z",
    });

    expect(recovery).toMatchObject({ status: "recovery-required", blockedId: rebind.id });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.cortex?.pages[RESEARCH_ID]?.status).toBe("attention");
    expect(saved[0]?.cortex?.pages["77777777-7777-4777-8777-777777777777"]).toBeUndefined();
    expect(await harness.journal.incomplete()).toEqual([rebind]);
    expect(harness.events.filter((event) => event === "remote-create")).toHaveLength(1);
  });

  it("proves a real Cortex postcondition and marks an ambiguous held subtree move without replay", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    const initial = harness.initialState();
    const imported = await executeCortexTreePlan({ state: initial, plan: await plan(harness, null) }, dependencies(harness));
    const attention: string[] = [];
    const observer = createCortexRecoveryObserver({
      notion: harness.notion,
      clock: harness.clock,
      readLocalBytes: (path: string) => harness.readLocalBytes(path),
      markAttention: async (intent) => { attention.push(intent.id); },
    });
    const provenIntent = harness.journal.begun.find((intent) => intent.effectKind === "create-cortex-local" && intent.cortex?.pageId === CORTEX_ROOT_ID);
    if (provenIntent === undefined) throw new Error("missing proven Cortex local-create intent");

    await expect(observer.classify(provenIntent)).resolves.toMatchObject({ kind: "post" });

    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    harness.writer.heldMoveLock = true;
    await executeCortexTreePlan(
      { state: imported.state, plan: await plan(harness, imported.state.cortex ?? null) },
      dependencies(harness),
    );
    const moveIntent = (await harness.journal.incomplete()).find((intent) => intent.effectKind === "move-cortex-subtree");
    if (moveIntent === undefined) throw new Error("missing held Cortex move intent");

    const recovery = await recoverIncompleteJournal({
      journal: harness.journal,
      localObserver: { observe: async () => ({ kind: "missing" as const }) },
      remoteObserver: { classify: async () => ({ kind: "unprovable" as const }) },
      cortexObserver: observer,
      now: () => "2026-07-16T12:00:00.000Z",
    });

    expect(recovery).toMatchObject({ status: "recovery-required", blockedId: moveIntent.id });
    expect(attention).toEqual([moveIntent.id]);
    expect(harness.writer.moveCalls).toEqual([]);
  });
});
