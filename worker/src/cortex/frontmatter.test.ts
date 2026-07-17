import { describe, expect, it } from "vitest";
import {
  LocalNoteParseError,
  parseLocalNote,
  replaceSyncedTags,
  upsertBridgeId,
} from "../markdown/frontmatter.js";
import { renderLocalNote } from "../markdown/render.js";
import {
  CortexFrontmatterError,
  parseCortexLocalNote,
  upsertCortexFrontmatter,
} from "./frontmatter.js";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";

describe("Cortex frontmatter codec", () => {
  it("owns only Cortex keys while preserving unrelated frontmatter comments and the user body", () => {
    const before = "---\n# keep this\ncustom:\n  nested: 7\ntags: [manual]\n---\nUser body  \n";

    const rendered = upsertCortexFrontmatter(before, {
      cortexTree: true,
      pageId: PAGE_ID,
      parentPageId: ROOT_ID,
      rootPageId: ROOT_ID,
    });

    expect(rendered).toBe(
      `---\n# keep this\ncustom:\n  nested: 7\ntags: [manual]\ncortex_tree: true\ncortex_page_id: ${PAGE_ID}\ncortex_parent_page_id: ${ROOT_ID}\ncortex_root_page_id: ${ROOT_ID}\n---\nUser body  \n`,
    );
    expect(parseCortexLocalNote("The Cortex/Research.md", rendered).cortex).toEqual({
      cortexTree: true,
      pageId: PAGE_ID,
      parentPageId: ROOT_ID,
      rootPageId: ROOT_ID,
    });
  });

  it("rejects a Cortex note that is also opted into the legacy notion_sync pair", () => {
    expect(() => parseCortexLocalNote(
      "The Cortex/Research.md",
      `---\nnotion_sync: true\ncortex_tree: true\ncortex_page_id: ${PAGE_ID}\ncortex_parent_page_id: ${ROOT_ID}\ncortex_root_page_id: ${ROOT_ID}\n---\nBody`,
    )).toThrow(CortexFrontmatterError);
  });

  it("requires the root to have a null parent and matching page/root UUID", () => {
    const root = parseCortexLocalNote(
      "The Cortex.md",
      `---\ncortex_tree: true\ncortex_page_id: ${ROOT_ID}\ncortex_parent_page_id: null\ncortex_root_page_id: ${ROOT_ID}\n---\nRoot`,
    );
    expect(root.cortex).toEqual({ cortexTree: true, pageId: ROOT_ID, parentPageId: null, rootPageId: ROOT_ID });

    expect(() => parseCortexLocalNote(
      "The Cortex.md",
      `---\ncortex_tree: true\ncortex_page_id: ${ROOT_ID}\ncortex_parent_page_id: ${PAGE_ID}\ncortex_root_page_id: ${ROOT_ID}\n---\nRoot`,
    )).toThrow(CortexFrontmatterError);
    expect(() => parseCortexLocalNote(
      "The Cortex/Research.md",
      `---\ncortex_tree: true\ncortex_page_id: ${ROOT_ID}\ncortex_parent_page_id: ${ROOT_ID}\ncortex_root_page_id: ${ROOT_ID}\n---\nBody`,
    )).toThrow(CortexFrontmatterError);
  });

  it("keeps legacy mutators and rendering out of full or partial Cortex namespaces", () => {
    const partial = "---\ncortex_unknown: true\n---\nBody";
    const bridgeId = "33333333-3333-4333-8333-333333333333";
    expect(() => upsertBridgeId(partial, bridgeId)).toThrow(LocalNoteParseError);
    expect(() => replaceSyncedTags(partial, ["legacy"])).toThrow(LocalNoteParseError);

    const owned = parseLocalNote(
      "The Cortex/Research.md",
      `---\ncortex_tree: true\ncortex_page_id: ${PAGE_ID}\ncortex_parent_page_id: ${ROOT_ID}\ncortex_root_page_id: ${ROOT_ID}\n---\nBody`,
    );
    expect(() => renderLocalNote(owned, { bodyMarkdown: "Changed", tags: [] })).toThrow();
  });
});
