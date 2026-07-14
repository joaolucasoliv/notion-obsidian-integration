import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { type InstallationLockOptions, withInstallationLock } from "./lock.js";

const NOW = new Date("2026-07-14T12:00:00.000Z");
const OWN_OWNER_TOKEN = "11111111-1111-4111-8111-111111111111";
const EXISTING_OWNER_TOKEN = "22222222-2222-4222-8222-222222222222";
const REPLACEMENT_OWNER_TOKEN = "33333333-3333-4333-8333-333333333333";

async function temporaryLockPath(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "grandbox-lock-")));
  return join(directory, "runtime", "sync.lock");
}

function options(
  isProcessAlive: InstallationLockOptions["isProcessAlive"],
  overrides: Partial<InstallationLockOptions> = {},
): InstallationLockOptions {
  return {
    processId: 4_242,
    now: () => NOW,
    staleAfterMs: 60_000,
    isProcessAlive,
    randomUUID: () => OWN_OWNER_TOKEN,
    ...overrides,
  } as InstallationLockOptions;
}

async function seedLock(
  lockPath: string,
  metadata: unknown,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const withOwnerToken =
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    !("ownerToken" in metadata)
      ? { ...metadata, ownerToken: EXISTING_OWNER_TOKEN }
      : metadata;
  await writeFile(lockPath, JSON.stringify(withOwnerToken), { mode });
  await chmod(lockPath, mode);
}

describe("withInstallationLock", () => {
  it("atomically creates private bounded PID/start metadata and removes its lock after success", async () => {
    const lockPath = await temporaryLockPath();

    const result = await withInstallationLock(lockPath, options(async () => null), async () => {
      const metadata = JSON.parse(await readFile(lockPath, "utf8"));
      expect(metadata).toEqual({
        schemaVersion: 1,
        pid: 4_242,
        startedAt: NOW.toISOString(),
        ownerToken: OWN_OWNER_TOKEN,
      });
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(lockPath))).mode & 0o777).toBe(0o700);
      expect((await stat(lockPath)).size).toBeLessThan(1_024);
      return "complete";
    });

    expect(result).toBe("complete");
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a live owner and never removes its lock", async () => {
    const lockPath = await temporaryLockPath();
    await seedLock(lockPath, { schemaVersion: 1, pid: 91, startedAt: "2026-07-14T10:00:00.000Z" });

    await expect(
      withInstallationLock(lockPath, options(async (pid, startedAt) => {
        expect(pid).toBe(91);
        expect(startedAt).toBe("2026-07-14T10:00:00.000Z");
        return true;
      }), async () => undefined),
    ).rejects.toThrow(/active installation lock/i);

    expect((await lstat(lockPath)).isFile()).toBe(true);
  });

  it("never removes a young lock even when its owner is known dead", async () => {
    const lockPath = await temporaryLockPath();
    let livenessCalls = 0;
    await seedLock(lockPath, { schemaVersion: 1, pid: 92, startedAt: "2026-07-14T11:59:30.000Z" });

    await expect(
      withInstallationLock(lockPath, options(async () => {
        livenessCalls += 1;
        return false;
      }), async () => undefined),
    ).rejects.toThrow(/active installation lock/i);

    expect(livenessCalls).toBe(0);
    expect((await lstat(lockPath)).isFile()).toBe(true);
  });

  it("removes an old lock only when liveness proves the owner is dead", async () => {
    const lockPath = await temporaryLockPath();
    await seedLock(lockPath, { schemaVersion: 1, pid: 93, startedAt: "2026-07-14T10:00:00.000Z" });
    let actionCalls = 0;

    await withInstallationLock(lockPath, options(async () => false), async () => {
      actionCalls += 1;
    });

    expect(actionCalls).toBe(1);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an old lock when process liveness is ambiguous or throws", async () => {
    for (const isProcessAlive of [
      async () => null,
      async () => {
        throw new Error("fixture liveness provider detail");
      },
    ]) {
      const lockPath = await temporaryLockPath();
      await seedLock(lockPath, { schemaVersion: 1, pid: 94, startedAt: "2026-07-14T10:00:00.000Z" });

      await expect(
        withInstallationLock(lockPath, options(isProcessAlive), async () => undefined),
      ).rejects.toThrow(/active installation lock/i);
      expect((await lstat(lockPath)).isFile()).toBe(true);
    }
  });

  it.each([
    ["malformed", "{not-json"],
    ["unknown schema", { schemaVersion: 1, pid: 95, startedAt: "2026-07-14T10:00:00.000Z", extra: true }],
    ["invalid PID", { schemaVersion: 1, pid: -1, startedAt: "2026-07-14T10:00:00.000Z" }],
    ["unbounded timestamp", { schemaVersion: 1, pid: 95, startedAt: "x".repeat(100) }],
  ])("keeps a lock with %s metadata because ownership is ambiguous", async (_label, metadata) => {
    const lockPath = await temporaryLockPath();
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    await writeFile(lockPath, typeof metadata === "string" ? metadata : JSON.stringify(metadata), { mode: 0o600 });

    await expect(
      withInstallationLock(lockPath, options(async () => false), async () => undefined),
    ).rejects.toThrow(/installation lock/i);

    expect((await lstat(lockPath)).isFile()).toBe(true);
  });

  it("keeps a lock with unsafe permissions", async () => {
    const lockPath = await temporaryLockPath();
    await seedLock(
      lockPath,
      { schemaVersion: 1, pid: 96, startedAt: "2026-07-14T10:00:00.000Z" },
      0o644,
    );

    await expect(
      withInstallationLock(lockPath, options(async () => false), async () => undefined),
    ).rejects.toThrow(/active installation lock/i);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o644);
  });

  it("rejects relative and NUL-containing lock paths before filesystem mutation", async () => {
    const lockPath = await temporaryLockPath();
    const relativePath = relative(process.cwd(), lockPath);
    let actionCalls = 0;

    await expect(
      withInstallationLock(relativePath, options(async () => false), async () => {
        actionCalls += 1;
      }),
    ).rejects.toThrow(/installation lock/i);
    await expect(
      withInstallationLock(`${lockPath}\0suffix`, options(async () => false), async () => {
        actionCalls += 1;
      }),
    ).rejects.toThrow(/installation lock/i);
    expect(actionCalls).toBe(0);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an existing symlink component before creating or chmodding through it", async () => {
    const lockPath = await temporaryLockPath();
    const root = dirname(dirname(lockPath));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "grandbox-lock-outside-")));
    await mkdir(join(root, "anchor"));
    await mkdir(join(outside, "runtime"));
    await chmod(join(outside, "runtime"), 0o755);
    await symlink(outside, join(root, "anchor", "linked"));
    const escapedPath = join(root, "anchor", "linked", "runtime", "sync.lock");
    let actionCalls = 0;

    await expect(
      withInstallationLock(escapedPath, options(async () => false), async () => {
        actionCalls += 1;
      }),
    ).rejects.toThrow(/installation lock/i);

    expect(actionCalls).toBe(0);
    await expect(lstat(join(outside, "runtime", "sync.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(outside, "runtime"))).mode & 0o777).toBe(0o755);
  });

  it("keeps a symlinked lock and its target", async () => {
    const lockPath = await temporaryLockPath();
    const targetPath = join(dirname(lockPath), "outside-owner.json");
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    await writeFile(
      targetPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: 97,
        startedAt: "2026-07-14T10:00:00.000Z",
        ownerToken: EXISTING_OWNER_TOKEN,
      }),
      { mode: 0o600 },
    );
    await symlink(targetPath, lockPath);

    await expect(
      withInstallationLock(lockPath, options(async () => false), async () => undefined),
    ).rejects.toThrow(/installation lock/i);
    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
    expect((await lstat(targetPath)).isFile()).toBe(true);
  });

  it("removes its own lock when the protected action fails", async () => {
    const lockPath = await temporaryLockPath();

    await expect(
      withInstallationLock(lockPath, options(async () => null), async () => {
        throw new Error("expected action failure");
      }),
    ).rejects.toThrow("expected action failure");

    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a same-inode token replacement when lock creation fails", async () => {
    const lockPath = await temporaryLockPath();
    const replacement = {
      schemaVersion: 1,
      pid: 776,
      startedAt: "2026-07-14T12:00:00.000Z",
      ownerToken: REPLACEMENT_OWNER_TOKEN,
    };
    let actionCalls = 0;

    await expect(
      withInstallationLock(
        lockPath,
        options(async () => null, {
          afterLockCreateWrite: async (observedLockPath: string) => {
            await writeFile(observedLockPath, JSON.stringify(replacement), { mode: 0o600 });
            throw new Error("injected create failure");
          },
        }),
        async () => {
          actionCalls += 1;
        },
      ),
    ).rejects.toThrow(/installation lock operation failed/i);

    expect(actionCalls).toBe(0);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement);
  });

  it("does not remove an in-place replacement lock with a different owner token", async () => {
    const lockPath = await temporaryLockPath();
    const replacement = {
      schemaVersion: 1,
      pid: 777,
      startedAt: "2026-07-14T12:00:00.000Z",
      ownerToken: REPLACEMENT_OWNER_TOKEN,
    };

    await withInstallationLock(lockPath, options(async () => null), async () => {
      await writeFile(lockPath, JSON.stringify(replacement), { mode: 0o600 });
    });

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement);
  });

  it("restores a replacement installed between release validation and quarantine", async () => {
    const lockPath = await temporaryLockPath();
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const replacementSource = join(dirname(lockPath), "release-replacement.json");
    const replacement = {
      schemaVersion: 1,
      pid: 778,
      startedAt: "2026-07-14T12:00:00.000Z",
      ownerToken: REPLACEMENT_OWNER_TOKEN,
    };
    await writeFile(replacementSource, JSON.stringify(replacement), { mode: 0o600 });
    let hookCalls = 0;

    await expect(
      withInstallationLock(
        lockPath,
        options(async () => null, {
          beforeLockQuarantine: async ({ reason, lockPath: observedLockPath }) => {
            expect(reason).toBe("release");
            hookCalls += 1;
            await rename(replacementSource, observedLockPath);
          },
        }),
        async () => "complete",
      ),
    ).resolves.toBe("complete");

    expect(hookCalls).toBe(1);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement);
  });

  it("restores a replacement installed between stale-lock validation and quarantine", async () => {
    const lockPath = await temporaryLockPath();
    await seedLock(lockPath, { schemaVersion: 1, pid: 99, startedAt: "2026-07-14T10:00:00.000Z" });
    const replacementSource = join(dirname(lockPath), "stale-replacement.json");
    const replacement = {
      schemaVersion: 1,
      pid: 779,
      startedAt: "2026-07-14T12:00:00.000Z",
      ownerToken: REPLACEMENT_OWNER_TOKEN,
    };
    await writeFile(replacementSource, JSON.stringify(replacement), { mode: 0o600 });
    let actionCalls = 0;

    await expect(
      withInstallationLock(
        lockPath,
        options(async () => false, {
          beforeLockQuarantine: async ({ reason, lockPath: observedLockPath }) => {
            expect(reason).toBe("stale");
            await rename(replacementSource, observedLockPath);
          },
        }),
        async () => {
          actionCalls += 1;
        },
      ),
    ).rejects.toThrow(/active installation lock/i);

    expect(actionCalls).toBe(0);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement);
  });

  it("never overwrites a competitor that appears while a mismatched lock is quarantined", async () => {
    const lockPath = await temporaryLockPath();
    await seedLock(lockPath, { schemaVersion: 1, pid: 100, startedAt: "2026-07-14T10:00:00.000Z" });
    const replacementSource = join(dirname(lockPath), "quarantined-replacement.json");
    const replacement = {
      schemaVersion: 1,
      pid: 780,
      startedAt: "2026-07-14T12:00:00.000Z",
      ownerToken: REPLACEMENT_OWNER_TOKEN,
    };
    const competitor = {
      schemaVersion: 1,
      pid: 781,
      startedAt: "2026-07-14T12:00:00.000Z",
      ownerToken: "44444444-4444-4444-8444-444444444444",
    };
    await writeFile(replacementSource, JSON.stringify(replacement), { mode: 0o600 });
    let quarantinePath = "";

    await expect(
      withInstallationLock(
        lockPath,
        options(async () => false, {
          beforeLockQuarantine: async ({ lockPath: observedLockPath }) => {
            await rename(replacementSource, observedLockPath);
          },
          afterLockQuarantineRename: async (context) => {
            quarantinePath = context.quarantinePath;
            await writeFile(lockPath, JSON.stringify(competitor), { mode: 0o600 });
          },
        }),
        async () => undefined,
      ),
    ).rejects.toThrow(/active installation lock/i);

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(competitor);
    expect(JSON.parse(await readFile(quarantinePath, "utf8"))).toEqual(replacement);
  });

  it("allows only one real concurrent owner", async () => {
    const lockPath = await temporaryLockPath();
    let releaseFirst!: () => void;
    let signalEntered!: () => void;
    const firstCanExit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const first = withInstallationLock(lockPath, options(async () => null), async () => {
      signalEntered();
      await firstCanExit;
      return "first";
    });
    await firstEntered;

    await expect(
      withInstallationLock(
        lockPath,
        options(async () => true, {
          processId: 5_555,
          now: () => new Date("2026-07-14T14:00:00.000Z"),
          randomUUID: () => REPLACEMENT_OWNER_TOKEN,
        } as Partial<InstallationLockOptions>),
        async () => "second",
      ),
    ).rejects.toThrow(/active installation lock/i);

    releaseFirst();
    await expect(first).resolves.toBe("first");
  });

  it("treats EPERM liveness as alive and preserves the owner lock", async () => {
    const lockPath = await temporaryLockPath();
    await seedLock(lockPath, { schemaVersion: 1, pid: 98, startedAt: "2026-07-14T10:00:00.000Z" });
    const permissionError = Object.assign(new Error("fixture permission detail"), { code: "EPERM" });

    await expect(
      withInstallationLock(
        lockPath,
        options(async () => {
          throw permissionError;
        }),
        async () => undefined,
      ),
    ).rejects.toThrow(/active installation lock/i);
    expect((await lstat(lockPath)).isFile()).toBe(true);
  });
});
