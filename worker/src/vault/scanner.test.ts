import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalVaultRoot } from "./safety.js";
import {
  observeSafeVaultNoteBytes,
  scanCortexVaultNotes,
  scanVaultNotes,
  scanVaultNotesWithStatus,
} from "./scanner.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const CORTEX_ROOT_ID = "11111111-1111-4111-8111-111111111111";
const RESEARCH_ID = "22222222-2222-4222-8222-222222222222";
const ARCHIVE_ID = "33333333-3333-4333-8333-333333333333";
const CHILD_ID = "44444444-4444-4444-8444-444444444444";
const UNKNOWN_ID = "55555555-5555-4555-8555-555555555555";

function cortexNote(input: Readonly<{
  pageId: string;
  parentPageId: string | null;
  rootPageId?: string;
}>): string {
  return `---\ncortex_tree: true\ncortex_page_id: ${input.pageId}\ncortex_parent_page_id: ${input.parentPageId ?? "null"}\ncortex_root_page_id: ${input.rootPageId ?? CORTEX_ROOT_ID}\n---\nCortex`;
}

async function temporaryVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), "grandbox-scan-"));
}

async function put(vault: string, relativePath: string, bytes: string | Uint8Array): Promise<void> {
  const segments = relativePath.split("/");
  const parent = join(vault, ...segments.slice(0, -1));
  await mkdir(parent, { recursive: true });
  await writeFile(join(vault, ...segments), bytes);
}

describe("scanVaultNotes", () => {
  it("fails closed on a direct-pair descendant while retaining a valid bare Cortex child", async () => {
    const vault = await temporaryVault();
    await put(vault, "The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null }));
    await put(vault, "The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID }));
    await put(vault, "The Cortex/Research/Bare.md", "Bare local child");
    await put(vault, "The Cortex/Research/Legacy.md", "---\nnotion_sync: true\n---\nLegacy direct pair");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const kinds = new Map((await scanCortexVaultNotes(root)).map((entry) => [entry.path, entry.kind]));

    expect(kinds.get("The Cortex.md")).toBe("owned");
    expect(kinds.get("The Cortex/Research.md")).toBe("owned");
    expect(kinds.get("The Cortex/Research/Bare.md")).toBe("candidate");
    expect(kinds.get("The Cortex/Research/Legacy.md")).toBe("invalid");
  });

  it.each([
    {
      name: "no declared root",
      files: [["The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID })]],
    },
    {
      name: "more than one declared root",
      files: [
        ["The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null })],
        ["The Cortex/Archive.md", cortexNote({ pageId: ARCHIVE_ID, parentPageId: null, rootPageId: ARCHIVE_ID })],
      ],
    },
    {
      name: "a mismatched root identity",
      files: [
        ["The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null })],
        ["The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID, rootPageId: ARCHIVE_ID })],
      ],
    },
    {
      name: "a duplicate page identity",
      files: [
        ["The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null })],
        ["The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID })],
        ["The Cortex/Archive.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID })],
      ],
    },
    {
      name: "an unparseable Cortex ownership claim",
      files: [
        ["The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null })],
        ["The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID })],
        ["The Cortex/Archive.md", `---\ncortex_tree: true\ncortex_page_id: ${RESEARCH_ID}\ncortex_page_id: ${RESEARCH_ID}\n---\nArchive`],
      ],
    },
    {
      name: "an unparseable explicit-key Cortex ownership claim",
      files: [
        ["The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null })],
        ["The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID })],
        ["The Cortex/Archive.md", "---\n? cortex_tree\n: true\n? cortex_page_id\n: 22222222-2222-4222-8222-222222222222\n? cortex_page_id\n: 22222222-2222-4222-8222-222222222222\n? cortex_parent_page_id\n: 11111111-1111-4111-8111-111111111111\n? cortex_root_page_id\n: 11111111-1111-4111-8111-111111111111\n---\nArchive"],
      ],
    },
    {
      name: "a Cortex ownership token after an explicit YAML document end",
      files: [
        ["The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null })],
        ["The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID })],
        ["The Cortex/Archive.md", "---\nnormal: value\n...\ncortex_tree: true\n---\nArchive"],
      ],
    },
    {
      name: "an alias-backed Cortex ownership claim",
      files: [
        ["The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null })],
        ["The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID })],
        ["The Cortex/Archive.md", `---\nmetadata:\n  declared: &c cortex_page_id\n? *c\n: ${RESEARCH_ID}\nbroken: [\n---\nArchive`],
      ],
    },
    {
      name: "a tagged alias-backed Cortex ownership claim",
      files: [
        ["The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null })],
        ["The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID })],
        ["The Cortex/Archive.md", `---\nmetadata:\n  declared: &c !!str cortex_page_id\n? *c\n: ${RESEARCH_ID}\nbroken: [\n---\nArchive`],
      ],
    },
    {
      name: "a Cortex-valued anchor declared before an alias and a harmless duplicate after it",
      files: [
        ["The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null })],
        ["The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID })],
        ["The Cortex/Archive.md", `---\nmetadata:\n  declared: &c cortex_page_id\n? *c\n: ${RESEARCH_ID}\nlater: &c harmless\nbroken: [\n---\nArchive`],
      ],
    },
    {
      name: "an unknown parent identity",
      files: [
        ["The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null })],
        ["The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: UNKNOWN_ID })],
      ],
    },
    {
      name: "a self parent identity",
      files: [
        ["The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null })],
        ["The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: RESEARCH_ID })],
      ],
    },
    {
      name: "a parent that is not the immediate local parent",
      files: [
        ["The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null })],
        ["The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID })],
        ["The Cortex/Research/Child.md", cortexNote({ pageId: CHILD_ID, parentPageId: CORTEX_ROOT_ID })],
      ],
    },
  ])("fails closed on an owned tree with $name", async ({ files }) => {
    const vault = await temporaryVault();
    for (const [path, bytes] of files) {
      await put(vault, path as string, bytes as string);
    }
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const scanned = await scanCortexVaultNotes(root);

    expect(scanned).not.toHaveLength(0);
    expect(scanned.every((entry) => entry.kind === "invalid")).toBe(true);
  });

  it("keeps a valid owned tree when an unrelated malformed note has no Cortex ownership claim", async () => {
    const vault = await temporaryVault();
    await put(vault, "The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null }));
    await put(vault, "The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID }));
    await put(vault, "The Cortex/Archive.md", "---\nmetadata:\n  cortex_page_id: prose, not ownership\nbroken: [\n---\nBody prose: cortex_tree: true");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const kinds = new Map((await scanCortexVaultNotes(root)).map((entry) => [entry.path, entry.kind]));

    expect(kinds.get("The Cortex.md")).toBe("owned");
    expect(kinds.get("The Cortex/Research.md")).toBe("owned");
    expect(kinds.get("The Cortex/Archive.md")).toBe("invalid");
  });

  it("keeps a valid owned tree when a quoted string resembles an alias-backed Cortex key", async () => {
    const vault = await temporaryVault();
    await put(vault, "The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null }));
    await put(vault, "The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID }));
    await put(vault, "The Cortex/Archive.md", "---\nmetadata:\n  declared: &c harmless\n  note: \"&c cortex_page_id\"\n? *c\n: harmless\nbroken: [\n---\nArchive");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const kinds = new Map((await scanCortexVaultNotes(root)).map((entry) => [entry.path, entry.kind]));

    expect(kinds.get("The Cortex.md")).toBe("owned");
    expect(kinds.get("The Cortex/Research.md")).toBe("owned");
    expect(kinds.get("The Cortex/Archive.md")).toBe("invalid");
  });

  it("uses the harmless anchor declared before an alias instead of a later Cortex duplicate", async () => {
    const vault = await temporaryVault();
    await put(vault, "The Cortex.md", cortexNote({ pageId: CORTEX_ROOT_ID, parentPageId: null }));
    await put(vault, "The Cortex/Research.md", cortexNote({ pageId: RESEARCH_ID, parentPageId: CORTEX_ROOT_ID }));
    await put(vault, "The Cortex/Archive.md", `---\nmetadata:\n  declared: &c harmless\n? *c\n: harmless\nlater: &c cortex_page_id\nbroken: [\n---\nArchive`);
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const kinds = new Map((await scanCortexVaultNotes(root)).map((entry) => [entry.path, entry.kind]));

    expect(kinds.get("The Cortex.md")).toBe("owned");
    expect(kinds.get("The Cortex/Research.md")).toBe("owned");
    expect(kinds.get("The Cortex/Archive.md")).toBe("invalid");
  });

  it("scans only the reserved Cortex root and accepts a bare local child only below a paired parent", async () => {
    const vault = await temporaryVault();
    const rootId = "11111111-1111-4111-8111-111111111111";
    const researchId = "22222222-2222-4222-8222-222222222222";
    await put(
      vault,
      "The Cortex.md",
      `---\ncortex_tree: true\ncortex_page_id: ${rootId}\ncortex_parent_page_id: null\ncortex_root_page_id: ${rootId}\n---\nRoot`,
    );
    await put(
      vault,
      "The Cortex/Research.md",
      `---\ncortex_tree: true\ncortex_page_id: ${researchId}\ncortex_parent_page_id: ${rootId}\ncortex_root_page_id: ${rootId}\n---\nResearch`,
    );
    await put(vault, "The Cortex/Research/Project.md", "Bare local child");
    await put(vault, "The Cortex/Unpaired/Loose.md", "Not below a paired parent");
    await put(vault, "The Cortexology.md", "Outside the reserved root");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const cortex = await scanCortexVaultNotes(root);
    const legacy = await scanVaultNotes(root);

    expect(cortex.map((entry) => [entry.path, entry.kind])).toEqual([
      ["The Cortex.md", "owned"],
      ["The Cortex/Research.md", "owned"],
      ["The Cortex/Research/Project.md", "candidate"],
      ["The Cortex/Unpaired/Loose.md", "unpaired"],
    ]);
    expect(legacy.filter((entry) => entry.path === "The Cortex.md" || entry.path.startsWith("The Cortex/")).map((entry) => entry.eligibility)).toEqual([
      { eligible: false, reason: "cortex-owned" },
      { eligible: false, reason: "cortex-owned" },
      { eligible: false, reason: "cortex-owned" },
      { eligible: false, reason: "cortex-owned" },
    ]);
  });

  it("returns every safe Markdown candidate in deterministic normalized path order", async () => {
    const vault = await temporaryVault();
    await put(vault, "z-last.md", "---\nnotion_sync: false\n---\nZ");
    await put(vault, "A/eligible.md", "---\nnotion_sync: true\n---\nA");
    await put(vault, "A/invalid.md", "---\nnotion_sync: \"true\"\n---\nInvalid");
    await put(vault, "B/UPPER.MD", "---\nnotion_sync: true\n---\nUpper");
    await put(vault, "B/not-markdown.txt", "---\nnotion_sync: true\n---\nIgnored");
    await put(vault, "Grandbox Bridge.md", "---\nnotion_sync: true\n---\nStatus");
    await put(vault, ".hidden.md", "---\nnotion_sync: true\n---\nHidden file");
    await put(vault, "Bridge Conflicts/generated.md", "not valid frontmatter");
    await put(vault, ".obsidian/plugins/private.md", "---\nnotion_sync: true\n---\nHidden");
    await put(vault, "Notes/.cache/private.md", "---\nnotion_sync: true\n---\nHidden");
    await put(vault, "Templates/template.md", "---\nnotion_sync: true\n---\nTemplate");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const scanned = await scanVaultNotes(root);

    expect(scanned.map((entry) => entry.path)).toEqual([
      ".hidden.md",
      "A/eligible.md",
      "A/invalid.md",
      "B/UPPER.MD",
      "Bridge Conflicts/generated.md",
      "Grandbox Bridge.md",
      "z-last.md",
    ]);
    expect(scanned.map((entry) => entry.eligibility)).toEqual([
      { eligible: false, reason: "technical-path" },
      { eligible: true },
      { eligible: false, reason: "invalid-frontmatter" },
      { eligible: true },
      { eligible: false, reason: "conflict-artifact" },
      { eligible: false, reason: "status-note" },
      { eligible: false, reason: "not-opted-in" },
    ]);
    expect("note" in (scanned[2] as object)).toBe(false);
    expect(Object.isFrozen(scanned[1]?.eligibility)).toBe(false);
    expect(Object.isFrozen(scanned[1]?.note)).toBe(false);
    expect(Object.isFrozen(scanned[1]?.note?.tags)).toBe(false);
  });

  it("classifies a well-formed exact GitHub pair before unrelated invalid YAML", async () => {
    const vault = await temporaryVault();
    await put(
      vault,
      "Repositories/generated.md",
      "---\nnotion_sync: [invalid\n---\n<!-- dual-scribe-github:start:repository -->\nGenerated\n<!-- dual-scribe-github:end:repository -->",
    );
    await put(
      vault,
      "Repositories/mismatched.md",
      "---\nnotion_sync: true\n---\n<!-- dual-scribe-github:start:repository -->\nGenerated\n<!-- dual-scribe-github:end:dashboard -->",
    );
    await put(
      vault,
      "Repositories/manual.md",
      "---\nnotion_sync: true\n---\nManual",
    );
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const scanned = await scanVaultNotes(root);

    expect(scanned).toMatchObject([
      {
        path: "Repositories/generated.md",
        eligibility: { eligible: false, reason: "generated-github" },
      },
      {
        path: "Repositories/manual.md",
        eligibility: { eligible: true },
      },
      {
        path: "Repositories/mismatched.md",
        eligibility: { eligible: false, reason: "invalid-frontmatter" },
      },
    ]);
    expect("note" in (scanned[0] as object)).toBe(false);
  });

  it("never follows symlinked files or directory ancestors", async () => {
    const vault = await temporaryVault();
    const outside = await temporaryVault();
    await put(outside, "private.md", "---\nnotion_sync: true\n---\nOutside secret");
    await symlink(join(outside, "private.md"), join(vault, "linked-file.md"));
    await symlink(outside, join(vault, "linked-folder"));
    await put(vault, "safe.md", "---\nnotion_sync: true\n---\nSafe");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const scanned = await scanVaultNotes(root);

    expect(scanned.map((entry) => entry.path)).toEqual(["safe.md"]);
    expect(scanned[0]?.note?.body).toBe("Safe");
  });

  it("bounds discovery while still observing explicitly scoped state paths", async () => {
    const vault = await temporaryVault();
    await put(vault, "A.md", "---\nnotion_sync: true\n---\nA");
    await put(vault, "B.md", "---\nnotion_sync: true\n---\nB");
    await put(vault, "Z.md", "---\nnotion_sync: true\n---\nZ");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const scanned = await scanVaultNotes(root, { maximumCandidates: 1, includePaths: ["Z.md"] });

    expect(scanned).toHaveLength(2);
    expect(scanned.map((entry) => entry.path)).toContain("Z.md");
    expect(scanned.map((entry) => entry.path)).toContainEqual(expect.stringMatching(/^[AB]\.md$/u));
  });

  it("exposes incomplete bounded traversal rather than claiming an unseen vault complete", async () => {
    const vault = await temporaryVault();
    await put(vault, "A/one.txt", "not markdown");
    await put(vault, "B/two.txt", "not markdown");
    await put(vault, "C/note.md", "---\nnotion_sync: true\n---\nC");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const result = await scanVaultNotesWithStatus(root, {
      maximumCandidates: 3,
      maximumTraversalEntries: 1,
    });

    expect(result.complete).toBe(false);
    expect(result.entries.length).toBeLessThanOrEqual(1);
  });

  it("reads a conflict artifact through the same bounded no-follow vault path checks used by scanning", async () => {
    const vault = await temporaryVault();
    await put(vault, "Bridge Conflicts/safe.bridge-conflict.md", "synthetic conflict artifact\n");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(observeSafeVaultNoteBytes(root, "Bridge Conflicts/safe.bridge-conflict.md")).resolves.toEqual({
      kind: "present",
      bytes: "synthetic conflict artifact\n",
    });
    await expect(observeSafeVaultNoteBytes(root, "../outside.md")).rejects.toThrow();
  });

  it("fails closed per candidate on unsafe Windows-style names, oversized bytes, and invalid UTF-8", async () => {
    const vault = await temporaryVault();
    await put(vault, "C:/unsafe.md", "---\nnotion_sync: true\n---\nUnsafe");
    await put(vault, "Notes/back\\slash.md", "---\nnotion_sync: true\n---\nUnsafe");
    await put(vault, "Notes/oversized.md", new Uint8Array(1_048_577).fill(65));
    await put(vault, "Notes/invalid-utf8.md", Uint8Array.from([0xff, 0xfe, 0xfd]));
    await put(vault, "Notes/safe.md", "---\nnotion_sync: true\n---\nSafe");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const scanned = await scanVaultNotes(root);

    expect(scanned).toMatchObject([
      { path: "C:/unsafe.md", eligibility: { eligible: false, reason: "invalid-frontmatter" } },
      {
        path: "Notes/back\\slash.md",
        eligibility: { eligible: false, reason: "invalid-frontmatter" },
      },
      {
        path: "Notes/invalid-utf8.md",
        eligibility: { eligible: false, reason: "invalid-frontmatter" },
      },
      {
        path: "Notes/oversized.md",
        eligibility: { eligible: false, reason: "invalid-frontmatter" },
      },
      { path: "Notes/safe.md", eligibility: { eligible: true } },
    ]);
  });
});
