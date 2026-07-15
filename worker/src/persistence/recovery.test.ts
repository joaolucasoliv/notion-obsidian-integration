import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JournalCompletionV1, JournalIntentV1 } from "@grandbox-bridge/shared";
import { describe, expect, it, vi } from "vitest";
import { FileJournalStore, type JournalStore } from "./journal-store.js";
import {
  recoverIncompleteJournal,
  type LocalRecoveryObserver,
  type RemoteRecoveryObserver,
} from "./recovery.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_A = "33333333-3333-4333-8333-333333333333";
const INTENT_B = "44444444-4444-4444-8444-444444444444";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const TIMESTAMP = "2026-07-14T12:34:56.000Z";
const BRIDGE_ID = "55555555-5555-4555-8555-555555555555";

function intent(
  id: string,
  effectKind: JournalIntentV1["effectKind"] = "write-local",
  overrides: Partial<JournalIntentV1> = {},
): JournalIntentV1 {
  return {
    schemaVersion: 1,
    id,
    installationId: INSTALLATION_ID,
    effectKind,
    relativePath: effectKind === "write-local" || effectKind === "create-conflict" ? "Notes/Bridge.md" : null,
    remoteId: null,
    allocationId: null,
    expectedByteHash: effectKind === "create-conflict" ? null : HASH_A,
    expectedSemanticHash: null,
    resultByteHash: effectKind === "initialize-pair" ? null : HASH_B,
    resultSemanticHash: null,
    expectedRemoteEditedAt: null,
    createdAt: TIMESTAMP,
    ...overrides,
  };
}

function evidence(resultByteHash: string | null = HASH_B): JournalCompletionV1 {
  return {
    schemaVersion: 1,
    resultByteHash,
    resultSemanticHash: null,
    resultRemoteId: null,
    allocatedBridgeId: null,
    observedRemoteEditedAt: null,
    completedAt: TIMESTAMP,
  };
}

class MemoryJournalStore implements JournalStore {
  public readonly completed: Array<{ readonly id: string; readonly evidence: JournalCompletionV1 }> = [];

  public constructor(private readonly pending: readonly JournalIntentV1[]) {}

  public async begin(): Promise<void> {}

  public async complete(id: string, completedEvidence: JournalCompletionV1): Promise<void> {
    this.completed.push({ id, evidence: completedEvidence });
  }

  public async incomplete(): Promise<readonly JournalIntentV1[]> {
    return this.pending;
  }
}

function local(observation: Awaited<ReturnType<LocalRecoveryObserver["observe"]>>): LocalRecoveryObserver {
  return { observe: async () => observation };
}

function remote(result: Awaited<ReturnType<RemoteRecoveryObserver["classify"]>>): RemoteRecoveryObserver {
  return { classify: async () => result };
}

async function temporaryDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "grandbox-recovery-")));
}

describe("recoverIncompleteJournal", () => {
  it("reports a clean local recovery when the journal is empty", async () => {
    const result = await recoverIncompleteJournal({
      journal: {
        begin: async () => undefined,
        complete: async () => undefined,
        incomplete: async () => [],
      },
      localObserver: { observe: async () => ({ kind: "missing" as const }) },
      remoteObserver: { classify: async () => ({ kind: "unprovable" as const }) },
    });

    expect(result.status).toBe("clean");
  });

  it.each([
    {
      name: "missing",
      arrange: async (directory: string) => join(directory, "missing-runtime-parent", "journal"),
    },
    {
      name: "symlinked",
      arrange: async (directory: string) => {
        const outside = await mkdtemp(join(tmpdir(), "grandbox-recovery-parent-outside-"));
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
  ])("requires recovery when FileJournalStore reads through a $name parent", async ({ arrange }) => {
    const directory = await temporaryDirectory();
    const observe = vi.fn<LocalRecoveryObserver["observe"]>();
    const classify = vi.fn<RemoteRecoveryObserver["classify"]>();

    const result = await recoverIncompleteJournal({
      journal: new FileJournalStore(await arrange(directory), INSTALLATION_ID),
      localObserver: { observe },
      remoteObserver: { classify },
    });

    expect(result).toMatchObject({ status: "recovery-required", processed: 0, reconciled: 0, retryable: 0 });
    expect(observe).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it("marks a write crash before mutation as retryable with pre-state evidence", async () => {
    const journal = new MemoryJournalStore([intent(INTENT_A)]);

    const result = await recoverIncompleteJournal({
      journal,
      localObserver: local({ kind: "present", byteHash: HASH_A, semanticHash: null }),
      remoteObserver: remote({ kind: "unprovable" }),
      now: () => TIMESTAMP,
    });

    expect(result).toMatchObject({ status: "retryable", retryable: 1, reconciled: 0 });
    expect(journal.completed).toEqual([{ id: INTENT_A, evidence: evidence(HASH_A) }]);
  });

  it("marks an initialize-pair crash before the frontmatter write as retryable instead of treating it as a remote operation", async () => {
    const journal = new MemoryJournalStore([
      intent(INTENT_A, "initialize-pair", {
        relativePath: "Notes/Bridge.md",
        expectedByteHash: HASH_A,
        resultByteHash: HASH_B,
      }),
    ]);

    const result = await recoverIncompleteJournal({
      journal,
      localObserver: local({ kind: "present", byteHash: HASH_A, semanticHash: HASH_C }),
      remoteObserver: remote({ kind: "unprovable" }),
      now: () => TIMESTAMP,
    });

    expect(result).toMatchObject({ status: "retryable", retryable: 1, reconciled: 0 });
    expect(journal.completed).toEqual([{
      id: INTENT_A,
      evidence: { ...evidence(HASH_A), resultSemanticHash: HASH_C },
    }]);
  });

  it("reconciles a write crash after atomic rename but before journal completion", async () => {
    const journal = new MemoryJournalStore([intent(INTENT_A)]);

    const result = await recoverIncompleteJournal({
      journal,
      localObserver: local({ kind: "present", byteHash: HASH_B, semanticHash: null }),
      remoteObserver: remote({ kind: "unprovable" }),
      now: () => TIMESTAMP,
    });

    expect(result).toMatchObject({ status: "reconciled", reconciled: 1, retryable: 0 });
    expect(journal.completed).toEqual([{ id: INTENT_A, evidence: evidence(HASH_B) }]);
  });

  it("preserves the proven Bridge ID when recovering an initialize-pair post-write", async () => {
    const journal = new MemoryJournalStore([
      intent(INTENT_A, "initialize-pair", {
        relativePath: "Notes/Bridge.md",
        expectedByteHash: HASH_A,
        resultByteHash: HASH_B,
      }),
    ]);

    const result = await recoverIncompleteJournal({
      journal,
      localObserver: local({
        kind: "present",
        byteHash: HASH_B,
        semanticHash: HASH_C,
        bridgeId: BRIDGE_ID,
      } as never),
      remoteObserver: remote({ kind: "unprovable" }),
      now: () => TIMESTAMP,
    });

    expect(result).toMatchObject({ status: "reconciled", reconciled: 1, retryable: 0 });
    expect(journal.completed).toEqual([{
      id: INTENT_A,
      evidence: { ...evidence(HASH_B), resultSemanticHash: HASH_C, allocatedBridgeId: BRIDGE_ID },
    }]);
  });

  it("recovers an initialize-pair before failing closed at its pending state commit fence", async () => {
    const commitId = "11111111-1111-4111-8111-111111111111";
    const journal = new MemoryJournalStore([
      intent(commitId, "commit-state", {
        relativePath: null,
        remoteId: null,
        allocationId: null,
        expectedByteHash: null,
        expectedSemanticHash: null,
        resultByteHash: null,
        resultSemanticHash: null,
        expectedRemoteEditedAt: null,
      }),
      intent(INTENT_A, "initialize-pair", {
        relativePath: "Notes/Bridge.md",
        expectedByteHash: HASH_A,
        resultByteHash: HASH_B,
      }),
    ]);

    const result = await recoverIncompleteJournal({
      journal,
      localObserver: local({ kind: "present", byteHash: HASH_B, semanticHash: HASH_C, bridgeId: BRIDGE_ID }),
      remoteObserver: remote({ kind: "unprovable" }),
      now: () => TIMESTAMP,
    });

    expect(result).toMatchObject({
      status: "recovery-required",
      processed: 1,
      reconciled: 1,
      blockedId: commitId,
    });
    expect(journal.completed).toEqual([{
      id: INTENT_A,
      evidence: { ...evidence(HASH_B), resultSemanticHash: HASH_C, allocatedBridgeId: BRIDGE_ID },
    }]);
  });

  it("marks a missing conflict target as retryable before a create mutation", async () => {
    const journal = new MemoryJournalStore([intent(INTENT_A, "create-conflict")]);

    const result = await recoverIncompleteJournal({
      journal,
      localObserver: local({ kind: "missing" }),
      remoteObserver: remote({ kind: "unprovable" }),
      now: () => TIMESTAMP,
    });

    expect(result).toMatchObject({ status: "retryable", retryable: 1 });
    expect(journal.completed).toEqual([{ id: INTENT_A, evidence: evidence(null) }]);
  });

  it("fails closed when a create-conflict intent claims both absence and a baseline", async () => {
    const journal = new MemoryJournalStore([
      intent(INTENT_A, "create-conflict", { expectedByteHash: HASH_A }),
    ]);

    const result = await recoverIncompleteJournal({
      journal,
      localObserver: local({ kind: "missing" }),
      remoteObserver: remote({ kind: "unprovable" }),
    });

    expect(result).toMatchObject({ status: "recovery-required", blockedId: INTENT_A });
    expect(journal.completed).toEqual([]);
  });

  it("leaves an unexpected local state incomplete and requires recovery", async () => {
    const journal = new MemoryJournalStore([intent(INTENT_A)]);

    const result = await recoverIncompleteJournal({
      journal,
      localObserver: local({ kind: "present", byteHash: HASH_C, semanticHash: null }),
      remoteObserver: remote({ kind: "unprovable" }),
    });

    expect(result).toMatchObject({ status: "recovery-required", blockedId: INTENT_A });
    expect(journal.completed).toEqual([]);
  });

  it.each([
    ["pre", "retryable"],
    ["post", "reconciled"],
  ] as const)("completes an explicit remote %s classification exactly once", async (kind, expectedStatus) => {
    const journal = new MemoryJournalStore([intent(INTENT_A, "update-notion-properties")]);
    const classify = vi.fn<RemoteRecoveryObserver["classify"]>().mockResolvedValue({ kind, evidence: evidence() });

    const result = await recoverIncompleteJournal({
      journal,
      localObserver: local({ kind: "missing" }),
      remoteObserver: { classify },
    });

    expect(result.status).toBe(expectedStatus);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith(intent(INTENT_A, "update-notion-properties"));
    expect(journal.completed).toEqual([{ id: INTENT_A, evidence: evidence() }]);
  });

  it("fails closed for an unprovable remote effect or observer exception", async () => {
    const unprovableJournal = new MemoryJournalStore([intent(INTENT_A, "update-notion-properties")]);
    const unprovable = await recoverIncompleteJournal({
      journal: unprovableJournal,
      localObserver: local({ kind: "missing" }),
      remoteObserver: remote({ kind: "unprovable" }),
    });
    expect(unprovable.status).toBe("recovery-required");
    expect(unprovableJournal.completed).toEqual([]);

    const throwingJournal = new MemoryJournalStore([intent(INTENT_A, "update-notion-properties")]);
    const throwing = await recoverIncompleteJournal({
      journal: throwingJournal,
      localObserver: local({ kind: "missing" }),
      remoteObserver: { classify: async () => Promise.reject(new Error("provider secret")) },
    });
    expect(throwing.status).toBe("recovery-required");
    expect(JSON.stringify(throwing)).not.toContain("provider secret");
    expect(throwingJournal.completed).toEqual([]);
  });

  it("sorts intents and stops at the first unrecoverable effect", async () => {
    const journal = new MemoryJournalStore([
      intent(INTENT_B, "update-notion-properties"),
      intent(INTENT_A, "update-notion-properties"),
    ]);
    const calls: string[] = [];
    const result = await recoverIncompleteJournal({
      journal,
      localObserver: local({ kind: "missing" }),
      remoteObserver: {
        classify: async (pending) => {
          calls.push(pending.id);
          return { kind: "unprovable" };
        },
      },
    });

    expect(result).toMatchObject({ status: "recovery-required", blockedId: INTENT_A });
    expect(calls).toEqual([INTENT_A]);
    expect(journal.completed).toEqual([]);
  });

  it("fails closed above the 1,024-operation cap and on invalid observer evidence", async () => {
    const overCap = new MemoryJournalStore(
      Array.from({ length: 1_025 }, (_, index) => intent(`${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`)),
    );
    const classify = vi.fn<RemoteRecoveryObserver["classify"]>();
    const capped = await recoverIncompleteJournal({
      journal: overCap,
      localObserver: local({ kind: "missing" }),
      remoteObserver: { classify },
    });
    expect(capped.status).toBe("recovery-required");
    expect(classify).not.toHaveBeenCalled();

    const invalidJournal = new MemoryJournalStore([intent(INTENT_A, "update-notion-properties")]);
    const invalid = await recoverIncompleteJournal({
      journal: invalidJournal,
      localObserver: local({ kind: "missing" }),
      remoteObserver: remote({ kind: "post", evidence: { ...evidence(), resultByteHash: "not-a-hash" } as JournalCompletionV1 }),
    });
    expect(invalid.status).toBe("recovery-required");
    expect(invalidJournal.completed).toEqual([]);
  });

  it("keeps a forged note body canary out of the recovery result", async () => {
    const canary = "fixture-note-body-must-not-enter-recovery-result";
    const journal = new MemoryJournalStore([{ ...intent(INTENT_A), content: canary } as unknown as JournalIntentV1]);

    const result = await recoverIncompleteJournal({
      journal,
      localObserver: local({ kind: "missing" }),
      remoteObserver: remote({ kind: "unprovable" }),
    });

    expect(result.status).toBe("recovery-required");
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(journal.completed).toEqual([]);
  });
});
