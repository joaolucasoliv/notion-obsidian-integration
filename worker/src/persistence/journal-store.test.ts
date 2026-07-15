import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JournalCompletionV1, JournalIntentV1 } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import { FileJournalStore } from "./journal-store.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const INTENT_A = "33333333-3333-4333-8333-333333333333";
const INTENT_B = "44444444-4444-4444-8444-444444444444";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const TIMESTAMP = "2026-07-14T12:34:56.000Z";

function intent(id: string, overrides: Partial<JournalIntentV1> = {}): JournalIntentV1 {
  return {
    schemaVersion: 1,
    id,
    installationId: INSTALLATION_ID,
    effectKind: "write-local",
    relativePath: "Notes/Bridge.md",
    remoteId: null,
    allocationId: null,
    expectedByteHash: HASH_A,
    expectedSemanticHash: null,
    resultByteHash: HASH_B,
    resultSemanticHash: null,
    expectedRemoteEditedAt: null,
    createdAt: TIMESTAMP,
    ...overrides,
  };
}

function completion(): JournalCompletionV1 {
  return {
    schemaVersion: 1,
    resultByteHash: HASH_B,
    resultSemanticHash: null,
    resultRemoteId: null,
    allocatedBridgeId: null,
    observedRemoteEditedAt: null,
    completedAt: TIMESTAMP,
  };
}

async function privateJournal(directory: string): Promise<string> {
  const journal = join(directory, "journal");
  await mkdir(journal, { mode: 0o700 });
  await chmod(journal, 0o700);
  return journal;
}

async function temporaryDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "grandbox-journal-store-")));
}

async function putPrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
}

describe("FileJournalStore", () => {
  it("starts empty from a missing private journal directory", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJournalStore(join(directory, "journal"), INSTALLATION_ID);

    await expect(store.incomplete()).resolves.toEqual([]);
  });

  it("persists private intents in deterministic ID order without note bodies", async () => {
    const directory = await temporaryDirectory();
    const journal = join(directory, "journal");
    const store = new FileJournalStore(journal, INSTALLATION_ID);
    await store.begin(intent(INTENT_B));
    await store.begin(intent(INTENT_A));

    expect((await store.incomplete()).map((row) => row.id)).toEqual([INTENT_A, INTENT_B]);
    expect(await readdir(journal)).toEqual([
      `intent-${INTENT_A}.json`,
      `intent-${INTENT_B}.json`,
    ]);
    expect((await lstat(journal)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(journal, `intent-${INTENT_A}.json`))).mode & 0o777).toBe(0o600);
  });

  it("makes begin and complete exclusive, including concurrent duplicate races", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJournalStore(join(directory, "journal"), INSTALLATION_ID);
    const beginSettled = await Promise.allSettled([store.begin(intent(INTENT_A)), store.begin(intent(INTENT_A))]);

    expect(beginSettled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(beginSettled.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    await expect(store.begin(intent(INTENT_A))).rejects.toThrow(/journal store failed/i);
    const settled = await Promise.allSettled([store.complete(INTENT_A, completion()), store.complete(INTENT_A, completion())]);

    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    await expect(store.incomplete()).resolves.toEqual([]);
  });

  it("fails closed for corrupt, unknown, unmatched, cross-installation, symlink, and wrong-mode rows", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly arrange: (journal: string) => Promise<void>;
    }> = [
      {
        name: "unknown filename",
        arrange: async (journal) => putPrivateJson(join(journal, "unknown.json"), { safe: true }),
      },
      {
        name: "truncated intent",
        arrange: async (journal) => {
          const path = join(journal, `intent-${INTENT_A}.json`);
          await writeFile(path, "{", { mode: 0o600 });
          await chmod(path, 0o600);
        },
      },
      {
        name: "unmatched completion",
        arrange: async (journal) => putPrivateJson(join(journal, `completion-${INTENT_A}.json`), completion()),
      },
      {
        name: "cross installation intent",
        arrange: async (journal) =>
          putPrivateJson(
            join(journal, `intent-${INTENT_A}.json`),
            intent(INTENT_A, { installationId: OTHER_INSTALLATION_ID }),
          ),
      },
      {
        name: "filename identity mismatch",
        arrange: async (journal) => putPrivateJson(join(journal, `intent-${INTENT_A}.json`), intent(INTENT_B)),
      },
      {
        name: "wrong mode",
        arrange: async (journal) => {
          const path = join(journal, `intent-${INTENT_A}.json`);
          await putPrivateJson(path, intent(INTENT_A));
          await chmod(path, 0o644);
        },
      },
      {
        name: "wrong journal directory mode",
        arrange: async (journal) => {
          await chmod(journal, 0o755);
        },
      },
      {
        name: "symlink row",
        arrange: async (journal) => {
          const outside = await mkdtemp(join(tmpdir(), "grandbox-journal-outside-"));
          const target = join(outside, "intent.json");
          await putPrivateJson(target, intent(INTENT_A));
          await symlink(target, join(journal, `intent-${INTENT_A}.json`));
        },
      },
    ];

    for (const testCase of cases) {
      const directory = await temporaryDirectory();
      const journal = await privateJournal(directory);
      await testCase.arrange(journal);
      const store = new FileJournalStore(journal, INSTALLATION_ID);

      await expect(store.incomplete(), testCase.name).rejects.toThrow(/journal store failed/i);
    }
  });

  it("caps journal operation IDs at 1,024", async () => {
    const directory = await temporaryDirectory();
    const journal = await privateJournal(directory);
    for (let index = 0; index < 1_025; index += 1) {
      const id = randomUUID();
      await putPrivateJson(join(journal, `intent-${id}.json`), intent(id));
    }
    const store = new FileJournalStore(journal, INSTALLATION_ID);

    await expect(store.incomplete()).rejects.toThrow(/journal store failed/i);
  });

  it("serializes trailing-slash journal paths at 1,023, permits completion at 1,024, and rejects an extra begin", async () => {
    const directory = await temporaryDirectory();
    const journal = await privateJournal(directory);
    for (let index = 0; index < 1_023; index += 1) {
      const id = randomUUID();
      await putPrivateJson(join(journal, `intent-${id}.json`), intent(id));
    }
    const stores = [
      new FileJournalStore(journal, INSTALLATION_ID),
      new FileJournalStore(`${journal}/`, INSTALLATION_ID),
    ] as const;
    const contenders = [randomUUID(), randomUUID()] as const;
    const settled = await Promise.allSettled(contenders.map((id, index) => stores[index].begin(intent(id))));

    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);

    const completedId = contenders.find((_, index) => settled[index]?.status === "fulfilled");
    if (completedId === undefined) {
      throw new Error("expected one concurrent begin to succeed");
    }
    await expect(stores[0].complete(completedId, completion())).resolves.toBeUndefined();
    await expect(stores[1].begin(intent(randomUUID()))).rejects.toThrow(/journal store failed/i);
    expect(await readdir(journal)).toHaveLength(1_025);
    expect((await stores[0].incomplete()).map((row) => row.id)).not.toContain(completedId);
    expect(await stores[1].incomplete()).toHaveLength(1_023);
  });

  it("does not persist an attempted note-body field or reflect its canary", async () => {
    const directory = await temporaryDirectory();
    const journal = join(directory, "journal");
    const store = new FileJournalStore(journal, INSTALLATION_ID);
    const canary = "fixture-note-body-must-not-enter-journal";
    const unsafeIntent = { ...intent(INTENT_A), content: canary } as unknown as JournalIntentV1;

    const error = await store.begin(unsafeIntent).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/journal store failed/i);
    expect(String(error)).not.toContain(canary);
    await expect(readdir(journal)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
