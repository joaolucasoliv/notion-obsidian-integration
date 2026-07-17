import { describe, expect, it } from "vitest";
import { parseJournalCompletion } from "@grandbox-bridge/shared";
import { CortexTreeHarness, ARCHIVE_ID, CORTEX_ROOT_ID, PROJECT_ID, RESEARCH_ID, INSTALLATION_ID } from "../../../tests/fakes/cortex-tree-harness.js";
import { parseCortexLocalNote } from "./frontmatter.js";
import { stripCortexManagedMarkdown } from "./markdown.js";
import { executeCortexTreePlan } from "./executor.js";
import { planCortexTree } from "./planner.js";
import { reconcileCortexTree } from "./reconcile.js";

const config = {
  rootPageId: CORTEX_ROOT_ID,
  rootFilePath: "The Cortex.md" as const,
  rootDirectoryPath: "The Cortex" as const,
};
const CHILD_ID = "abababab-abab-4bab-8bab-abababababab";

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
    persistState: async (state: ReturnType<CortexTreeHarness["initialState"]>) => {
      harness.savedStates.push(structuredClone(state));
    },
  };
}

describe("executeCortexTreePlan", () => {
  it("verifies every first-import mutation, persists only Cortex state, and then plans a repeat no-op", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    const before = harness.initialState();
    const firstPlan = await plan(harness, before.cortex ?? null);

    const result = await executeCortexTreePlan({ state: before, plan: firstPlan }, dependencies(harness));
    const repeat = await plan(harness, result.state.cortex ?? null);

    expect(result.error).toBeNull();
    expect(result.outcome).toBe("success");
    expect(harness.localFiles.has("The Cortex.md")).toBe(true);
    expect(harness.localFiles.has("The Cortex/Research.md")).toBe(true);
    expect(harness.events).toContain("remote-reread");
    expect(harness.events).toContain("local-reread");
    expect(harness.journal.begun).toHaveLength(harness.journal.completed.length);
    expect(result.state.pairs).toEqual(before.pairs);
    expect(harness.savedStates).toHaveLength(1);
    expect(repeat.effects).toEqual([]);
  });

  it("keeps an exact remote body fence when a title update receives a normalized body", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({
      pageId: RESEARCH_ID,
      parentPageId: CORTEX_ROOT_ID,
      title: "Research",
      sourceMarkdown: "First paragraph.\nSecond paragraph.\n",
      editedAt: "2026-07-16T12:00:00.000Z",
    });
    const imported = await executeCortexTreePlan({ state: harness.initialState(), plan: await plan(harness, null) }, dependencies(harness));
    const titleBytes = harness.localFiles.get("The Cortex/Research.md");
    if (titleBytes === undefined) throw new Error("missing imported title fixture");
    harness.localFiles.delete("The Cortex/Research.md");
    harness.localFiles.set("The Cortex/Renamed.md", titleBytes);

    const updateTitle = harness.notion.updateCortexTitle.bind(harness.notion);
    harness.notion.updateCortexTitle = async (input) => {
      await updateTitle(input);
      harness.notion.changeBody(RESEARCH_ID, "First paragraph.\n\nSecond paragraph.\n");
      const observed = await harness.notion.retrieveCortexPage({ rootPageId: input.rootPageId, pageId: input.pageId });
      if (observed === null) throw new Error("missing normalized title response");
      return observed;
    };

    const result = await executeCortexTreePlan(
      { state: imported.state, plan: await plan(harness, imported.state.cortex ?? null) },
      dependencies(harness),
    );

    expect(result).toMatchObject({ outcome: "attention", error: { code: "revision-race" } });
  });

  it("uses the mandatory subtree move writer and records attention without clearing a held lock", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    const before = harness.initialState();
    const imported = await executeCortexTreePlan({ state: before, plan: await plan(harness, null) }, dependencies(harness));
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    harness.writer.heldMoveLock = true;

    const blocked = await executeCortexTreePlan(
      { state: imported.state, plan: await plan(harness, imported.state.cortex ?? null) },
      dependencies(harness),
    );

    expect(blocked.error?.code).toBe("active-lock");
    expect(blocked.outcome).toBe("attention");
    expect(harness.writer.moveCalls).toEqual([]);
    expect(harness.localFiles.has("The Cortex/Research.md")).toBe(true);
    expect(harness.localFiles.has("The Cortex/Renamed.md")).toBe(false);
    expect(blocked.state.cortex?.pages[RESEARCH_ID]?.status).toBe("attention");
  });

  it("persists only verified earlier outcomes when a later subtree move is blocked", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    const before = harness.initialState();
    const imported = await executeCortexTreePlan({ state: before, plan: await plan(harness, null) }, dependencies(harness));
    const priorResearch = imported.state.cortex?.pages[RESEARCH_ID];
    if (priorResearch === undefined) throw new Error("missing imported Research state");
    harness.notion.changeBody(CORTEX_ROOT_ID, "Remote root\n");
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    harness.writer.heldMoveLock = true;
    const failedPlan = await plan(harness, imported.state.cortex ?? null);

    const result = await executeCortexTreePlan({ state: imported.state, plan: failedPlan }, dependencies(harness));

    expect(result).toMatchObject({ outcome: "attention", error: { code: "active-lock" } });
    expect(result.state.cortex?.pages[CORTEX_ROOT_ID]?.lastCommonSemanticHash).toBe(failedPlan.nextCortex?.pages[CORTEX_ROOT_ID]?.lastCommonSemanticHash);
    expect(result.state.cortex?.pages[RESEARCH_ID]).toMatchObject({
      localPath: priorResearch.localPath,
      lastCommonSemanticHash: priorResearch.lastCommonSemanticHash,
      status: "attention",
    });
  });

  it("preserves child-page structure markers during a local root-body update", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    const before = harness.initialState((await plan(harness, null)).nextCortex);
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Local root\n", childPageIds: [RESEARCH_ID] });

    const result = await executeCortexTreePlan(
      { state: before, plan: await plan(harness, before.cortex ?? null) },
      dependencies(harness),
    );

    expect(result).toMatchObject({ outcome: "success", error: null });
    expect(harness.events).toContain("remote-body");
    expect((await plan(harness, result.state.cortex ?? null)).effects).toEqual([]);
  });

  it("rewrites descendant breadcrumbs after a remote parent rename without a second subtree move", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: RESEARCH_ID, title: "Project", sourceMarkdown: "Project\n", editedAt: "2026-07-16T12:00:00.000Z" });
    const before = harness.initialState();
    const imported = await executeCortexTreePlan({ state: before, plan: await plan(harness, null) }, dependencies(harness));
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    const renamePlan = await plan(harness, imported.state.cortex ?? null);

    expect(renamePlan.effects.filter((effect) => effect.kind === "move-cortex-subtree")).toEqual([
      expect.objectContaining({ pageId: RESEARCH_ID, sourcePath: "The Cortex/Research.md", targetPath: "The Cortex/Renamed.md" }),
    ]);
    expect(renamePlan.effects).toContainEqual(expect.objectContaining({
      kind: "write-cortex-local",
      pageId: PROJECT_ID,
      path: "The Cortex/Renamed/Project.md",
    }));
    expect(renamePlan.operations.map((operation) => operation.effect)).toContainEqual(expect.objectContaining({
      kind: "write-cortex-local",
      pageId: PROJECT_ID,
      path: "The Cortex/Renamed/Project.md",
    }));

    const result = await executeCortexTreePlan({ state: imported.state, plan: renamePlan }, dependencies(harness));
    const childBytes = harness.localFiles.get("The Cortex/Renamed/Project.md");
    if (childBytes === undefined) throw new Error("missing moved child");
    const child = parseCortexLocalNote("The Cortex/Renamed/Project.md", childBytes);

    expect(result).toMatchObject({ outcome: "success", error: null });
    expect(stripCortexManagedMarkdown({
      markdown: child.body,
      expectedParentWikiLink: "The Cortex/Renamed.md",
      expectedChildPageIds: [],
    })).toBe("Project\n");
    expect(result.state.cortex?.pages[PROJECT_ID]?.localPath).toBe("The Cortex/Renamed/Project.md");
    expect((await plan(harness, result.state.cortex ?? null)).effects).toEqual([]);
  });

  it("marks every not-yet-rewritten descendant attention at its verified relocated path after a parent move", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: RESEARCH_ID, title: "Project", sourceMarkdown: "Project\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: RESEARCH_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:00:00.000Z" });
    const before = harness.initialState();
    const imported = await executeCortexTreePlan({ state: before, plan: await plan(harness, null) }, dependencies(harness));
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    harness.writer.failWritePaths.add("The Cortex/Renamed/Project.md");

    const result = await executeCortexTreePlan(
      { state: imported.state, plan: await plan(harness, imported.state.cortex ?? null) },
      dependencies(harness),
    );

    expect(result).toMatchObject({ outcome: "attention", error: { code: "revision-race" } });
    expect(harness.writer.moveCalls).toEqual([
      { sourcePath: "The Cortex/Research.md", targetPath: "The Cortex/Renamed.md" },
    ]);
    expect(result.state.cortex?.pages[PROJECT_ID]).toMatchObject({
      localPath: "The Cortex/Renamed/Project.md",
      status: "attention",
    });
    expect(result.state.cortex?.pages[ARCHIVE_ID]).toMatchObject({
      localPath: "The Cortex/Renamed/Archive.md",
      status: "attention",
    });
    expect(harness.localFiles.has("The Cortex/Renamed/Archive.md")).toBe(true);
    expect(harness.localFiles.has("The Cortex/Research/Archive.md")).toBe(false);
    expect(result.state.pairs).toEqual(before.pairs);
  });

  it("keeps an attention-held nested reparent at the verified predecessor relocation instead of its projected future path", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: RESEARCH_ID, title: "Project", sourceMarkdown: "Project\n", editedAt: "2026-07-16T12:00:00.000Z" });
    const before = harness.initialState();
    const imported = await executeCortexTreePlan({ state: before, plan: await plan(harness, null) }, dependencies(harness));
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    harness.notion.changeParent(PROJECT_ID, ARCHIVE_ID);
    const nestedPlan = await plan(harness, imported.state.cortex ?? null);

    const result = await executeCortexTreePlan({ state: imported.state, plan: nestedPlan }, dependencies(harness));

    expect(result).toMatchObject({ outcome: "attention", error: null });
    expect(harness.writer.moveCalls).toEqual([
      { sourcePath: "The Cortex/Research.md", targetPath: "The Cortex/Renamed.md" },
    ]);
    expect(result.state.cortex?.pages[PROJECT_ID]).toMatchObject({
      localPath: "The Cortex/Renamed/Project.md",
      status: "attention",
    });
    expect(result.state.cortex?.pages[PROJECT_ID]?.localPath).not.toBe("The Cortex/Archive/Project.md");
    expect(harness.localFiles.has("The Cortex/Renamed/Project.md")).toBe(true);
    expect(harness.localFiles.has("The Cortex/Archive/Project.md")).toBe(false);
  });

  it("executes only the conflict artifact when a parent rename is conflicted and leaves its unchanged child at the durable path", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: RESEARCH_ID, title: "Project", sourceMarkdown: "Project\n", editedAt: "2026-07-16T12:00:00.000Z" });
    const imported = await executeCortexTreePlan({ state: harness.initialState(), plan: await plan(harness, null) }, dependencies(harness));
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Local Research\n", childPageIds: [PROJECT_ID] });
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    const blockedPlan = await plan(harness, imported.state.cortex ?? null);

    const result = await executeCortexTreePlan({ state: imported.state, plan: blockedPlan }, dependencies(harness));

    expect(result).toMatchObject({ outcome: "attention", error: null });
    expect(harness.writer.moveCalls).toEqual([]);
    expect(harness.events.filter((event) => event === "local-write")).toEqual([]);
    expect(result.state.cortex?.pages[PROJECT_ID]).toMatchObject({
      localPath: "The Cortex/Research/Project.md",
      status: "attention",
    });
    expect(harness.localFiles.has("The Cortex/Research/Project.md")).toBe(true);
    expect(harness.localFiles.has("The Cortex/Renamed/Project.md")).toBe(false);
  });

  it("keeps a nested child behind its direct-reparent barrier after the ancestor move succeeds", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: RESEARCH_ID, title: "Project", sourceMarkdown: "Project\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: CHILD_ID, parentPageId: PROJECT_ID, title: "Child", sourceMarkdown: "Child\n", editedAt: "2026-07-16T12:00:00.000Z" });
    const imported = await executeCortexTreePlan({ state: harness.initialState(), plan: await plan(harness, null) }, dependencies(harness));
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    harness.notion.changeParent(PROJECT_ID, ARCHIVE_ID);
    const blockedPlan = await plan(harness, imported.state.cortex ?? null);

    const result = await executeCortexTreePlan({ state: imported.state, plan: blockedPlan }, dependencies(harness));

    expect(result).toMatchObject({ outcome: "attention", error: null });
    expect(harness.writer.moveCalls).toEqual([
      { sourcePath: "The Cortex/Research.md", targetPath: "The Cortex/Renamed.md" },
    ]);
    for (const [pageId, path] of [
      [PROJECT_ID, "The Cortex/Renamed/Project.md"],
      [CHILD_ID, "The Cortex/Renamed/Project/Child.md"],
    ] as const) {
      expect(result.state.cortex?.pages[pageId]).toMatchObject({ localPath: path, status: "attention" });
    }
    expect(harness.localFiles.has("The Cortex/Archive/Project/Child.md")).toBe(false);
  });

  it("journals a root conflict artifact without treating its artifact path as the root page path", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n" });
    const before = harness.initialState((await plan(harness, null)).nextCortex);
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Local root\n" });
    harness.notion.changeBody(CORTEX_ROOT_ID, "Remote root\n");

    const result = await executeCortexTreePlan(
      { state: before, plan: await plan(harness, before.cortex ?? null) },
      dependencies(harness),
    );
    const artifactPath = `The Cortex/.conflicts/${CORTEX_ROOT_ID}.conflict.md`;

    expect(result).toMatchObject({ outcome: "conflict", error: null });
    expect(harness.localFiles.has(artifactPath)).toBe(true);
    expect(harness.journal.begun).toHaveLength(1);
    expect(harness.journal.begun[0]).toMatchObject({
      effectKind: "create-cortex-conflict",
      cortex: { pageId: CORTEX_ROOT_ID, targetPath: artifactPath },
    });
    expect(harness.journal.completed).toHaveLength(1);
    expect(result.state.cortex?.pages[CORTEX_ROOT_ID]?.status).toBe("conflict");
  });

  it("keeps a completed conflict artifact from advancing its original page when a later sibling fails", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID, ARCHIVE_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.putOwnedLocal({ path: "The Cortex/Archive.md", pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Archive\n" });
    const before = harness.initialState((await plan(harness, null)).nextCortex);
    const priorResearch = before.cortex?.pages[RESEARCH_ID];
    if (priorResearch === undefined) throw new Error("missing Research state");
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Local research\n" });
    harness.notion.changeBody(RESEARCH_ID, "Remote research\n");
    harness.notion.changeBody(ARCHIVE_ID, "Remote archive\n");
    harness.writer.failWritePaths.add("The Cortex/Archive.md");

    const result = await executeCortexTreePlan(
      { state: before, plan: await plan(harness, before.cortex ?? null) },
      dependencies(harness),
    );

    expect(result).toMatchObject({ outcome: "attention", error: { code: "revision-race" } });
    expect(harness.localFiles.has(`The Cortex/.conflicts/${RESEARCH_ID}.conflict.md`)).toBe(true);
    expect(result.state.cortex?.pages[RESEARCH_ID]).toMatchObject({
      localPath: "The Cortex/Research.md",
      status: "conflict",
      lastCommonSemanticHash: priorResearch.lastCommonSemanticHash,
      lastCommonStructureHash: priorResearch.lastCommonStructureHash,
    });
    expect(harness.localFiles.has("The Cortex/Research.md")).toBe(true);
  });

  it("creates a bare local child remotely, journals ID-bound local completion, and reaches a repeat no-op", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.putCandidateLocal("The Cortex/Research/Local child.md", "Local child\n");
    const before = harness.initialState((await plan(harness, null)).nextCortex);
    const candidatePlan = await plan(harness, before.cortex ?? null);

    const result = await executeCortexTreePlan({ state: before, plan: candidatePlan }, dependencies(harness));
    const repeat = await plan(harness, result.state.cortex ?? null);

    expect(result).toMatchObject({ outcome: "success", error: null });
    expect(harness.events).toContain("remote-create");
    expect(harness.localFiles.get("The Cortex/Research.md")).toContain("<!-- grandbox-cortex:child-page:77777777-7777-4777-8777-777777777777 -->");
    expect(harness.journal.begun.map((intent) => intent.effectKind)).toEqual([
      "create-cortex-page",
      "write-cortex-local",
      "write-cortex-local",
    ]);
    expect(harness.journal.begun[1]?.cortex?.expectedPostcondition).toMatchObject({
      pageId: "77777777-7777-4777-8777-777777777777",
      relativePath: "The Cortex/Research/Local child.md",
    });
    expect(repeat.error).toBeNull();
    expect(repeat.effects).toEqual([]);
  });

  it("anchors a failed ID-bound local rebind on its known parent without fabricating the new page state", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.putCandidateLocal("The Cortex/Research/Local child.md", "Local child\n");
    const before = harness.initialState((await plan(harness, null)).nextCortex);
    harness.writer.failWritePaths.add("The Cortex/Research/Local child.md");

    const result = await executeCortexTreePlan(
      { state: before, plan: await plan(harness, before.cortex ?? null) },
      dependencies(harness),
    );
    const incomplete = await harness.journal.incomplete();

    expect(result).toMatchObject({ outcome: "attention", error: { code: "revision-race" } });
    expect(result.state.cortex?.pages[RESEARCH_ID]?.status).toBe("attention");
    expect(result.state.cortex?.pages["77777777-7777-4777-8777-777777777777"]).toBeUndefined();
    expect(result.state.pairs).toEqual(before.pairs);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toMatchObject({
      effectKind: "write-cortex-local",
      cortex: {
        pageId: "77777777-7777-4777-8777-777777777777",
        expectedPostcondition: { parentPageId: RESEARCH_ID },
      },
    });
    expect(harness.events.filter((event) => event === "remote-create")).toHaveLength(1);
  });

  it("anchors a remotely-created page with a lost create response on its known parent and leaves its allocation journal pending", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.putCandidateLocal("The Cortex/Research/Local child.md", "Local child\n");
    const before = harness.initialState((await plan(harness, null)).nextCortex);
    harness.notion.throwAfterCreate = true;

    const result = await executeCortexTreePlan(
      { state: before, plan: await plan(harness, before.cortex ?? null) },
      dependencies(harness),
    );
    const incomplete = await harness.journal.incomplete();

    expect(result).toMatchObject({ outcome: "attention", error: { code: "network-failed", retryable: true } });
    expect(result.state.cortex?.pages[RESEARCH_ID]?.status).toBe("attention");
    expect(result.state.cortex?.pages["77777777-7777-4777-8777-777777777777"]).toBeUndefined();
    expect(result.state.pairs).toEqual(before.pairs);
    expect(harness.journal.completed).toEqual([]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toMatchObject({
      effectKind: "create-cortex-page",
      cortex: { pageId: null, expectedPostcondition: { parentPageId: RESEARCH_ID } },
    });
    expect(harness.events.filter((event) => event === "remote-create")).toHaveLength(1);
  });

  it("completes the truthful create and ID-bound local journals before a later parent-marker interruption", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.putCandidateLocal("The Cortex/Research/Local child.md", "Local child\n");
    const before = harness.initialState((await plan(harness, null)).nextCortex);
    harness.writer.failWritePaths.add("The Cortex/Research.md");

    const result = await executeCortexTreePlan({ state: before, plan: await plan(harness, before.cortex ?? null) }, dependencies(harness));
    const intents = harness.journal.begun;
    const incomplete = await harness.journal.incomplete();

    expect(result.outcome).toBe("attention");
    expect(intents.map((intent) => intent.effectKind)).toEqual([
      "create-cortex-page",
      "write-cortex-local",
      "write-cortex-local",
    ]);
    expect(harness.journal.completed.map((entry) => entry.id)).toEqual([intents[0]?.id, intents[1]?.id]);
    expect(intents[1]?.cortex?.expectedPostcondition).toMatchObject({
      pageId: "77777777-7777-4777-8777-777777777777",
      relativePath: "The Cortex/Research/Local child.md",
    });
    expect(incomplete.map((intent) => intent.id)).toEqual([intents[2]?.id]);
  });

  it("does not create a new local child beneath a root structural conflict", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    const before = harness.initialState((await plan(harness, null)).nextCortex);

    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Local root\n", childPageIds: [RESEARCH_ID] });
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:01:00.000Z" });
    const result = await executeCortexTreePlan(
      { state: before, plan: await plan(harness, before.cortex ?? null) },
      dependencies(harness),
    );

    expect(result).toMatchObject({ outcome: "attention", error: null });
    expect(harness.localFiles.has(`The Cortex/.conflicts/${CORTEX_ROOT_ID}.conflict.md`)).toBe(true);
    expect(harness.localFiles.has("The Cortex/Archive.md")).toBe(false);
    expect(harness.journal.begun.some((intent) => intent.effectKind === "create-cortex-local" && intent.cortex?.pageId === ARCHIVE_ID)).toBe(false);
    expect(result.state.cortex?.pages[CORTEX_ROOT_ID]?.status).toBe("conflict");
    expect(result.state.cortex?.pages[ARCHIVE_ID]?.status).toBe("attention");
  });

  it("defers a candidate under a planned parent subtree move until the relocated reconciliation", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.putCandidateLocal("The Cortex/Research/Local child.md", "Local child\n");
    const before = harness.initialState((await plan(harness, null)).nextCortex);

    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    const firstPlan = await plan(harness, before.cortex ?? null);
    expect(firstPlan.effects).toContainEqual(expect.objectContaining({ kind: "move-cortex-subtree", pageId: RESEARCH_ID }));
    expect(firstPlan.effects.some((effect) => effect.kind === "create-cortex-page")).toBe(false);

    const first = await executeCortexTreePlan({ state: before, plan: firstPlan }, dependencies(harness));
    const secondPlan = await plan(harness, first.state.cortex ?? null);
    const second = await executeCortexTreePlan({ state: first.state, plan: secondPlan }, dependencies(harness));
    const repeat = await plan(harness, second.state.cortex ?? null);

    expect(first).toMatchObject({ outcome: "success", error: null });
    expect(harness.events.filter((event) => event === "remote-create")).toHaveLength(1);
    expect(harness.journal.begun.filter((intent) => intent.effectKind === "create-cortex-page")).toHaveLength(1);
    expect(second).toMatchObject({ outcome: "success", error: null });
    expect(harness.localFiles.has("The Cortex/Renamed/Local child.md")).toBe(true);
    expect(repeat.effects).toEqual([]);
  });

  it("retains a verified subtree move after its journal completion fails", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: RESEARCH_ID, title: "Project", sourceMarkdown: "Project\n", editedAt: "2026-07-16T12:00:00.000Z" });
    const imported = await executeCortexTreePlan({ state: harness.initialState(), plan: await plan(harness, null) }, dependencies(harness));

    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    harness.journal.failCompletionAttempt = harness.journal.completed.length + 1;
    const result = await executeCortexTreePlan(
      { state: imported.state, plan: await plan(harness, imported.state.cortex ?? null) },
      dependencies(harness),
    );
    const incomplete = await harness.journal.incomplete();

    expect(result).toMatchObject({ outcome: "attention", error: { code: "internal-error" } });
    expect(harness.writer.moveCalls).toEqual([
      { sourcePath: "The Cortex/Research.md", targetPath: "The Cortex/Renamed.md" },
    ]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toMatchObject({ effectKind: "move-cortex-subtree", cortex: { pageId: RESEARCH_ID } });
    expect(result.state.cortex?.pages[RESEARCH_ID]).toMatchObject({ localPath: "The Cortex/Renamed.md", status: "attention" });
    expect(result.state.cortex?.pages[PROJECT_ID]).toMatchObject({ localPath: "The Cortex/Renamed/Project.md", status: "attention" });
    expect(harness.localFiles.has("The Cortex/Research/Project.md")).toBe(false);
    expect(harness.localFiles.has("The Cortex/Renamed/Project.md")).toBe(true);
  });

  it("retains a verified conflict artifact when its journal completion fails", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n" });
    const before = harness.initialState((await plan(harness, null)).nextCortex);
    const priorRoot = before.cortex?.pages[CORTEX_ROOT_ID];
    if (priorRoot === undefined) throw new Error("missing root state");

    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Local root\n" });
    harness.notion.changeBody(CORTEX_ROOT_ID, "Remote root\n");
    harness.journal.failCompletionAttempt = 1;
    const result = await executeCortexTreePlan(
      { state: before, plan: await plan(harness, before.cortex ?? null) },
      dependencies(harness),
    );
    const incomplete = await harness.journal.incomplete();
    const pending = incomplete[0];
    if (pending === undefined) throw new Error("missing conflict journal");
    await harness.journal.complete(pending.id, parseJournalCompletion({
      schemaVersion: 1,
      resultByteHash: null,
      resultSemanticHash: null,
      resultRemoteId: CORTEX_ROOT_ID,
      allocatedBridgeId: null,
      observedRemoteEditedAt: null,
      completedAt: "2026-07-16T12:00:00.000Z",
    }));
    const repeat = await plan(harness, result.state.cortex ?? null);

    expect(result).toMatchObject({ outcome: "attention", error: { code: "internal-error" } });
    expect(harness.localFiles.has(`The Cortex/.conflicts/${CORTEX_ROOT_ID}.conflict.md`)).toBe(true);
    expect(result.state.cortex?.pages[CORTEX_ROOT_ID]).toMatchObject({
      localPath: "The Cortex.md",
      status: "conflict",
      lastCommonSemanticHash: priorRoot.lastCommonSemanticHash,
      lastCommonStructureHash: priorRoot.lastCommonStructureHash,
    });
    expect(harness.journal.completed.map((entry) => entry.id)).toEqual([pending.id]);
    expect(repeat.effects.some((effect) => effect.kind === "create-cortex-conflict")).toBe(false);
  });

  it("retains a completed candidate rebind when the later parent-marker completion fails", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.putCandidateLocal("The Cortex/Research/Local child.md", "Local child\n");
    const before = harness.initialState((await plan(harness, null)).nextCortex);
    harness.journal.failCompletionAttempt = 3;

    const result = await executeCortexTreePlan(
      { state: before, plan: await plan(harness, before.cortex ?? null) },
      dependencies(harness),
    );
    const intents = harness.journal.begun;
    const incomplete = await harness.journal.incomplete();

    expect(result).toMatchObject({ outcome: "attention", error: { code: "internal-error" } });
    expect(result.state.cortex?.pages["77777777-7777-4777-8777-777777777777"]).toMatchObject({
      localPath: "The Cortex/Research/Local child.md",
      status: "synced",
    });
    expect(result.state.cortex?.pages[RESEARCH_ID]?.status).toBe("attention");
    expect(harness.journal.completed.map((entry) => entry.id)).toEqual([intents[0]?.id, intents[1]?.id]);
    expect(incomplete.map((intent) => intent.id)).toEqual([intents[2]?.id]);
  });
});
