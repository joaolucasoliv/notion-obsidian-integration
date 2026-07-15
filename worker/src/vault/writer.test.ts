import { lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import { canonicalVaultRoot } from "./safety.js";
import { AtomicVaultWriter } from "./writer.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

async function temporaryVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), "grandbox-writer-"));
}

describe("AtomicVaultWriter", () => {
  it("writes an existing note only when its exact byte baseline matches", async () => {
    const vault = await temporaryVault();
    const relativePath = "Notes/Bridge.md";
    const target = join(vault, "Notes", "Bridge.md");
    await mkdir(join(vault, "Notes"), { recursive: true });
    await writeFile(target, "old", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root);
    const next = "new";

    const result = await writer.write({
      relativePath,
      expectedByteHash: await sha256Hex("old"),
      content: next,
    });

    expect(result).toEqual({ byteHash: await sha256Hex(next) });
    expect(await readFile(target, "utf8")).toBe(next);
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
  });

  it("never mutates an existing note when the baseline differs", async () => {
    const vault = await temporaryVault();
    const target = join(vault, "Notes", "Bridge.md");
    await mkdir(join(vault, "Notes"), { recursive: true });
    await writeFile(target, "unchanged", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root);
    const canary = "fixture-note-body-must-not-leak";

    const error = await writer
      .write({ relativePath: "Notes/Bridge.md", expectedByteHash: await sha256Hex("different"), content: canary })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/vault writer failed/i);
    expect(String(error)).not.toContain(canary);
    expect(await readFile(target, "utf8")).toBe("unchanged");
  });

  it("rejects oversized content and unsafe normalized-path violations", async () => {
    const vault = await temporaryVault();
    await mkdir(join(vault, "Notes"), { recursive: true });
    await writeFile(join(vault, "Notes", "Bridge.md"), "old", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root);
    const baseline = await sha256Hex("old");

    await expect(
      writer.write({
        relativePath: "Notes/Bridge.md",
        expectedByteHash: baseline,
        content: "x".repeat(1_048_577),
      }),
    ).rejects.toThrow(/vault writer failed/i);

    for (const relativePath of ["/absolute.md", "../outside.md", "Notes//double.md", "Notes\\bad.md", "Notes/\0bad.md"]) {
      await expect(
        writer.write({ relativePath, expectedByteHash: baseline, content: "next" }),
      ).rejects.toThrow(/vault writer failed/i);
    }
  });

  it("rejects malformed UTF-8 input and refuses to replace a malformed UTF-8 leaf", async () => {
    const vault = await temporaryVault();
    const target = join(vault, "Notes", "Bridge.md");
    await mkdir(join(vault, "Notes"), { recursive: true });
    await writeFile(target, "old", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root);

    await expect(
      writer.write({
        relativePath: "Notes/Bridge.md",
        expectedByteHash: await sha256Hex("old"),
        content: "\ud800",
      }),
    ).rejects.toThrow(/vault writer failed/i);

    const malformed = Buffer.from([0x7b, 0xc3, 0x28, 0x7d]);
    await writeFile(target, malformed);
    await expect(
      writer.write({ relativePath: "Notes/Bridge.md", expectedByteHash: "a".repeat(64), content: "next" }),
    ).rejects.toThrow(/vault writer failed/i);
    expect(await readFile(target)).toEqual(malformed);
  });

  it("creates a private absent target with absent ancestors and never overwrites a collision", async () => {
    const vault = await temporaryVault();
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root);
    const content = "new conflict";
    const result = await writer.create({
      relativePath: "Bridge Conflicts/conflict.md",
      expectedAbsent: true,
      content,
    });
    const target = join(vault, "Bridge Conflicts", "conflict.md");

    expect(result).toEqual({ byteHash: await sha256Hex(content) });
    expect(await readFile(target, "utf8")).toBe(content);
    expect((await lstat(target)).mode & 0o777).toBe(0o600);

    await expect(
      writer.create({ relativePath: "Bridge Conflicts/conflict.md", expectedAbsent: true, content: "replacement" }),
    ).rejects.toThrow(/vault writer failed/i);
    expect(await readFile(target, "utf8")).toBe(content);
  });

  it("fsyncs each created ancestor entry and metadata before finalizing a create", async () => {
    const vault = await temporaryVault();
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const synchronized: string[] = [];
    const writer = new AtomicVaultWriter(root, {
      syncDirectory: async (directoryPath, sync) => {
        await sync();
        synchronized.push(directoryPath);
      },
    });
    const newDirectory = join(root.canonicalRealPath, "New");
    const nestedDirectory = join(newDirectory, "A");
    const target = join(nestedDirectory, "note.md");

    await writer.create({ relativePath: "New/A/note.md", expectedAbsent: true, content: "new" });

    expect(synchronized).toEqual([
      root.canonicalRealPath,
      newDirectory,
      newDirectory,
      nestedDirectory,
      nestedDirectory,
      nestedDirectory,
    ]);
    expect((await lstat(newDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(nestedDirectory)).mode & 0o777).toBe(0o700);
    expect(await readFile(target, "utf8")).toBe("new");
  });

  it("fails closed before descending when a created ancestor sync fails", async () => {
    const vault = await temporaryVault();
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const synchronized: string[] = [];
    const writer = new AtomicVaultWriter(root, {
      syncDirectory: async (directoryPath) => {
        synchronized.push(directoryPath);
        throw new Error("injected ancestor directory sync failure");
      },
    });
    const nestedDirectory = join(vault, "New", "A");

    await expect(
      writer.create({ relativePath: "New/A/note.md", expectedAbsent: true, content: "new" }),
    ).rejects.toThrow(/vault writer failed/i);
    expect(synchronized).toEqual([root.canonicalRealPath]);
    await expect(lstat(nestedDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries root durability before a later create after an ancestor sync fails", async () => {
    const vault = await temporaryVault();
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const synchronized: string[] = [];
    let failRootSync = true;
    const writer = new AtomicVaultWriter(root, {
      syncDirectory: async (directoryPath, sync) => {
        synchronized.push(directoryPath);
        if (directoryPath === root.canonicalRealPath && failRootSync) {
          failRootSync = false;
          throw new Error("injected initial root sync failure");
        }
        await sync();
      },
    });

    await expect(
      writer.create({ relativePath: "New/A/first.md", expectedAbsent: true, content: "first" }),
    ).rejects.toThrow(/vault writer failed/i);
    await expect(
      writer.create({ relativePath: "New/A/note.md", expectedAbsent: true, content: "new" }),
    ).resolves.toEqual({ byteHash: await sha256Hex("new") });

    expect(synchronized.slice(0, 2)).toEqual([root.canonicalRealPath, root.canonicalRealPath]);
  });

  it("rejects symlink leaves and ancestors without following them", async () => {
    const vault = await temporaryVault();
    const outside = await temporaryVault();
    await mkdir(join(vault, "Notes"), { recursive: true });
    await writeFile(join(outside, "outside.md"), "outside", "utf8");
    await symlink(join(outside, "outside.md"), join(vault, "Notes", "linked.md"));
    await symlink(outside, join(vault, "Linked"));
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root);

    await expect(
      writer.write({
        relativePath: "Notes/linked.md",
        expectedByteHash: await sha256Hex("outside"),
        content: "must not escape",
      }),
    ).rejects.toThrow(/vault writer failed/i);
    await expect(
      writer.create({ relativePath: "Linked/new.md", expectedAbsent: true, content: "must not escape" }),
    ).rejects.toThrow(/vault writer failed/i);
    expect(await readFile(join(outside, "outside.md"), "utf8")).toBe("outside");
  });

  it("fails closed when an injectable leaf or ancestor swap happens before finalization", async () => {
    const vault = await temporaryVault();
    const outside = await temporaryVault();
    const target = join(vault, "Notes", "Bridge.md");
    await mkdir(join(vault, "Notes"), { recursive: true });
    await writeFile(target, "old", "utf8");
    await writeFile(join(outside, "outside.md"), "outside", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root, {
      beforeWriteRename: async ({ targetPath }) => {
        await rename(targetPath, `${targetPath}.saved`);
        await symlink(join(outside, "outside.md"), targetPath);
      },
    });

    await expect(
      writer.write({
        relativePath: "Notes/Bridge.md",
        expectedByteHash: await sha256Hex("old"),
        content: "new",
      }),
    ).rejects.toThrow(/vault writer failed/i);
    expect(await readFile(join(outside, "outside.md"), "utf8")).toBe("outside");

    const createVault = await temporaryVault();
    const createOutside = await temporaryVault();
    await mkdir(join(createVault, "Notes"), { recursive: true });
    const createRoot = await canonicalVaultRoot(createVault, INSTALLATION_ID, { mode: "bootstrap" });
    const createWriter = new AtomicVaultWriter(createRoot, {
      beforeCreateFinalize: async ({ parentPath }) => {
        await rename(parentPath, `${parentPath}.saved`);
        await symlink(createOutside, parentPath);
      },
    });

    await expect(
      createWriter.create({ relativePath: "Notes/new.md", expectedAbsent: true, content: "new" }),
    ).rejects.toThrow(/vault writer failed/i);
    await expect(readFile(join(createOutside, "new.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a regular victim swapped after the final baseline read without overwriting it", async () => {
    const vault = await temporaryVault();
    const target = join(vault, "Notes", "Bridge.md");
    const victim = join(vault, "victim.md");
    await mkdir(join(vault, "Notes"), { recursive: true });
    await writeFile(target, "old", "utf8");
    await writeFile(victim, "regular victim", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root, {
      beforeFinalWriteTargetCheck: async ({ targetPath }) => {
        await rename(targetPath, `${targetPath}.saved`);
        await rename(victim, targetPath);
      },
    });

    await expect(
      writer.write({
        relativePath: "Notes/Bridge.md",
        expectedByteHash: await sha256Hex("old"),
        content: "new",
      }),
    ).rejects.toThrow(/vault writer failed/i);
    expect(await readFile(target, "utf8")).toBe("regular victim");
  });

  it("rejects a same-inode mutation after the final writer hook without overwriting it", async () => {
    const vault = await temporaryVault();
    const target = join(vault, "Notes", "Bridge.md");
    await mkdir(join(vault, "Notes"), { recursive: true });
    await writeFile(target, "old", "utf8");
    const originalIdentity = await lstat(target);
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root, {
      beforeFinalWriteTargetCheck: async ({ targetPath }) => {
        await writeFile(targetPath, "attacker mutation", "utf8");
      },
    });

    await expect(
      writer.write({
        relativePath: "Notes/Bridge.md",
        expectedByteHash: await sha256Hex("old"),
        content: "new",
      }),
    ).rejects.toThrow(/vault writer failed/i);
    expect(await readFile(target, "utf8")).toBe("attacker mutation");
    const observedIdentity = await lstat(target);
    expect({ dev: observedIdentity.dev, ino: observedIdentity.ino }).toEqual({
      dev: originalIdentity.dev,
      ino: originalIdentity.ino,
    });
  });
});
