import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preparePluginRelease } from "./prepare-plugin-release.mjs";

const ARTIFACTS = ["main.js", "bridge-worker.cjs", "manifest.json", "styles.css"] as const;

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "grandbox-plugin-release-"));
  await Promise.all([
    mkdir(join(root, "plugin"), { recursive: true }),
    mkdir(join(root, "worker", "dist"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "plugin", "main.js"), "plugin bundle"),
    writeFile(join(root, "worker", "dist", "bridge-worker.cjs"), "worker bundle"),
    writeFile(join(root, "plugin", "manifest.json"), '{"id":"grandbox-bridge"}'),
    writeFile(join(root, "plugin", "styles.css"), "body {}"),
  ]);
  return realpath(root);
}

describe("preparePluginRelease", () => {
  it("creates exactly the four installable public artifacts and refreshes them atomically", async () => {
    const projectRoot = await createProjectRoot();
    const outputDirectory = join(projectRoot, "dist", "grandbox-bridge");

    await preparePluginRelease({ projectRoot, outputDirectory });

    expect(await readdir(outputDirectory)).toEqual([...ARTIFACTS].sort());
    await expect(readFile(join(outputDirectory, "main.js"), "utf8")).resolves.toBe("plugin bundle");
    await expect(readFile(join(outputDirectory, "bridge-worker.cjs"), "utf8")).resolves.toBe("worker bundle");
    expect((await lstat(outputDirectory)).isDirectory()).toBe(true);

    await writeFile(join(projectRoot, "plugin", "main.js"), "new plugin bundle");
    await preparePluginRelease({ projectRoot, outputDirectory });

    await expect(readFile(join(outputDirectory, "main.js"), "utf8")).resolves.toBe("new plugin bundle");
  });

  it("rejects a symlinked source artifact without producing an install directory", async () => {
    const projectRoot = await createProjectRoot();
    const outputDirectory = join(projectRoot, "dist", "grandbox-bridge");
    const source = join(projectRoot, "plugin", "main.js");
    const outside = join(projectRoot, "outside.js");
    await writeFile(outside, "outside");
    await unlink(source);
    await symlink(outside, source);

    await expect(preparePluginRelease({ projectRoot, outputDirectory })).rejects.toThrow(/unsafe plugin artifact/i);
    await expect(lstat(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
