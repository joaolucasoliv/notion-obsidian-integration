import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { writeAtomicPrivateJson } from "./atomic-json.js";

async function temporaryPath(name = "state.json"): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "grandbox-atomic-")));
  return join(root, "private", name);
}

describe("writeAtomicPrivateJson", () => {
  it("writes JSON through a private sibling and leaves private file and directory modes", async () => {
    const filePath = await temporaryPath();

    await writeAtomicPrivateJson(filePath, { schemaVersion: 1, enabled: true });

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ schemaVersion: 1, enabled: true });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
  });

  it("atomically replaces an existing canonical file", async () => {
    const filePath = await temporaryPath();
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, JSON.stringify({ version: "old" }), { mode: 0o600 });

    await writeAtomicPrivateJson(filePath, { version: "new" });

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ version: "new" });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("preserves the canonical file and never removes another writer's colliding temporary file", async () => {
    const filePath = await temporaryPath();
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, "canonical-old", { mode: 0o600 });
    const collisionPath = join(dirname(filePath), `.${basename(filePath)}.collision.tmp`);
    await writeFile(collisionPath, "other-writer", { mode: 0o600 });

    await expect(
      writeAtomicPrivateJson(filePath, { version: "new" }, { uniqueSuffix: () => "collision" }),
    ).rejects.toThrow(/atomic json/i);

    expect(await readFile(filePath, "utf8")).toBe("canonical-old");
    expect(await readFile(collisionPath, "utf8")).toBe("other-writer");
  });

  it("removes only its own temporary file when rename fails", async () => {
    const filePath = await temporaryPath("state.json");
    await mkdir(filePath, { recursive: true, mode: 0o700 });
    const parent = dirname(filePath);

    await expect(
      writeAtomicPrivateJson(filePath, { version: "new" }, { uniqueSuffix: () => "owned" }),
    ).rejects.toThrow(/atomic json/i);

    await expect(readFile(join(parent, ".state.json.owned.tmp"), "utf8")).rejects.toThrow();
    expect((await stat(filePath)).isDirectory()).toBe(true);
  });

  it("never renames a replacement installed over its temporary file", async () => {
    const filePath = await temporaryPath();
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, "canonical-old", { mode: 0o600 });
    const replacementSource = join(dirname(filePath), "pre-rename-other-writer");
    await writeFile(replacementSource, "other-writer", { mode: 0o600 });
    let replacementPath = "";

    await expect(
      writeAtomicPrivateJson(filePath, { version: "new" }, {
        uniqueSuffix: () => "pre-rename-replacement",
        beforeRename: async (temporaryPath: string) => {
          replacementPath = temporaryPath;
          await rename(replacementSource, temporaryPath);
        },
      }),
    ).rejects.toThrow(/atomic json/i);

    expect(await readFile(filePath, "utf8")).toBe("canonical-old");
    expect(await readFile(replacementPath, "utf8")).toBe("other-writer");
  });

  it("never cleans up a replacement installed over its temporary file on failure", async () => {
    const filePath = await temporaryPath();
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, "canonical-old", { mode: 0o600 });
    const replacementSource = join(dirname(filePath), "cleanup-other-writer");
    await writeFile(replacementSource, "other-writer", { mode: 0o600 });
    let replacementPath = "";

    await expect(
      writeAtomicPrivateJson(filePath, { version: "new" }, {
        uniqueSuffix: () => "cleanup-replacement",
        beforeRename: async (temporaryPath: string) => {
          replacementPath = temporaryPath;
          await rename(replacementSource, temporaryPath);
          throw new Error("injected rename failure");
        },
      }),
    ).rejects.toThrow(/atomic json/i);

    expect(await readFile(filePath, "utf8")).toBe("canonical-old");
    expect(await readFile(replacementPath, "utf8")).toBe("other-writer");
  });

  it("rejects a symlinked write destination without replacing it or touching its target", async () => {
    const filePath = await temporaryPath();
    const targetPath = join(dirname(filePath), "outside-state.json");
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(targetPath, "outside-state", { mode: 0o600 });
    await symlink(targetPath, filePath);

    await expect(writeAtomicPrivateJson(filePath, { version: "new" })).rejects.toThrow(/atomic json/i);

    expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
    expect(await readFile(targetPath, "utf8")).toBe("outside-state");
  });

  it("rejects an existing symlink component before creating or chmodding through it", async () => {
    const filePath = await temporaryPath();
    const root = dirname(dirname(filePath));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "grandbox-atomic-outside-")));
    await mkdir(join(root, "anchor"));
    await mkdir(join(outside, "runtime"));
    await chmod(join(outside, "runtime"), 0o755);
    await symlink(outside, join(root, "anchor", "linked"));
    const escapedPath = join(root, "anchor", "linked", "runtime", "state.json");

    await expect(writeAtomicPrivateJson(escapedPath, { version: "new" })).rejects.toThrow(/atomic json/i);

    await expect(lstat(join(outside, "runtime", "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(outside, "runtime"))).mode & 0o777).toBe(0o755);
  });

  it("rejects relative and NUL-containing paths before filesystem mutation", async () => {
    const filePath = await temporaryPath();
    const relativePath = relative(process.cwd(), filePath);

    await expect(writeAtomicPrivateJson(relativePath, { safe: true })).rejects.toThrow(/atomic json/i);
    await expect(writeAtomicPrivateJson(`${filePath}\0suffix`, { safe: true })).rejects.toThrow(/atomic json/i);
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["NaN", { value: Number.NaN }],
    ["infinity", { value: Number.POSITIVE_INFINITY }],
    ["undefined property", { value: undefined }],
    ["top-level undefined", undefined],
  ])("rejects non-JSON %s without replacing the canonical file", async (_label, value) => {
    const filePath = await temporaryPath();
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, "canonical-old", { mode: 0o600 });

    await expect(writeAtomicPrivateJson(filePath, value as never)).rejects.toThrow(/atomic json/i);

    expect(await readFile(filePath, "utf8")).toBe("canonical-old");
  });

  it("rejects sparse arrays, cycles, accessors, custom prototypes, and serialization hooks", async () => {
    const invalidValues: unknown[] = [];
    const sparse = new Array<unknown>(2);
    sparse[1] = true;
    invalidValues.push(sparse);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    invalidValues.push(cyclic);
    let accessorCalls = 0;
    invalidValues.push(
      Object.defineProperty({}, "value", {
        enumerable: true,
        get: () => {
          accessorCalls += 1;
          return true;
        },
      }),
    );
    invalidValues.push(Object.assign(Object.create({ inherited: true }) as object, { safe: true }));
    let serializationHookCalls = 0;
    invalidValues.push({
      toJSON: () => {
        serializationHookCalls += 1;
        return { safe: true };
      },
    });

    for (const value of invalidValues) {
      const filePath = await temporaryPath();
      await expect(writeAtomicPrivateJson(filePath, value as never)).rejects.toThrow(/atomic json/i);
      await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(accessorCalls).toBe(0);
    expect(serializationHookCalls).toBe(0);
  });

  it("rejects proxies before invoking any trap or serializing the caller object", async () => {
    const filePath = await temporaryPath();
    let trapCalls = 0;
    const target = { safe: true };
    const proxy = new Proxy(target, {
      getPrototypeOf: () => {
        trapCalls += 1;
        return Object.prototype;
      },
      ownKeys: () => {
        trapCalls += 1;
        return ["safe"];
      },
      getOwnPropertyDescriptor: (_value, key) => {
        trapCalls += 1;
        return Object.getOwnPropertyDescriptor(target, key);
      },
      get: (value, key, receiver) => {
        trapCalls += 1;
        if (key === "toJSON") {
          return () => ({ injected: true });
        }
        return Reflect.get(value, key, receiver);
      },
    });

    await expect(writeAtomicPrivateJson(filePath, proxy as never)).rejects.toThrow(/atomic json/i);

    expect(trapCalls).toBe(0);
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes snapshots without invoking inherited serialization hooks", async () => {
    const filePath = await temporaryPath();
    const originalObjectHook = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const originalArrayHook = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    let serializationHookCalls = 0;
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: () => {
        serializationHookCalls += 1;
        return { injected: true };
      },
    });
    Object.defineProperty(Array.prototype, "toJSON", {
      configurable: true,
      value: () => {
        serializationHookCalls += 1;
        return ["injected"];
      },
    });

    try {
      await writeAtomicPrivateJson(filePath, { nested: [true, { value: "kept" }] });
    } finally {
      if (originalObjectHook === undefined) {
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      } else {
        Object.defineProperty(Object.prototype, "toJSON", originalObjectHook);
      }
      if (originalArrayHook === undefined) {
        delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON;
      } else {
        Object.defineProperty(Array.prototype, "toJSON", originalArrayHook);
      }
    }

    expect(serializationHookCalls).toBe(0);
    expect(await readFile(filePath, "utf8")).toBe('{"nested":[true,{"value":"kept"}]}\n');
  });

  it("rejects serialized JSON beyond the fixed UTF-8 byte bound and preserves the canonical file", async () => {
    const filePath = await temporaryPath();
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, "canonical-old", { mode: 0o600 });

    await expect(
      writeAtomicPrivateJson(filePath, { value: "é".repeat(600_000) }),
    ).rejects.toThrow(/atomic json/i);

    expect(await readFile(filePath, "utf8")).toBe("canonical-old");
  });

  it("repairs the containing directory to owner-only access before writing", async () => {
    const filePath = await temporaryPath();
    await mkdir(dirname(filePath), { recursive: true, mode: 0o755 });
    await chmod(dirname(filePath), 0o755);

    await writeAtomicPrivateJson(filePath, { private: true });

    expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
  });
});
