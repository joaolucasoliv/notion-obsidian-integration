import { describe, expect, it } from "vitest";
import { CortexTreeHarness, ARCHIVE_ID, CORTEX_ROOT_ID, PROJECT_ID, RESEARCH_ID } from "../../../tests/fakes/cortex-tree-harness.js";
import { parseCortexLocalNote } from "./frontmatter.js";
import { stripCortexManagedMarkdown } from "./markdown.js";
import { planCortexTree } from "./planner.js";
import { reconcileCortexTree } from "./reconcile.js";

const config = {
  rootPageId: CORTEX_ROOT_ID,
  rootFilePath: "The Cortex.md" as const,
  rootDirectoryPath: "The Cortex" as const,
};
const CHILD_ID = "abababab-abab-4bab-8bab-abababababab";

async function initialPlan(harness: CortexTreeHarness) {
  const reconciliation = await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() });
  return planCortexTree({ config, state: null, reconciliation, now: () => "2026-07-16T12:00:00.000Z" });
}

function seedPairedTree(harness: CortexTreeHarness, includeArchive = false): void {
  harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
  if (includeArchive) {
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:00:00.000Z" });
  }
  harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
  harness.putOwnedLocal({
    path: "The Cortex.md",
    pageId: CORTEX_ROOT_ID,
    parentPageId: null,
    parentPath: null,
    body: "Root\n",
    childPageIds: includeArchive ? [ARCHIVE_ID, RESEARCH_ID] : [RESEARCH_ID],
  });
  if (includeArchive) {
    harness.putOwnedLocal({ path: "The Cortex/Archive.md", pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Archive\n" });
  }
  harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
}

describe("planCortexTree", () => {
  it("plans parent-before-child local creation deterministically for a first nested remote import", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: RESEARCH_ID, title: "Project", sourceMarkdown: "Project\n", editedAt: "2026-07-16T12:00:00.000Z" });

    const first = await initialPlan(harness);
    const second = await initialPlan(harness);

    expect(first.error).toBeNull();
    expect(first.effects.map((effect) => effect.kind)).toEqual([
      "create-cortex-local",
      "create-cortex-local",
      "create-cortex-local",
    ]);
    expect(first.effects.map((effect) => "path" in effect ? effect.path : null)).toEqual([
      "The Cortex.md",
      "The Cortex/Research.md",
      "The Cortex/Research/Project.md",
    ]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("plans a remote create only for a bare local child of a paired parent", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.putCandidateLocal("The Cortex/Research/Local child.md", "Local child\n");

    const scanned = await harness.scan();
    const rootEntry = scanned[0];
    if (rootEntry?.kind !== "owned") throw new Error("fixture did not create an owned root");
    const rootLocal = parseCortexLocalNote(rootEntry.path, rootEntry.note.bytes);
    expect(stripCortexManagedMarkdown({
      markdown: rootLocal.body,
      expectedParentWikiLink: null,
      expectedChildPageIds: [RESEARCH_ID],
    })).toBe("Root\n");
    const reconciliation = await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() });
    expect(reconciliation).toMatchObject({ error: null, canClassifyAbsence: true, invalidPaths: [] });
    const plan = await planCortexTree({ config, state: null, reconciliation, now: () => "2026-07-16T12:00:00.000Z" });

    expect(plan.error).toBeNull();
    expect(plan.effects.map((effect) => effect.kind)).toContain("create-cortex-page");
    expect(plan.effects.some((effect) => effect.kind === "create-cortex-local" && "path" in effect && effect.path === "The Cortex.md")).toBe(false);
  });

  it("plans body, title, and parent mutations in both directions without last-writer-wins", async () => {
    const localBody = new CortexTreeHarness();
    seedPairedTree(localBody);
    const localBodyState = (await initialPlan(localBody)).nextCortex;
    localBody.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Local body\n" });
    const localBodyPlan = await planCortexTree({
      config,
      state: localBodyState,
      reconciliation: await reconcileCortexTree(config, { notion: localBody.notion, scan: () => localBody.scan() }),
      now: () => "2026-07-16T12:00:00.000Z",
    });
    expect(localBodyPlan.effects).toContainEqual(expect.objectContaining({ kind: "update-cortex-body", pageId: RESEARCH_ID }));

    const remoteBody = new CortexTreeHarness();
    seedPairedTree(remoteBody);
    const remoteBodyState = (await initialPlan(remoteBody)).nextCortex;
    remoteBody.notion.changeBody(RESEARCH_ID, "Remote body\n");
    const remoteBodyPlan = await planCortexTree({
      config,
      state: remoteBodyState,
      reconciliation: await reconcileCortexTree(config, { notion: remoteBody.notion, scan: () => remoteBody.scan() }),
      now: () => "2026-07-16T12:00:00.000Z",
    });
    expect(remoteBodyPlan.effects).toContainEqual(expect.objectContaining({ kind: "write-cortex-local", pageId: RESEARCH_ID }));

    const localTitle = new CortexTreeHarness();
    seedPairedTree(localTitle);
    const localTitleState = (await initialPlan(localTitle)).nextCortex;
    const titleBytes = localTitle.localFiles.get("The Cortex/Research.md");
    if (titleBytes === undefined) throw new Error("missing title fixture");
    localTitle.localFiles.delete("The Cortex/Research.md");
    localTitle.localFiles.set("The Cortex/Renamed.md", titleBytes);
    const localTitlePlan = await planCortexTree({
      config,
      state: localTitleState,
      reconciliation: await reconcileCortexTree(config, { notion: localTitle.notion, scan: () => localTitle.scan() }),
      now: () => "2026-07-16T12:00:00.000Z",
    });
    expect(localTitlePlan.effects).toContainEqual(expect.objectContaining({ kind: "update-cortex-title", pageId: RESEARCH_ID, title: "Renamed" }));

    const remoteTitle = new CortexTreeHarness();
    seedPairedTree(remoteTitle);
    const remoteTitleState = (await initialPlan(remoteTitle)).nextCortex;
    remoteTitle.notion.changeTitle(RESEARCH_ID, "Renamed");
    const remoteTitlePlan = await planCortexTree({
      config,
      state: remoteTitleState,
      reconciliation: await reconcileCortexTree(config, { notion: remoteTitle.notion, scan: () => remoteTitle.scan() }),
      now: () => "2026-07-16T12:00:00.000Z",
    });
    expect(remoteTitlePlan.effects).toContainEqual(expect.objectContaining({ kind: "move-cortex-subtree", pageId: RESEARCH_ID }));

    const localMove = new CortexTreeHarness();
    seedPairedTree(localMove, true);
    const localMoveState = (await initialPlan(localMove)).nextCortex;
    localMove.localFiles.delete("The Cortex/Research.md");
    localMove.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [ARCHIVE_ID] });
    localMove.putOwnedLocal({ path: "The Cortex/Archive.md", pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Archive\n", childPageIds: [RESEARCH_ID] });
    localMove.putOwnedLocal({ path: "The Cortex/Archive/Research.md", pageId: RESEARCH_ID, parentPageId: ARCHIVE_ID, parentPath: "The Cortex/Archive.md", body: "Research\n" });
    const localMovePlan = await planCortexTree({
      config,
      state: localMoveState,
      reconciliation: await reconcileCortexTree(config, { notion: localMove.notion, scan: () => localMove.scan() }),
      now: () => "2026-07-16T12:00:00.000Z",
    });
    expect(localMovePlan.effects).toContainEqual(expect.objectContaining({ kind: "move-cortex-page", pageId: RESEARCH_ID, parentPageId: ARCHIVE_ID }));

    const remoteMove = new CortexTreeHarness();
    seedPairedTree(remoteMove, true);
    remoteMove.putOwnedLocal({
      path: "The Cortex.md",
      pageId: CORTEX_ROOT_ID,
      parentPageId: null,
      parentPath: null,
      body: "Root\n",
      childPageIds: [RESEARCH_ID, ARCHIVE_ID],
    });
    const remoteMoveState = (await initialPlan(remoteMove)).nextCortex;
    remoteMove.notion.changeParent(RESEARCH_ID, ARCHIVE_ID);
    const remoteMovePlan = await planCortexTree({
      config,
      state: remoteMoveState,
      reconciliation: await reconcileCortexTree(config, { notion: remoteMove.notion, scan: () => remoteMove.scan() }),
      now: () => "2026-07-16T12:00:00.000Z",
    });
    expect(remoteMovePlan.effects).toContainEqual(expect.objectContaining({ kind: "move-cortex-subtree", pageId: RESEARCH_ID }));
  });

  it("fails a direct child reparent beneath a moving ancestor closed instead of scheduling a stale second subtree move", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: RESEARCH_ID, title: "Project", sourceMarkdown: "Project\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID, ARCHIVE_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n", childPageIds: [PROJECT_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Archive.md", pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Archive\n" });
    harness.putOwnedLocal({ path: "The Cortex/Research/Project.md", pageId: PROJECT_ID, parentPageId: RESEARCH_ID, parentPath: "The Cortex/Research.md", body: "Project\n" });
    const state = (await initialPlan(harness)).nextCortex;
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    harness.notion.changeParent(PROJECT_ID, ARCHIVE_ID);
    const reconciliation = await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() });

    const first = await planCortexTree({ config, state, reconciliation, now: () => "2026-07-16T12:00:00.000Z" });
    const second = await planCortexTree({ config, state, reconciliation, now: () => "2026-07-16T12:00:00.000Z" });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.effects).toContainEqual(expect.objectContaining({
      kind: "move-cortex-subtree",
      pageId: RESEARCH_ID,
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Renamed.md",
    }));
    expect(first.pages.find((page) => page.pageId === PROJECT_ID)).toMatchObject({
      action: "attention",
      error: { code: "identity-collision" },
    });
    expect(first.nextCortex?.pages[PROJECT_ID]).toMatchObject({
      localPath: "The Cortex/Research/Project.md",
      status: "attention",
    });
    expect(first.effects.some((effect) => effect.kind === "move-cortex-subtree" && effect.pageId === PROJECT_ID)).toBe(false);
    expect(first.effects.some((effect) => effect.kind === "write-cortex-local" && effect.pageId === PROJECT_ID)).toBe(false);
  });

  it("propagates a conflicted parent rename barrier to an unchanged descendant instead of writing its projected path", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: RESEARCH_ID, title: "Project", sourceMarkdown: "Project\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n", childPageIds: [PROJECT_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research/Project.md", pageId: PROJECT_ID, parentPageId: RESEARCH_ID, parentPath: "The Cortex/Research.md", body: "Project\n" });
    const state = (await initialPlan(harness)).nextCortex;
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Local Research\n", childPageIds: [PROJECT_ID] });
    harness.putCandidateLocal("The Cortex/Research/Project/Local child.md", "Local child\n");
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    const reconciliation = await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() });

    const plan = await planCortexTree({ config, state, reconciliation, now: () => "2026-07-16T12:00:00.000Z" });

    expect(plan.pages.find((page) => page.pageId === RESEARCH_ID)).toMatchObject({ action: "conflict" });
    expect(plan.pages.find((page) => page.pageId === PROJECT_ID)).toMatchObject({ action: "attention" });
    expect(plan.nextCortex?.pages[PROJECT_ID]).toMatchObject({
      localPath: "The Cortex/Research/Project.md",
      status: "attention",
    });
    expect(plan.effects.some((effect) => effect.kind === "move-cortex-subtree" && effect.pageId === PROJECT_ID)).toBe(false);
    expect(plan.effects.some((effect) => effect.kind === "write-cortex-local" && effect.pageId === PROJECT_ID)).toBe(false);
    expect(plan.effects.some((effect) => effect.kind === "create-cortex-page" && effect.parentPageId === PROJECT_ID)).toBe(false);
  });

  it("does not invent a withheld relocation when local and remote rename already converge at the target path", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    const state = (await initialPlan(harness)).nextCortex;
    harness.localFiles.delete("The Cortex/Research.md");
    harness.putOwnedLocal({ path: "The Cortex/Renamed.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");

    const plan = await planCortexTree({
      config,
      state,
      reconciliation: await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() }),
      now: () => "2026-07-16T12:00:00.000Z",
    });

    expect(plan.effects).toEqual([]);
    expect(plan.pages.find((page) => page.pageId === RESEARCH_ID)).toMatchObject({ action: "noop" });
    expect(plan.nextCortex?.pages[RESEARCH_ID]).toMatchObject({
      localPath: "The Cortex/Renamed.md",
      status: "synced",
    });
  });

  it("holds a newly discovered remote child behind its blocked parent relocation", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    const state = (await initialPlan(harness)).nextCortex;
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Local Research\n" });
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    harness.putRemote({ pageId: CHILD_ID, parentPageId: RESEARCH_ID, title: "Remote child", sourceMarkdown: "Remote child\n", editedAt: "2026-07-16T12:00:00.000Z" });

    const plan = await planCortexTree({
      config,
      state,
      reconciliation: await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() }),
      now: () => "2026-07-16T12:00:00.000Z",
    });

    expect(plan.pages.find((page) => page.pageId === RESEARCH_ID)).toMatchObject({ action: "conflict" });
    expect(plan.pages.find((page) => page.pageId === CHILD_ID)).toMatchObject({ action: "attention" });
    expect(plan.effects.some((effect) => effect.kind === "create-cortex-local" && effect.pageId === CHILD_ID)).toBe(false);
    expect(plan.nextCortex?.pages[CHILD_ID]).toMatchObject({ status: "attention" });
  });

  it("holds an existing page reparented into a blocked root behind both ancestry views", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: ARCHIVE_ID, title: "Project", sourceMarkdown: "Project\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID, ARCHIVE_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.putOwnedLocal({ path: "The Cortex/Archive.md", pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Archive\n", childPageIds: [PROJECT_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Archive/Project.md", pageId: PROJECT_ID, parentPageId: ARCHIVE_ID, parentPath: "The Cortex/Archive.md", body: "Project\n" });
    const state = (await initialPlan(harness)).nextCortex;
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Local Research\n" });
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    harness.notion.changeParent(PROJECT_ID, RESEARCH_ID);

    const plan = await planCortexTree({
      config,
      state,
      reconciliation: await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() }),
      now: () => "2026-07-16T12:00:00.000Z",
    });

    expect(plan.pages.find((page) => page.pageId === RESEARCH_ID)).toMatchObject({ action: "conflict" });
    expect(plan.pages.find((page) => page.pageId === PROJECT_ID)).toMatchObject({ action: "attention" });
    expect(plan.nextCortex?.pages[PROJECT_ID]).toMatchObject({
      localPath: "The Cortex/Archive/Project.md",
      status: "attention",
    });
    expect(plan.effects.some((effect) => effect.kind === "move-cortex-subtree" && effect.pageId === PROJECT_ID)).toBe(false);
    expect(plan.effects.some((effect) => effect.kind === "write-cortex-local" && effect.pageId === PROJECT_ID)).toBe(false);
  });

  it("propagates a held direct reparent barrier through every nested descendant", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: RESEARCH_ID, title: "Project", sourceMarkdown: "Project\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: CHILD_ID, parentPageId: PROJECT_ID, title: "Child", sourceMarkdown: "Child\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID, ARCHIVE_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n", childPageIds: [PROJECT_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Archive.md", pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Archive\n" });
    harness.putOwnedLocal({ path: "The Cortex/Research/Project.md", pageId: PROJECT_ID, parentPageId: RESEARCH_ID, parentPath: "The Cortex/Research.md", body: "Project\n", childPageIds: [CHILD_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research/Project/Child.md", pageId: CHILD_ID, parentPageId: PROJECT_ID, parentPath: "The Cortex/Research/Project.md", body: "Child\n" });
    const state = (await initialPlan(harness)).nextCortex;
    harness.notion.changeTitle(RESEARCH_ID, "Renamed");
    harness.notion.changeParent(PROJECT_ID, ARCHIVE_ID);
    const reconciliation = await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() });

    const plan = await planCortexTree({ config, state, reconciliation, now: () => "2026-07-16T12:00:00.000Z" });

    expect(plan.effects).toContainEqual(expect.objectContaining({
      kind: "move-cortex-subtree",
      pageId: RESEARCH_ID,
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Renamed.md",
    }));
    for (const pageId of [PROJECT_ID, CHILD_ID]) {
      expect(plan.pages.find((page) => page.pageId === pageId)).toMatchObject({ action: "attention" });
    }
    expect(plan.nextCortex?.pages[CHILD_ID]).toMatchObject({
      localPath: "The Cortex/Research/Project/Child.md",
      status: "attention",
    });
    expect(plan.effects.some((effect) => effect.kind === "move-cortex-subtree" && (effect.pageId === PROJECT_ID || effect.pageId === CHILD_ID))).toBe(false);
    expect(plan.effects.some((effect) => effect.kind === "write-cortex-local" && (effect.pageId === PROJECT_ID || effect.pageId === CHILD_ID))).toBe(false);
  });

  it("creates a conflict artifact and keeps originals untouched for simultaneous edit-versus-move changes", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Remote common\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [ARCHIVE_ID, RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Archive.md", pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Archive\n" });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Local edit\n" });

    const baseline = await initialPlan(harness);
    const state = baseline.nextCortex;
    harness.notion.changeParent(RESEARCH_ID, ARCHIVE_ID);
    const reconciliation = await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() });
    expect(reconciliation).toMatchObject({ error: null, canClassifyAbsence: true, invalidPaths: [] });
    const plan = await planCortexTree({ config, state, reconciliation, now: () => "2026-07-16T12:00:00.000Z" });

    expect(plan.error).toBeNull();
    expect(plan.pages.find((page) => page.pageId === RESEARCH_ID)).toMatchObject({ action: "conflict" });
    expect(plan.effects.map((effect) => effect.kind)).toContain("create-cortex-conflict");
    expect(plan.effects.some((effect) => effect.kind === "move-cortex-page" && effect.pageId === RESEARCH_ID)).toBe(false);
    expect(plan.effects.some((effect) => effect.kind === "write-cortex-local" && effect.pageId === RESEARCH_ID)).toBe(false);

    const repeat = await planCortexTree({ config, state: plan.nextCortex, reconciliation, now: () => "2026-07-16T12:00:00.000Z" });

    expect(repeat.pages.find((page) => page.pageId === RESEARCH_ID)).toMatchObject({ action: "conflict" });
    expect(repeat.effects).toEqual([]);
    expect(repeat.nextCortex?.pages[RESEARCH_ID]).toMatchObject({
      status: "conflict",
      lastCommonSemanticHash: state?.pages[RESEARCH_ID]?.lastCommonSemanticHash,
      lastCommonStructureHash: state?.pages[RESEARCH_ID]?.lastCommonStructureHash,
    });
  });

  it("records a fully observed missing remote page without deleting or rewriting its parent tree", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    const state = (await initialPlan(harness)).nextCortex;
    harness.notion.remove(RESEARCH_ID);

    const reconciliation = await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() });
    const plan = await planCortexTree({ config, state, reconciliation, now: () => "2026-07-16T12:00:00.000Z" });

    expect(plan.error).toBeNull();
    expect(plan.effects).toEqual([]);
    expect(plan.pages.find((page) => page.pageId === RESEARCH_ID)).toMatchObject({ action: "attention" });
    expect(plan.nextCortex?.pages[RESEARCH_ID]?.status).toBe("missing-notion");
  });

  it("fails closed with attention and no deletion for collisions, incomplete scans, missing local files, malformed parents, root moves, and cycles", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Same", sourceMarkdown: "One\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: CORTEX_ROOT_ID, title: "Same", sourceMarkdown: "Two\n", editedAt: "2026-07-16T12:00:00.000Z" });

    const collision = await initialPlan(harness);

    expect(collision.error?.code).toBe("identity-collision");
    expect(collision.effects).toEqual([]);
    expect(collision.pages.every((page) => page.action === "attention")).toBe(true);

    const incompleteHarness = new CortexTreeHarness();
    incompleteHarness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    incompleteHarness.notion.complete = false;
    const incomplete = await initialPlan(incompleteHarness);
    expect(incomplete.error?.code).toBe("invalid-response");
    expect(incomplete.effects).toEqual([]);

    const missingLocalHarness = new CortexTreeHarness();
    seedPairedTree(missingLocalHarness);
    const missingLocalState = (await initialPlan(missingLocalHarness)).nextCortex;
    const completeReconciliation = await reconcileCortexTree(config, { notion: missingLocalHarness.notion, scan: () => missingLocalHarness.scan() });
    const missingLocal = await planCortexTree({
      config,
      state: missingLocalState,
      reconciliation: { ...completeReconciliation, localPages: completeReconciliation.localPages.filter((page) => page.pageId !== RESEARCH_ID) },
      now: () => "2026-07-16T12:00:00.000Z",
    });
    expect(missingLocal.effects).toEqual([]);
    expect(missingLocal.nextCortex?.pages[RESEARCH_ID]?.status).toBe("missing-local");

    const validHarness = new CortexTreeHarness();
    seedPairedTree(validHarness);
    const validReconciliation = await reconcileCortexTree(config, { notion: validHarness.notion, scan: () => validHarness.scan() });
    const discovery = validReconciliation.discovery;
    if (discovery === null) throw new Error("missing discovery fixture");
    const malformed = (pages: typeof discovery.pages) => ({
      ...validReconciliation,
      discovery: { ...discovery, pages },
    });

    const unknownParent = await planCortexTree({
      config,
      state: null,
      reconciliation: malformed(discovery.pages.map((page) => page.pageId === RESEARCH_ID ? { ...page, parentPageId: PROJECT_ID } : page)),
      now: () => "2026-07-16T12:00:00.000Z",
    });
    const rootMove = await planCortexTree({
      config,
      state: null,
      reconciliation: malformed(discovery.pages.map((page) => page.pageId === CORTEX_ROOT_ID ? { ...page, parentPageId: RESEARCH_ID } : page)),
      now: () => "2026-07-16T12:00:00.000Z",
    });
    const cycle = await planCortexTree({
      config,
      state: null,
      reconciliation: malformed(discovery.pages.map((page) => page.pageId === RESEARCH_ID ? { ...page, parentPageId: RESEARCH_ID } : page)),
      now: () => "2026-07-16T12:00:00.000Z",
    });
    for (const plan of [unknownParent, rootMove, cycle]) {
      expect(plan.error?.code).toBe("identity-collision");
      expect(plan.effects).toEqual([]);
      expect(plan.pages.every((page) => page.action === "attention")).toBe(true);
    }
  });

  it("quarantines a new remote child beneath a root structural conflict", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    const state = (await initialPlan(harness)).nextCortex;

    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Local root\n", childPageIds: [RESEARCH_ID] });
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:01:00.000Z" });
    const plan = await planCortexTree({
      config,
      state,
      reconciliation: await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() }),
      now: () => "2026-07-16T12:00:00.000Z",
    });

    expect(plan.pages.find((page) => page.pageId === CORTEX_ROOT_ID)).toMatchObject({ action: "conflict" });
    expect(plan.pages.find((page) => page.pageId === ARCHIVE_ID)).toMatchObject({ action: "attention" });
    expect(plan.effects).toContainEqual(expect.objectContaining({ kind: "create-cortex-conflict", pageId: CORTEX_ROOT_ID }));
    expect(plan.effects.some((effect) => effect.kind === "create-cortex-local" && effect.pageId === ARCHIVE_ID)).toBe(false);
    expect(plan.nextCortex?.pages[ARCHIVE_ID]).toMatchObject({ status: "attention" });
  });

  it("quarantines structural-conflict descendants through both prior and current parentage", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: PROJECT_ID, parentPageId: RESEARCH_ID, title: "Project", sourceMarkdown: "Project\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: CHILD_ID, parentPageId: ARCHIVE_ID, title: "Child", sourceMarkdown: "Child\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID, ARCHIVE_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n", childPageIds: [PROJECT_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Archive.md", pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Archive\n", childPageIds: [CHILD_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research/Project.md", pageId: PROJECT_ID, parentPageId: RESEARCH_ID, parentPath: "The Cortex/Research.md", body: "Project\n" });
    harness.putOwnedLocal({ path: "The Cortex/Archive/Child.md", pageId: CHILD_ID, parentPageId: ARCHIVE_ID, parentPath: "The Cortex/Archive.md", body: "Child\n" });
    const state = (await initialPlan(harness)).nextCortex;

    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Local Research\n", childPageIds: [PROJECT_ID] });
    harness.notion.changeParent(PROJECT_ID, ARCHIVE_ID);
    harness.notion.changeParent(CHILD_ID, RESEARCH_ID);
    const plan = await planCortexTree({
      config,
      state,
      reconciliation: await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() }),
      now: () => "2026-07-16T12:00:00.000Z",
    });

    expect(plan.pages.find((page) => page.pageId === RESEARCH_ID)).toMatchObject({ action: "conflict" });
    for (const pageId of [PROJECT_ID, CHILD_ID]) {
      expect(plan.pages.find((page) => page.pageId === pageId)).toMatchObject({ action: "attention" });
      expect(plan.nextCortex?.pages[pageId]?.status).toBe("attention");
    }
    expect(plan.effects.some((effect) => effect.kind === "move-cortex-subtree" && (effect.pageId === PROJECT_ID || effect.pageId === CHILD_ID))).toBe(false);
    expect(plan.effects.some((effect) => effect.kind === "write-cortex-local" && (effect.pageId === PROJECT_ID || effect.pageId === CHILD_ID))).toBe(false);
  });
});
