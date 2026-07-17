import { describe, expect, it } from "vitest";
import { CortexTreeHarness, ARCHIVE_ID, CORTEX_ROOT_ID, RESEARCH_ID } from "../../../tests/fakes/cortex-tree-harness.js";
import { planCortexTree } from "./planner.js";
import { reconcileCortexTree } from "./reconcile.js";

const config = {
  rootPageId: CORTEX_ROOT_ID,
  rootFilePath: "The Cortex.md" as const,
  rootDirectoryPath: "The Cortex" as const,
};

describe("reconcileCortexTree", () => {
  it("discovers the complete remote tree before scanning local files and prepares a nested first import", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });

    const result = await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() });

    expect(harness.events.slice(0, 2)).toEqual(["remote-discovery", "local-scan"]);
    expect(result.error).toBeNull();
    expect(result.discovery?.complete).toBe(true);
    expect(result.discovery?.pages.map((page) => page.pageId)).toEqual([CORTEX_ROOT_ID, RESEARCH_ID]);
    expect(result.localPages).toEqual([]);
  });

  it("keeps incomplete remote discovery out of local-missing or remote-missing evidence", async () => {
    const harness = new CortexTreeHarness();
    harness.notion.complete = false;
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });

    const result = await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() });

    expect(result.error).toBeNull();
    expect(result.discovery?.complete).toBe(false);
    expect(result.canClassifyAbsence).toBe(false);
  });

  it("preserves owned child-marker order when it differs from lexical local paths", async () => {
    const harness = new CortexTreeHarness();
    harness.putRemote({ pageId: CORTEX_ROOT_ID, parentPageId: null, title: "The Cortex", sourceMarkdown: "Root\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, title: "Research", sourceMarkdown: "Research\n", editedAt: "2026-07-16T12:00:00.000Z" });
    harness.putRemote({ pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, title: "Archive", sourceMarkdown: "Archive\n", editedAt: "2026-07-16T12:00:00.000Z" });
    // Notion's owned order is Research then Archive even though Archive.md sorts first locally.
    harness.putOwnedLocal({ path: "The Cortex.md", pageId: CORTEX_ROOT_ID, parentPageId: null, parentPath: null, body: "Root\n", childPageIds: [RESEARCH_ID, ARCHIVE_ID] });
    harness.putOwnedLocal({ path: "The Cortex/Research.md", pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Research\n" });
    harness.putOwnedLocal({ path: "The Cortex/Archive.md", pageId: ARCHIVE_ID, parentPageId: CORTEX_ROOT_ID, parentPath: "The Cortex.md", body: "Archive\n" });

    const reconciliation = await reconcileCortexTree(config, { notion: harness.notion, scan: () => harness.scan() });
    const first = await planCortexTree({ config, state: null, reconciliation, now: () => "2026-07-16T12:00:00.000Z" });
    const repeat = await planCortexTree({ config, state: first.nextCortex, reconciliation, now: () => "2026-07-16T12:00:00.000Z" });

    expect(reconciliation.invalidPaths).toEqual([]);
    expect(reconciliation.localPages.find((page) => page.pageId === CORTEX_ROOT_ID)?.directChildPageIds).toEqual([RESEARCH_ID, ARCHIVE_ID]);
    expect(first.effects).toEqual([]);
    expect(repeat.effects).toEqual([]);
  });
});
