import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalVaultRoot } from "./safety.js";
import { observeSafeVaultNoteBytes, scanVaultNotes } from "./scanner.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

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
