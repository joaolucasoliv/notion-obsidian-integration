import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodeExecutable } from "./node-runtime.js";

describe("resolveNodeExecutable", () => {
  it("prefers the user's real Node executable over the Electron host process", () => {
    const checked: string[] = [];

    const executable = resolveNodeExecutable({
      homeDirectory: "/Users/example",
      path: "/usr/local/bin:/usr/bin",
      isExecutable: (candidate) => {
        checked.push(candidate);
        return candidate === "/Users/example/.local/bin/node";
      },
      canonicalize: (candidate) => candidate,
    });

    expect(executable).toBe("/Users/example/.local/bin/node");
    expect(checked).toEqual(["/Users/example/.local/bin/node"]);
  });

  it("uses an absolute Node path from PATH when the home-local runtime is unavailable", () => {
    const executable = resolveNodeExecutable({
      homeDirectory: "/Users/example",
      path: "/not-absolute:relative:/opt/custom/bin:/opt/custom/bin",
      isExecutable: (candidate) => candidate === "/opt/custom/bin/node",
      canonicalize: (candidate) => candidate,
    });

    expect(executable).toBe("/opt/custom/bin/node");
  });

  it("resolves a home-local Node symlink to the regular executable required by service status", async () => {
    const homeDirectory = await realpath(await mkdtemp(join(tmpdir(), "grandbox-node-runtime-")));
    try {
      const runtimeDirectory = join(homeDirectory, "runtime");
      const localBin = join(homeDirectory, ".local", "bin");
      const target = join(runtimeDirectory, "node");
      await mkdir(runtimeDirectory, { recursive: true });
      await mkdir(localBin, { recursive: true });
      await writeFile(target, "#!/bin/sh\n", { mode: 0o700 });
      await chmod(target, 0o700);
      await symlink(target, join(localBin, "node"));

      expect(resolveNodeExecutable({ homeDirectory, path: "" })).toBe(await realpath(target));
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });
});
