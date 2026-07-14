import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalVaultRoot, resolveSafeVaultPath } from "./safety.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

async function temporaryVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), "grandbox-vault-"));
}

describe("canonicalVaultRoot", () => {
  it("binds the canonical real path, filesystem device, and installation identity into the fingerprint", async () => {
    const vaultPath = await temporaryVault();
    const canonicalPath = await realpath(vaultPath);
    const deviceId = String((await stat(canonicalPath)).dev);
    const expectedFingerprint = createHash("sha256")
      .update(`${canonicalPath}\0${deviceId}\0${INSTALLATION_ID}`, "utf8")
      .digest("hex");

    const canonical = await canonicalVaultRoot(vaultPath, INSTALLATION_ID, { mode: "bootstrap" });

    expect(canonical).toEqual({
      canonicalRealPath: canonicalPath,
      filesystemDeviceId: deviceId,
      vaultFingerprint: expectedFingerprint,
    });
  });

  it("fails closed when a copied vault has a different canonical identity", async () => {
    const firstVault = await temporaryVault();
    const copiedVault = await temporaryVault();
    const first = await canonicalVaultRoot(firstVault, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(
      canonicalVaultRoot(copiedVault, INSTALLATION_ID, {
        mode: "verify",
        expectedFingerprint: first.vaultFingerprint,
      }),
    ).rejects.toThrow(/vault identity mismatch/i);
  });

  it("accepts only an explicitly matching verification fingerprint", async () => {
    const vaultPath = await temporaryVault();
    const bootstrap = await canonicalVaultRoot(vaultPath, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(
      canonicalVaultRoot(vaultPath, INSTALLATION_ID, {
        mode: "verify",
        expectedFingerprint: bootstrap.vaultFingerprint,
      }),
    ).resolves.toEqual(bootstrap);
  });

  it("rejects a non-directory root and an unsafe installation identity", async () => {
    const vaultPath = await temporaryVault();
    const notePath = join(vaultPath, "note.md");
    await writeFile(notePath, "fixture");

    await expect(
      canonicalVaultRoot(notePath, INSTALLATION_ID, { mode: "bootstrap" }),
    ).rejects.toThrow(/vault root/i);
    await expect(
      canonicalVaultRoot(vaultPath, "../../installation", { mode: "bootstrap" }),
    ).rejects.toThrow(/installation identity/i);
  });

  it("rejects relative roots and omitted or unknown identity modes", async () => {
    const vaultPath = await temporaryVault();
    const relativeVault = relative(process.cwd(), vaultPath);

    await expect(
      canonicalVaultRoot(relativeVault, INSTALLATION_ID, { mode: "bootstrap" }),
    ).rejects.toThrow(/vault root/i);
    await expect(canonicalVaultRoot(vaultPath, INSTALLATION_ID, undefined as never)).rejects.toThrow(
      /vault identity/i,
    );
    await expect(
      canonicalVaultRoot(vaultPath, INSTALLATION_ID, { mode: "adopt" } as never),
    ).rejects.toThrow(/vault identity/i);
  });
});

describe("resolveSafeVaultPath", () => {
  it("resolves an existing normalized note beneath the canonical vault", async () => {
    const vaultPath = await temporaryVault();
    const notePath = join(vaultPath, "Research", "safe.md");
    await mkdir(join(vaultPath, "Research"));
    await writeFile(notePath, "fixture note");
    const canonical = await canonicalVaultRoot(vaultPath, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(resolveSafeVaultPath(canonical, "Research/safe.md", "existing-file")).resolves.toBe(
      join(canonical.canonicalRealPath, "Research", "safe.md"),
    );
  });

  it("allows a not-yet-created note only through existing non-symlink ancestors", async () => {
    const vaultPath = await temporaryVault();
    await mkdir(join(vaultPath, "Research"));
    const canonical = await canonicalVaultRoot(vaultPath, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(resolveSafeVaultPath(canonical, "Research/new-note.md", "write-target")).resolves.toBe(
      join(canonical.canonicalRealPath, "Research", "new-note.md"),
    );
  });

  it("rejects a write target when any ancestor is missing", async () => {
    const vaultPath = await temporaryVault();
    const canonical = await canonicalVaultRoot(vaultPath, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(
      resolveSafeVaultPath(canonical, "Missing/Deeper/new-note.md", "write-target"),
    ).rejects.toThrow(/unsafe vault path/i);
  });

  it("requires an existing regular file for existing-file intent", async () => {
    const vaultPath = await temporaryVault();
    await mkdir(join(vaultPath, "Research"));
    const canonical = await canonicalVaultRoot(vaultPath, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(
      resolveSafeVaultPath(canonical, "Research/missing.md", "existing-file"),
    ).rejects.toThrow(/unsafe vault path/i);
  });

  it.each([
    "/etc/passwd",
    "../outside.md",
    "Research/../../outside.md",
    "Research/../outside.md",
    "./Research/note.md",
    "Research//note.md",
    "Research/note.md/",
    "C:\\Users\\jo\\note.md",
    "C:/Users/jo/note.md",
    "C:relative-note.md",
    "\\\\server\\share\\note.md",
    "Research\\note.md",
    "Research/note.md\0suffix",
  ])("rejects an unsafe vault-relative path: %s", async (relativePath) => {
    const vaultPath = await temporaryVault();
    const canonical = await canonicalVaultRoot(vaultPath, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(resolveSafeVaultPath(canonical, relativePath, "write-target")).rejects.toThrow(
      /unsafe vault path/i,
    );
  });

  it("rejects a symlinked note that escapes the vault", async () => {
    const vaultPath = await temporaryVault();
    const outside = await temporaryVault();
    const outsideNote = join(outside, "private.md");
    await writeFile(outsideNote, "fixture outside note");
    await symlink(outsideNote, join(vaultPath, "linked.md"));
    const canonical = await canonicalVaultRoot(vaultPath, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(resolveSafeVaultPath(canonical, "linked.md", "existing-file")).rejects.toThrow(
      /unsafe vault path/i,
    );
  });

  it("rejects a symlinked ancestor that escapes the vault", async () => {
    const vaultPath = await temporaryVault();
    const outside = await temporaryVault();
    await writeFile(join(outside, "private.md"), "fixture outside note");
    await symlink(outside, join(vaultPath, "LinkedFolder"));
    const canonical = await canonicalVaultRoot(vaultPath, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(
      resolveSafeVaultPath(canonical, "LinkedFolder/private.md", "existing-file"),
    ).rejects.toThrow(/unsafe vault path/i);
  });
});
