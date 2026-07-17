import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseJournalIntent, type JournalCompletionV1, type JournalIntentV1 } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import { FileJournalStore, type JournalCompactionPhase } from "./journal-store.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const INTENT_A = "33333333-3333-4333-8333-333333333333";
const INTENT_B = "44444444-4444-4444-8444-444444444444";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const TIMESTAMP = "2026-07-14T12:34:56.000Z";
const CORTEX_ROOT_ID = "55555555-5555-4555-8555-555555555555";
const CORTEX_PARTICIPANT_ID = "66666666-6666-4666-8666-666666666666";
const CORTEX_TRANSACTION_ID = "77777777-7777-4777-8777-777777777777";

function cortexIntent(id: string): JournalIntentV1 {
  return {
    schemaVersion: 1,
    id,
    installationId: INSTALLATION_ID,
    effectKind: "write-cortex-local",
    relativePath: "The Cortex.md",
    remoteId: CORTEX_ROOT_ID,
    allocationId: null,
    expectedByteHash: HASH_A,
    expectedSemanticHash: HASH_A,
    resultByteHash: HASH_B,
    resultSemanticHash: HASH_B,
    expectedRemoteEditedAt: TIMESTAMP,
    createdAt: TIMESTAMP,
    cortex: {
      rootPageId: CORTEX_ROOT_ID,
      pageId: CORTEX_ROOT_ID,
      sourcePath: "The Cortex.md",
      targetPath: "The Cortex.md",
      expectedPostcondition: {
        pageId: CORTEX_ROOT_ID,
        parentPageId: null,
        title: "The Cortex",
        relativePath: "The Cortex.md",
        byteHash: HASH_B,
        semanticHash: HASH_B,
        structureHash: HASH_A,
        editedAt: TIMESTAMP,
      },
    },
  };
}

function cortexTransactionIntent(id: string): JournalIntentV1 {
  return parseJournalIntent({
    schemaVersion: 1,
    id,
    installationId: INSTALLATION_ID,
    effectKind: "commit-cortex-tree-transaction",
    relativePath: null,
    remoteId: null,
    allocationId: null,
    expectedByteHash: null,
    expectedSemanticHash: null,
    resultByteHash: null,
    resultSemanticHash: null,
    expectedRemoteEditedAt: null,
    createdAt: TIMESTAMP,
    cortexTransaction: {
      rootPageId: CORTEX_ROOT_ID,
      transactionId: CORTEX_TRANSACTION_ID,
      manifestDigest: HASH_A,
      participantIds: [CORTEX_ROOT_ID, CORTEX_PARTICIPANT_ID],
    },
  });
}

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

function retirement(id: string): Record<string, unknown> {
  return { schemaVersion: 1, id, intent: intent(id), completion: completion() };
}

type DirectorySyncHook = (directoryPath: string, sync: () => Promise<void>) => Promise<void>;

function journalStoreWithSyncHook(journalDir: string, syncDirectory: DirectorySyncHook): FileJournalStore {
  return new FileJournalStore(journalDir, INSTALLATION_ID, { syncDirectory });
}

function journalStoreWithCompactionFault(journalDir: string, interruptedAt: JournalCompactionPhase): FileJournalStore {
  return new FileJournalStore(journalDir, INSTALLATION_ID, {
    beforeCompactionPhase: async (phase) => {
      if (phase === interruptedAt) throw new Error(`injected compaction interruption at ${phase}`);
    },
  });
}

function fastRotatingJournalStore(journalDir: string): FileJournalStore {
  return new FileJournalStore(journalDir, INSTALLATION_ID, {
    // This endurance case exercises the same begin/complete and rotation
    // transitions; dedicated cases above and below cover real fsync ordering.
    syncDirectory: async () => undefined,
    syncFile: async () => undefined,
    cacheSnapshots: true,
  });
}

async function seedCompletedRows(journal: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    await putPrivateJson(join(journal, `intent-${id}.json`), intent(id));
    await putPrivateJson(join(journal, `completion-${id}.json`), completion());
  }
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
  it("treats a missing journal leaf below an existing private runtime parent as empty", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJournalStore(join(directory, "journal"), INSTALLATION_ID);

    await expect(store.incomplete()).resolves.toEqual([]);
  });

  it.each([
    {
      name: "missing",
      arrange: async (directory: string) => join(directory, "missing-runtime-parent", "journal"),
    },
    {
      name: "symlinked",
      arrange: async (directory: string) => {
        const outside = await mkdtemp(join(tmpdir(), "grandbox-journal-parent-outside-"));
        const parent = join(directory, "symlinked-runtime-parent");
        await symlink(outside, parent);
        return join(parent, "journal");
      },
    },
    {
      name: "non-directory",
      arrange: async (directory: string) => {
        const parent = join(directory, "file-runtime-parent");
        await writeFile(parent, "not a directory", { mode: 0o600 });
        return join(parent, "journal");
      },
    },
  ])("fails closed when the immediate journal parent is $name during reads", async ({ arrange }) => {
    const directory = await temporaryDirectory();
    const store = new FileJournalStore(await arrange(directory), INSTALLATION_ID);

    await expect(store.incomplete()).rejects.toThrow(/journal store failed/i);
  });

  it("fails closed instead of recursively creating a missing journal parent", async () => {
    const directory = await temporaryDirectory();
    const missingParent = join(directory, "missing-runtime-parent");
    const store = new FileJournalStore(join(missingParent, "journal"), INSTALLATION_ID);

    await expect(store.begin(intent(INTENT_A))).rejects.toThrow(/journal store failed/i);
    await expect(readdir(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fsyncs a new journal parent entry before its journal metadata", async () => {
    const directory = await temporaryDirectory();
    const journal = join(directory, "journal");
    const synchronized: string[] = [];
    const store = journalStoreWithSyncHook(journal, async (directoryPath, sync) => {
      await sync();
      synchronized.push(directoryPath);
    });

    await store.begin(intent(INTENT_A));

    expect(synchronized.slice(0, 2)).toEqual([dirname(journal), journal]);
  });

  it("fails closed when syncing a newly created journal directory fails", async () => {
    const directory = await temporaryDirectory();
    const journal = join(directory, "journal");
    const synchronized: string[] = [];
    const store = journalStoreWithSyncHook(journal, async (directoryPath) => {
      synchronized.push(directoryPath);
      throw new Error("injected journal directory sync failure");
    });

    await expect(store.begin(intent(INTENT_A))).rejects.toThrow(/journal store failed/i);
    expect(synchronized).toEqual([dirname(journal)]);
    await expect(readdir(journal)).resolves.toEqual([]);
  });

  it("retries parent durability before a later begin after journal creation sync fails", async () => {
    const directory = await temporaryDirectory();
    const journal = join(directory, "journal");
    const synchronized: string[] = [];
    let failParentSync = true;
    const store = journalStoreWithSyncHook(journal, async (directoryPath, sync) => {
      synchronized.push(directoryPath);
      if (directoryPath === dirname(journal) && failParentSync) {
        failParentSync = false;
        throw new Error("injected initial journal parent sync failure");
      }
      await sync();
    });

    await expect(store.begin(intent(INTENT_A))).rejects.toThrow(/journal store failed/i);
    await expect(store.begin(intent(INTENT_B))).resolves.toBeUndefined();

    expect(synchronized.slice(0, 2)).toEqual([dirname(journal), dirname(journal)]);
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

  it("round-trips immutable Cortex recovery metadata through intent and retirement snapshots", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJournalStore(join(directory, "journal"), INSTALLATION_ID, { rotationThreshold: 1 });
    const cortex = cortexIntent(INTENT_A);

    await store.begin(cortex);
    await expect(store.incomplete()).resolves.toEqual([cortex]);
    await store.complete(INTENT_A, completion());
    await store.begin(intent(INTENT_B));

    await expect(store.incomplete()).resolves.toEqual([intent(INTENT_B)]);
  });

  it("round-trips Cortex transaction metadata through journal snapshots without persisting note content", async () => {
    const directory = await temporaryDirectory();
    const store = new FileJournalStore(join(directory, "journal"), INSTALLATION_ID);
    const transaction = cortexTransactionIntent(INTENT_A);
    const noteBody = "fixture-note-body-must-not-enter-transaction-journal";

    await store.begin(transaction);

    expect(await store.incomplete()).toEqual([transaction]);
    expect(JSON.stringify(await store.incomplete())).not.toContain(noteBody);
    await expect(store.begin({ ...transaction, content: noteBody } as unknown as JournalIntentV1)).rejects.toThrow(
      /journal store failed/i,
    );
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
        name: "wrong-mode retirement marker",
        arrange: async (journal) => {
          const path = join(journal, `retirement-${INTENT_A}.json`);
          await putPrivateJson(path, retirement(INTENT_A));
          await chmod(path, 0o644);
        },
      },
      {
        name: "retirement marker with an impossible intent-only remainder",
        arrange: async (journal) => {
          await putPrivateJson(join(journal, `retirement-${INTENT_A}.json`), retirement(INTENT_A));
          await putPrivateJson(join(journal, `intent-${INTENT_A}.json`), intent(INTENT_A));
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
      {
        name: "symlink retirement marker",
        arrange: async (journal) => {
          const outside = await mkdtemp(join(tmpdir(), "grandbox-journal-retirement-outside-"));
          const target = join(outside, "retirement.json");
          await putPrivateJson(target, retirement(INTENT_A));
          await symlink(target, join(journal, `retirement-${INTENT_A}.json`));
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

  it("caps outstanding journal operations at 1,024", async () => {
    const directory = await temporaryDirectory();
    const journal = await privateJournal(directory);
    for (let index = 0; index < 1_024; index += 1) {
      const id = randomUUID();
      await putPrivateJson(join(journal, `intent-${id}.json`), intent(id));
    }
    const store = new FileJournalStore(journal, INSTALLATION_ID);

    await expect(store.incomplete()).resolves.toHaveLength(1_024);
    await expect(store.begin(intent(randomUUID()))).rejects.toThrow(/journal store failed/i);
  });

  it(
    "serializes trailing-slash journal paths at 1,023 and frees completed capacity for a later begin",
    async () => {
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
      await expect(stores[1].begin(intent(randomUUID()))).resolves.toBeUndefined();
      expect((await stores[0].incomplete()).map((row) => row.id)).not.toContain(completedId);
      expect(await stores[1].incomplete()).toHaveLength(1_024);
    },
    15_000,
  );

  it(
    "permits more than 1,024 sequential begin/complete operations before a later begin",
    async () => {
      const directory = await temporaryDirectory();
      const store = fastRotatingJournalStore(join(directory, "journal"));

      for (let index = 0; index < 1_025; index += 1) {
        const id = randomUUID();
        await store.begin(intent(id));
        await store.complete(id, completion());
      }

      const later = randomUUID();
      await expect(store.begin(intent(later))).resolves.toBeUndefined();
      await expect(store.incomplete()).resolves.toEqual([intent(later)]);
    },
    60_000,
  );

  it(
    "preserves outstanding intents while rotating completed rows",
    async () => {
      const directory = await temporaryDirectory();
      const journal = await privateJournal(directory);
      await seedCompletedRows(journal, 1_023);
      const pending = randomUUID();
      const later = randomUUID();
      const store = new FileJournalStore(journal, INSTALLATION_ID);
      await store.begin(intent(pending));

      await expect(store.begin(intent(later))).resolves.toBeUndefined();

      const recovered = new FileJournalStore(journal, INSTALLATION_ID);
      expect((await recovered.incomplete()).map((row) => row.id)).toEqual([later, pending].sort());
    },
    30_000,
  );

  it.each([
    "retirement-written",
    "intent-removed",
    "completion-removed",
    "retirement-removed",
  ] as const)("recovers an interrupted completed-row rotation at %s without completing another outstanding intent", async (phase) => {
    const directory = await temporaryDirectory();
    const journal = await privateJournal(directory);
    await seedCompletedRows(journal, 1_023);
    const pending = randomUUID();
    const first = new FileJournalStore(journal, INSTALLATION_ID);
    await first.begin(intent(pending));

    const faulting = journalStoreWithCompactionFault(journal, phase);
    await expect(faulting.begin(intent(randomUUID()))).rejects.toThrow(/journal store failed/i);

    if (phase === "retirement-written") {
      const marker = (await readdir(journal)).find((entry) => entry.startsWith("retirement-"));
      if (marker === undefined) throw new Error("expected a durable retirement marker");
      expect((await lstat(join(journal, marker))).mode & 0o777).toBe(0o600);
    }

    const recovered = new FileJournalStore(journal, INSTALLATION_ID);
    await expect(recovered.incomplete()).resolves.toEqual([intent(pending)]);
    await expect(recovered.begin(intent(randomUUID()))).resolves.toBeUndefined();
  }, 30_000);

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
