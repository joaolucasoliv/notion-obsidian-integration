import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installIntoVault } from "./install-vault.mjs";

const ARTIFACTS = ["main.js", "bridge-worker.cjs", "manifest.json", "styles.css"] as const;

async function temporaryDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function createStagingDirectory(): Promise<string> {
  const stagingDirectory = await temporaryDirectory("grandbox-staging-");
  await Promise.all(ARTIFACTS.map((artifact) => writeFile(
    join(stagingDirectory, artifact),
    `${artifact}-public-content`,
    { mode: 0o600 },
  )));
  return stagingDirectory;
}

function pluginDirectory(vaultRoot: string): string {
  return join(vaultRoot, ".obsidian", "plugins", "grandbox-bridge");
}

describe("installIntoVault", () => {
  it("installs exactly the public plugin artifacts while preserving data and technical files", async () => {
    const stagingDirectory = await createStagingDirectory();
    const vaultRoot = await temporaryDirectory("grandbox-vault-");
    const homeDirectory = await temporaryDirectory("grandbox-home-");
    const target = pluginDirectory(vaultRoot);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await mkdir(join(target, ".technical-directory"), { mode: 0o700 });
    await Promise.all([
      writeFile(join(target, "data.json"), '{"installationId":"kept"}', { mode: 0o600 }),
      writeFile(join(target, ".technical"), "keep technical metadata", { mode: 0o600 }),
      writeFile(join(target, ".technical-directory", "marker"), "keep nested metadata", { mode: 0o600 }),
      writeFile(join(target, "main.js"), "old main", { mode: 0o600 }),
    ]);

    const installed = await installIntoVault({ stagingDirectory, vaultRoot, homeDirectory });

    expect(installed).toEqual({
      pluginDirectory: target,
      logDirectory: join(homeDirectory, "Library", "Logs", "GrandboxBridge"),
      logPath: join(homeDirectory, "Library", "Logs", "GrandboxBridge", "bridge.log"),
    });
    for (const artifact of ARTIFACTS) {
      expect(await readFile(join(target, artifact), "utf8")).toBe(`${artifact}-public-content`);
    }
    expect(await readFile(join(target, "data.json"), "utf8")).toBe('{"installationId":"kept"}');
    expect(await readFile(join(target, ".technical"), "utf8")).toBe("keep technical metadata");
    expect(await readFile(join(target, ".technical-directory", "marker"), "utf8")).toBe("keep nested metadata");
    expect((await stat(installed.logDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(installed.logPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects an unexpected staged artifact before mutating the vault or creating logs", async () => {
    const stagingDirectory = await createStagingDirectory();
    const vaultRoot = await temporaryDirectory("grandbox-vault-");
    const homeDirectory = await temporaryDirectory("grandbox-home-");
    const target = pluginDirectory(vaultRoot);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(target, "main.js"), "old main", { mode: 0o600 }),
      writeFile(join(target, "data.json"), '{"keep":true}', { mode: 0o600 }),
      writeFile(join(stagingDirectory, "unexpected.js"), "unsafe", { mode: 0o600 }),
    ]);

    await expect(installIntoVault({ stagingDirectory, vaultRoot, homeDirectory })).rejects.toThrow(/unsafe install artifacts/i);

    expect(await readFile(join(target, "main.js"), "utf8")).toBe("old main");
    expect(await readFile(join(target, "data.json"), "utf8")).toBe('{"keep":true}');
    await expect(lstat(join(homeDirectory, "Library", "Logs", "GrandboxBridge", "bridge.log"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing, non-regular, and symlinked staged artifacts before replacement", async () => {
    const vaultRoot = await temporaryDirectory("grandbox-vault-");
    const homeDirectory = await temporaryDirectory("grandbox-home-");

    const missing = await createStagingDirectory();
    await unlink(join(missing, "styles.css"));
    await expect(installIntoVault({ stagingDirectory: missing, vaultRoot, homeDirectory })).rejects.toThrow(/unsafe install artifacts/i);

    const nonRegular = await createStagingDirectory();
    await unlink(join(nonRegular, "styles.css"));
    await mkdir(join(nonRegular, "styles.css"));
    await expect(installIntoVault({ stagingDirectory: nonRegular, vaultRoot, homeDirectory })).rejects.toThrow(/unsafe install artifacts/i);

    const symlinked = await createStagingDirectory();
    const outside = await temporaryDirectory("grandbox-staging-outside-");
    const target = join(outside, "worker-target");
    await writeFile(target, "worker", { mode: 0o600 });
    await unlink(join(symlinked, "bridge-worker.cjs"));
    await symlink(target, join(symlinked, "bridge-worker.cjs"));
    await expect(installIntoVault({ stagingDirectory: symlinked, vaultRoot, homeDirectory })).rejects.toThrow(/unsafe install artifacts/i);
  });

  it("rejects a symlinked vault technical path before touching its target", async () => {
    const stagingDirectory = await createStagingDirectory();
    const vaultRoot = await temporaryDirectory("grandbox-vault-");
    const homeDirectory = await temporaryDirectory("grandbox-home-");
    const outside = await temporaryDirectory("grandbox-outside-");
    await mkdir(join(vaultRoot, ".obsidian"), { mode: 0o700 });
    await symlink(outside, join(vaultRoot, ".obsidian", "plugins"));

    await expect(installIntoVault({ stagingDirectory, vaultRoot, homeDirectory })).rejects.toThrow(/unsafe vault install path/i);
    await expect(lstat(join(outside, "grandbox-bridge"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["data.json", ".technical", "main.js"]) ("rejects an existing target %s symlink before replacement", async (name) => {
    const stagingDirectory = await createStagingDirectory();
    const vaultRoot = await temporaryDirectory("grandbox-vault-");
    const homeDirectory = await temporaryDirectory("grandbox-home-");
    const outside = await temporaryDirectory("grandbox-outside-");
    const target = pluginDirectory(vaultRoot);
    const outsideFile = join(outside, "protected");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(outsideFile, "outside content", { mode: 0o600 });
    await symlink(outsideFile, join(target, name));

    await expect(installIntoVault({ stagingDirectory, vaultRoot, homeDirectory })).rejects.toThrow(/unsafe vault install path/i);
    expect(await readFile(outsideFile, "utf8")).toBe("outside content");
    expect((await lstat(join(target, name))).isSymbolicLink()).toBe(true);
  });

  it("rejects an unsafe existing log before replacing target artifacts", async () => {
    const stagingDirectory = await createStagingDirectory();
    const vaultRoot = await temporaryDirectory("grandbox-vault-");
    const homeDirectory = await temporaryDirectory("grandbox-home-");
    const target = pluginDirectory(vaultRoot);
    const logDirectory = join(homeDirectory, "Library", "Logs", "GrandboxBridge");
    const logPath = join(logDirectory, "bridge.log");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(target, "main.js"), "old main", { mode: 0o600 }),
      writeFile(logPath, "unsafe old log", { mode: 0o600 }),
    ]);
    await chmod(logPath, 0o644);

    await expect(installIntoVault({ stagingDirectory, vaultRoot, homeDirectory })).rejects.toThrow(/unsafe log path/i);
    expect(await readFile(join(target, "main.js"), "utf8")).toBe("old main");
    expect((await stat(logPath)).mode & 0o777).toBe(0o644);
  });

  it("rejects an unsafe existing log directory before replacing target artifacts", async () => {
    const stagingDirectory = await createStagingDirectory();
    const vaultRoot = await temporaryDirectory("grandbox-vault-");
    const homeDirectory = await temporaryDirectory("grandbox-home-");
    const target = pluginDirectory(vaultRoot);
    const logDirectory = join(homeDirectory, "Library", "Logs", "GrandboxBridge");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(target, "main.js"), "old main", { mode: 0o600 }),
      chmod(logDirectory, 0o755),
    ]);

    await expect(installIntoVault({ stagingDirectory, vaultRoot, homeDirectory })).rejects.toThrow(/unsafe log path/i);
    expect(await readFile(join(target, "main.js"), "utf8")).toBe("old main");
    expect((await stat(logDirectory)).mode & 0o777).toBe(0o755);
  });

  it("leaves the old target intact if activation fails after staging", async () => {
    const stagingDirectory = await createStagingDirectory();
    const vaultRoot = await temporaryDirectory("grandbox-vault-");
    const homeDirectory = await temporaryDirectory("grandbox-home-");
    const target = pluginDirectory(vaultRoot);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(target, "main.js"), "old main", { mode: 0o600 }),
      writeFile(join(target, "data.json"), '{"keep":true}', { mode: 0o600 }),
      writeFile(join(target, ".technical"), "technical", { mode: 0o600 }),
    ]);

    await expect(installIntoVault({
      stagingDirectory,
      vaultRoot,
      homeDirectory,
      testHooks: { beforeActivation: async () => { throw new Error("injected activation failure"); } },
    })).rejects.toThrow(/vault install failed/i);

    expect(await readFile(join(target, "main.js"), "utf8")).toBe("old main");
    expect(await readFile(join(target, "data.json"), "utf8")).toBe('{"keep":true}');
    expect(await readFile(join(target, ".technical"), "utf8")).toBe("technical");
  });

  it("restores the old target if activation fails after its atomic backup move", async () => {
    const stagingDirectory = await createStagingDirectory();
    const vaultRoot = await temporaryDirectory("grandbox-vault-");
    const homeDirectory = await temporaryDirectory("grandbox-home-");
    const target = pluginDirectory(vaultRoot);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(target, "main.js"), "old main", { mode: 0o600 }),
      writeFile(join(target, "data.json"), '{"keep":true}', { mode: 0o600 }),
      writeFile(join(target, ".technical"), "technical", { mode: 0o600 }),
    ]);

    await expect(installIntoVault({
      stagingDirectory,
      vaultRoot,
      homeDirectory,
      testHooks: { afterBackupRename: async () => { throw new Error("injected rename failure"); } },
    })).rejects.toThrow(/vault install failed/i);

    expect(await readFile(join(target, "main.js"), "utf8")).toBe("old main");
    expect(await readFile(join(target, "data.json"), "utf8")).toBe('{"keep":true}');
    expect(await readFile(join(target, ".technical"), "utf8")).toBe("technical");
  });

  it.each([
    ["stagingDirectory", "relative-stage"],
    ["vaultRoot", "/tmp/vault/../escape"],
    ["homeDirectory", "/tmp/home\0suffix"],
  ])("rejects unsafe %s before filesystem mutation", async (field, value) => {
    const stagingDirectory = await createStagingDirectory();
    const vaultRoot = await temporaryDirectory("grandbox-vault-");
    const homeDirectory = await temporaryDirectory("grandbox-home-");
    const input = { stagingDirectory, vaultRoot, homeDirectory, [field]: value };

    await expect(installIntoVault(input)).rejects.toThrow(/unsafe install path/i);
  });
});
