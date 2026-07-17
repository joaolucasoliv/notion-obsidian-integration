import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256Hex, type CortexTreeTransactionPlan } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import { createCortexTreeTransactionManifest } from "./cortex-transaction.js";
import { canonicalVaultRoot } from "./safety.js";
import { scanCortexVaultNotes } from "./scanner.js";
import {
  AtomicVaultWriter,
  type AtomicVaultWriterTestHooks,
  type CortexTreeTransactionWriter,
} from "./writer.js";
import { CortexTreeHarness } from "../../../tests/fakes/cortex-tree-harness.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const CORTEX_MOVE_LOCK_OWNER_FILENAME = "owner.json";
const CORTEX_ROOT_PAGE_ID = "10000000-0000-4000-8000-000000000000";
const CANDIDATE_TRANSACTION_ID = "20000000-0000-4000-8000-000000000000";
const REPARENT_TRANSACTION_ID = "30000000-0000-4000-8000-000000000000";
const RESTART_TRANSACTION_ID = "40000000-0000-4000-8000-000000000000";
const CANDIDATE_MEMBER_ID = "21000000-0000-4000-8000-000000000000";
const CANDIDATE_PARENT_MEMBER_ID = "22000000-0000-4000-8000-000000000000";
const OLD_PARENT_MEMBER_ID = "31000000-0000-4000-8000-000000000000";
const NEW_PARENT_MEMBER_ID = "32000000-0000-4000-8000-000000000000";
const MOVE_MEMBER_ID = "33000000-0000-4000-8000-000000000000";
const MOVED_PAGE_MEMBER_ID = "34000000-0000-4000-8000-000000000000";
const DESCENDANT_MEMBER_ID = "35000000-0000-4000-8000-000000000000";
const RESTART_WRITE_MEMBER_ID = "41000000-0000-4000-8000-000000000000";
const RESTART_CREATE_MEMBER_ID = "42000000-0000-4000-8000-000000000000";

async function temporaryVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), "grandbox-writer-"));
}

function cortexMoveLockPath(vault: string): string {
  return join(vault, ".obsidian", "grandbox-bridge", "cortex-move.lock");
}

function cortexMoveLockOwnerPath(vault: string): string {
  return join(cortexMoveLockPath(vault), CORTEX_MOVE_LOCK_OWNER_FILENAME);
}

function cortexTransactionDirectory(vault: string, transactionId: string): string {
  return join(vault, ".obsidian", "grandbox-bridge", "cortex-transactions", transactionId);
}

function transactionWriter(writer: AtomicVaultWriter): CortexTreeTransactionWriter {
  return writer as AtomicVaultWriter & CortexTreeTransactionWriter;
}

interface TransactionMemberHook {
  readonly transactionId: string;
  readonly memberId: string;
  readonly completedMemberIds: readonly string[];
}

function transactionFailureHook(
  failureMemberId: string,
  options: Readonly<{ skipDurabilitySync?: boolean }> = {},
): AtomicVaultWriterTestHooks {
  return {
    afterCortexTransactionMember: async (input: TransactionMemberHook) => {
      if (input.memberId === failureMemberId) {
        throw new Error("synthetic transaction member interruption");
      }
    },
    ...(options.skipDurabilitySync
      ? { syncDirectory: async () => undefined, syncFile: async () => undefined }
      : {}),
  } as AtomicVaultWriterTestHooks;
}

async function candidatePlan(): Promise<Readonly<{
  plan: CortexTreeTransactionPlan;
  oldCandidate: string;
  oldParent: string;
  nextCandidate: string;
  nextParent: string;
}>> {
  const oldCandidate = "cortex_id: candidate\nparent: pending\n";
  const oldParent = "children: []\n";
  const nextCandidate = "cortex_id: bound-child\nparent: Parent\n";
  const nextParent = "children: [bound-child]\n";
  return Object.freeze({
    oldCandidate,
    oldParent,
    nextCandidate,
    nextParent,
    plan: Object.freeze({
      schemaVersion: 1,
      transactionId: CANDIDATE_TRANSACTION_ID,
      rootPageId: CORTEX_ROOT_PAGE_ID,
      participantIds: [CORTEX_ROOT_PAGE_ID],
      members: Object.freeze([
        Object.freeze({
          memberId: CANDIDATE_MEMBER_ID,
          kind: "write" as const,
          relativePath: "The Cortex/Candidate.md",
          expectedByteHash: await sha256Hex(oldCandidate),
          resultByteHash: await sha256Hex(nextCandidate),
          content: nextCandidate,
        }),
        Object.freeze({
          memberId: CANDIDATE_PARENT_MEMBER_ID,
          kind: "write" as const,
          relativePath: "The Cortex/Parent.md",
          expectedByteHash: await sha256Hex(oldParent),
          resultByteHash: await sha256Hex(nextParent),
          content: nextParent,
        }),
      ]),
    }),
  });
}

async function reparentPlan(): Promise<Readonly<{
  plan: CortexTreeTransactionPlan;
  oldOldParent: string;
  oldNewParent: string;
  oldResearch: string;
  oldDescendant: string;
  nextOldParent: string;
  nextNewParent: string;
  nextResearch: string;
  nextDescendant: string;
}>> {
  const oldOldParent = "children: [Research]\n";
  const oldNewParent = "children: []\n";
  const oldResearch = "parent: Old\n";
  const oldDescendant = "breadcrumb: Old / Research\n";
  const nextOldParent = "children: []\n";
  const nextNewParent = "children: [Research]\n";
  const nextResearch = "parent: Archive\n";
  const nextDescendant = "breadcrumb: Archive / Research\n";
  return Object.freeze({
    oldOldParent,
    oldNewParent,
    oldResearch,
    oldDescendant,
    nextOldParent,
    nextNewParent,
    nextResearch,
    nextDescendant,
    plan: Object.freeze({
      schemaVersion: 1,
      transactionId: REPARENT_TRANSACTION_ID,
      rootPageId: CORTEX_ROOT_PAGE_ID,
      participantIds: [CORTEX_ROOT_PAGE_ID],
      members: Object.freeze([
        Object.freeze({
          memberId: OLD_PARENT_MEMBER_ID,
          kind: "write" as const,
          relativePath: "The Cortex/Old.md",
          expectedByteHash: await sha256Hex(oldOldParent),
          resultByteHash: await sha256Hex(nextOldParent),
          content: nextOldParent,
        }),
        Object.freeze({
          memberId: NEW_PARENT_MEMBER_ID,
          kind: "write" as const,
          relativePath: "The Cortex/Archive.md",
          expectedByteHash: await sha256Hex(oldNewParent),
          resultByteHash: await sha256Hex(nextNewParent),
          content: nextNewParent,
        }),
        Object.freeze({
          memberId: MOVE_MEMBER_ID,
          kind: "move" as const,
          sourcePath: "The Cortex/Research.md",
          targetPath: "The Cortex/Archive/Research.md",
          expectedSourceByteHash: await sha256Hex(oldResearch),
        }),
        Object.freeze({
          memberId: MOVED_PAGE_MEMBER_ID,
          kind: "write" as const,
          relativePath: "The Cortex/Archive/Research.md",
          expectedByteHash: await sha256Hex(oldResearch),
          resultByteHash: await sha256Hex(nextResearch),
          content: nextResearch,
        }),
        Object.freeze({
          memberId: DESCENDANT_MEMBER_ID,
          kind: "write" as const,
          relativePath: "The Cortex/Archive/Research/Child.md",
          expectedByteHash: await sha256Hex(oldDescendant),
          resultByteHash: await sha256Hex(nextDescendant),
          content: nextDescendant,
        }),
      ]),
    }),
  });
}

async function seedReparentOldTopology(
  vault: string,
  group: Awaited<ReturnType<typeof reparentPlan>>,
): Promise<void> {
  await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
  await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
  await writeFile(join(vault, "The Cortex", "Old.md"), group.oldOldParent, "utf8");
  await writeFile(join(vault, "The Cortex", "Archive.md"), group.oldNewParent, "utf8");
  await writeFile(join(vault, "The Cortex", "Research.md"), group.oldResearch, "utf8");
  await writeFile(join(vault, "The Cortex", "Research", "Child.md"), group.oldDescendant, "utf8");
}

function reparentPreimages(group: Awaited<ReturnType<typeof reparentPlan>>): Readonly<Record<string, string>> {
  return {
    [OLD_PARENT_MEMBER_ID]: group.oldOldParent,
    [NEW_PARENT_MEMBER_ID]: group.oldNewParent,
    [MOVE_MEMBER_ID]: group.oldResearch,
    [MOVED_PAGE_MEMBER_ID]: group.oldResearch,
    [DESCENDANT_MEMBER_ID]: group.oldDescendant,
  };
}

async function publishReparentParentPrefix(
  vault: string,
  group: Awaited<ReturnType<typeof reparentPlan>>,
): Promise<Readonly<Record<string, { readonly file: Readonly<{ dev: string; ino: string }> }>>> {
  const oldParentPath = join(vault, "The Cortex", "Old.md");
  const newParentPath = join(vault, "The Cortex", "Archive.md");
  await writeFile(oldParentPath, group.nextOldParent, "utf8");
  await writeFile(newParentPath, group.nextNewParent, "utf8");
  return Object.freeze({
    [OLD_PARENT_MEMBER_ID]: Object.freeze({ file: await identityForPath(oldParentPath) }),
    [NEW_PARENT_MEMBER_ID]: Object.freeze({ file: await identityForPath(newParentPath) }),
  });
}

function ownedCortexNote(pageId: string, parentPageId: string | null, body: string): string {
  return `---\ncortex_tree: true\ncortex_page_id: ${pageId}\ncortex_parent_page_id: ${parentPageId ?? "null"}\ncortex_root_page_id: ${CORTEX_ROOT_PAGE_ID}\n---\n${body}`;
}

async function scannerSafeReparentPlan(): Promise<Readonly<{
  plan: CortexTreeTransactionPlan;
  root: string;
  oldOldParent: string;
  oldNewParent: string;
  oldResearch: string;
  oldDescendant: string;
  nextOldParent: string;
  nextNewParent: string;
  nextResearch: string;
  nextDescendant: string;
}>> {
  const researchPageId = MOVED_PAGE_MEMBER_ID;
  const oldOldParent = ownedCortexNote(OLD_PARENT_MEMBER_ID, CORTEX_ROOT_PAGE_ID, "children: [Research]\n");
  const oldNewParent = ownedCortexNote(NEW_PARENT_MEMBER_ID, CORTEX_ROOT_PAGE_ID, "children: []\n");
  const oldResearch = ownedCortexNote(researchPageId, OLD_PARENT_MEMBER_ID, "parent: Old\n");
  const oldDescendant = ownedCortexNote(DESCENDANT_MEMBER_ID, researchPageId, "breadcrumb: Old / Research\n");
  const nextOldParent = ownedCortexNote(OLD_PARENT_MEMBER_ID, CORTEX_ROOT_PAGE_ID, "children: []\n");
  const nextNewParent = ownedCortexNote(NEW_PARENT_MEMBER_ID, CORTEX_ROOT_PAGE_ID, "children: [Research]\n");
  const nextResearch = ownedCortexNote(researchPageId, NEW_PARENT_MEMBER_ID, "parent: Archive\n");
  const nextDescendant = ownedCortexNote(DESCENDANT_MEMBER_ID, researchPageId, "breadcrumb: Archive / Research\n");
  return Object.freeze({
    root: ownedCortexNote(CORTEX_ROOT_PAGE_ID, null, "Root\n"),
    oldOldParent,
    oldNewParent,
    oldResearch,
    oldDescendant,
    nextOldParent,
    nextNewParent,
    nextResearch,
    nextDescendant,
    plan: Object.freeze({
      schemaVersion: 1,
      transactionId: REPARENT_TRANSACTION_ID,
      rootPageId: CORTEX_ROOT_PAGE_ID,
      participantIds: [CORTEX_ROOT_PAGE_ID, OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVED_PAGE_MEMBER_ID, DESCENDANT_MEMBER_ID],
      members: Object.freeze([
        Object.freeze({
          memberId: OLD_PARENT_MEMBER_ID,
          kind: "write" as const,
          relativePath: "The Cortex/Old.md",
          expectedByteHash: await sha256Hex(oldOldParent),
          resultByteHash: await sha256Hex(nextOldParent),
          content: nextOldParent,
        }),
        Object.freeze({
          memberId: NEW_PARENT_MEMBER_ID,
          kind: "write" as const,
          relativePath: "The Cortex/Archive.md",
          expectedByteHash: await sha256Hex(oldNewParent),
          resultByteHash: await sha256Hex(nextNewParent),
          content: nextNewParent,
        }),
        Object.freeze({
          memberId: MOVE_MEMBER_ID,
          kind: "move" as const,
          sourcePath: "The Cortex/Old/Research.md",
          targetPath: "The Cortex/Archive/Research.md",
          expectedSourceByteHash: await sha256Hex(oldResearch),
        }),
        Object.freeze({
          memberId: MOVED_PAGE_MEMBER_ID,
          kind: "write" as const,
          relativePath: "The Cortex/Archive/Research.md",
          expectedByteHash: await sha256Hex(oldResearch),
          resultByteHash: await sha256Hex(nextResearch),
          content: nextResearch,
        }),
        Object.freeze({
          memberId: DESCENDANT_MEMBER_ID,
          kind: "write" as const,
          relativePath: "The Cortex/Archive/Research/Child.md",
          expectedByteHash: await sha256Hex(oldDescendant),
          resultByteHash: await sha256Hex(nextDescendant),
          content: nextDescendant,
        }),
      ]),
    }),
  });
}

async function seedScannerSafeReparentOldTopology(
  vault: string,
  group: Awaited<ReturnType<typeof scannerSafeReparentPlan>>,
): Promise<void> {
  await mkdir(join(vault, "The Cortex", "Old", "Research"), { recursive: true });
  await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
  await writeFile(join(vault, "The Cortex.md"), group.root, "utf8");
  await writeFile(join(vault, "The Cortex", "Old.md"), group.oldOldParent, "utf8");
  await writeFile(join(vault, "The Cortex", "Archive.md"), group.oldNewParent, "utf8");
  await writeFile(join(vault, "The Cortex", "Old", "Research.md"), group.oldResearch, "utf8");
  await writeFile(join(vault, "The Cortex", "Old", "Research", "Child.md"), group.oldDescendant, "utf8");
}

async function restartPlan(): Promise<Readonly<{
  plan: CortexTreeTransactionPlan;
  oldRoot: string;
  nextRoot: string;
  nextChild: string;
}>> {
  const oldRoot = "children: []\n";
  const nextRoot = "children: [Child]\n";
  const nextChild = "parent: Root\n";
  return Object.freeze({
    oldRoot,
    nextRoot,
    nextChild,
    plan: Object.freeze({
      schemaVersion: 1,
      transactionId: RESTART_TRANSACTION_ID,
      rootPageId: CORTEX_ROOT_PAGE_ID,
      participantIds: [CORTEX_ROOT_PAGE_ID],
      members: Object.freeze([
        Object.freeze({
          memberId: RESTART_WRITE_MEMBER_ID,
          kind: "write" as const,
          relativePath: "The Cortex.md",
          expectedByteHash: await sha256Hex(oldRoot),
          resultByteHash: await sha256Hex(nextRoot),
          content: nextRoot,
        }),
        Object.freeze({
          memberId: RESTART_CREATE_MEMBER_ID,
          kind: "create" as const,
          relativePath: "The Cortex/Child.md",
          expectedAbsent: true as const,
          resultByteHash: await sha256Hex(nextChild),
          content: nextChild,
        }),
      ]),
    }),
  });
}

function identityForPath(path: string): Promise<Readonly<{ dev: string; ino: string }>> {
  return lstat(path).then((entry) => Object.freeze({ dev: String(entry.dev), ino: String(entry.ino) }));
}

function forwardMovePending(input: Readonly<{
  memberId: string;
  stage: "pre-link" | "target-linked" | "companion-reserve" | "companion-reserved" | "companion-moved" | "source-unlinked";
  sourceFileIdentity: Readonly<{ dev: string; ino: string }>;
  sourceCompanionIdentity: Readonly<{ dev: string; ino: string }> | null;
  reservationIdentity?: Readonly<{ dev: string; ino: string }> | null;
}>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    memberId: input.memberId,
    kind: "move",
    moveOperation: Object.freeze({
      direction: "forward",
      stage: input.stage,
      sourceFileIdentity: input.sourceFileIdentity,
      targetFileIdentity: input.sourceFileIdentity,
      sourceCompanionIdentity: input.sourceCompanionIdentity,
      targetCompanionIdentity: input.sourceCompanionIdentity,
      reservationIdentity: input.reservationIdentity ?? null,
    }),
  });
}

function cortexMoveReservationPath(vault: string, transactionId: string, memberId: string): string {
  return join(cortexTransactionDirectory(vault, transactionId), `${memberId}.reservation`);
}

async function writeRestartManifest(input: Readonly<{
  vault: string;
  plan: CortexTreeTransactionPlan;
  phase: "prepared" | "publishing" | "rolling-back" | "committed" | "finalized";
  completedMemberIds: readonly string[];
  preimages: Readonly<Record<string, string>>;
  pendingMember?: unknown;
  rollbackPending?: unknown;
  rollbackPendingMember?: unknown;
  postIdentities?: Readonly<Record<string, unknown>>;
}>): Promise<void> {
  const directory = cortexTransactionDirectory(input.vault, input.plan.transactionId);
  const bridgeDirectory = join(input.vault, ".obsidian", "grandbox-bridge");
  const transactionsDirectory = join(bridgeDirectory, "cortex-transactions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([chmod(bridgeDirectory, 0o700), chmod(transactionsDirectory, 0o700), chmod(directory, 0o700)]);

  for (const member of input.plan.members) {
    if (member.kind === "create") continue;
    const preimage = input.preimages[member.memberId];
    if (preimage === undefined) throw new Error("missing test preimage");
    const path = join(directory, `${member.memberId}.preimage`);
    await writeFile(path, preimage, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  }

  const completed = new Set(input.completedMemberIds);
  const manifest = await createCortexTreeTransactionManifest({
    schemaVersion: 1,
    transactionId: input.plan.transactionId,
    rootPageId: input.plan.rootPageId,
    participantIds: input.plan.participantIds,
    phase: input.phase,
    completedMemberIds: input.completedMemberIds,
    pendingMember: input.pendingMember ?? null,
    ...(input.rollbackPending === undefined ? {} : { rollbackPending: input.rollbackPending }),
    ...(input.rollbackPendingMember === undefined ? {} : { rollbackPendingMember: input.rollbackPendingMember }),
    members: await Promise.all(input.plan.members.map(async (member) => {
      if (member.kind === "write") {
        const postIdentity = completed.has(member.memberId)
          ? input.postIdentities?.[member.memberId] ?? { file: await identityForPath(join(input.vault, member.relativePath)) }
          : undefined;
        return {
          memberId: member.memberId,
          kind: member.kind,
          relativePath: member.relativePath,
          expectedByteHash: member.expectedByteHash,
          resultByteHash: member.resultByteHash,
          preimageFile: `${member.memberId}.preimage`,
          ...(postIdentity === undefined ? {} : { postIdentity }),
        };
      }
      if (member.kind === "create") {
        const postIdentity = completed.has(member.memberId)
          ? input.postIdentities?.[member.memberId] ?? { file: await identityForPath(join(input.vault, member.relativePath)) }
          : undefined;
        return {
          memberId: member.memberId,
          kind: member.kind,
          relativePath: member.relativePath,
          expectedAbsent: true as const,
          resultByteHash: member.resultByteHash,
          preimageFile: null,
          ...(postIdentity === undefined ? {} : { postIdentity }),
        };
      }
      const postIdentity = completed.has(member.memberId)
        ? input.postIdentities?.[member.memberId] ?? {
          targetFile: await identityForPath(join(input.vault, member.targetPath)),
          targetDirectory: await identityForPath(join(input.vault, member.targetPath.slice(0, -3))).catch(() => null),
        }
        : undefined;
      return {
        memberId: member.memberId,
        kind: member.kind,
        sourcePath: member.sourcePath,
        targetPath: member.targetPath,
        expectedSourceByteHash: member.expectedSourceByteHash,
        resultByteHash: member.expectedSourceByteHash,
        preimageFile: `${member.memberId}.preimage`,
        ...(postIdentity === undefined ? {} : { postIdentity }),
      };
    })),
  });
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(manifestPath, 0o600);
}

async function rewriteRestartManifest(input: Readonly<{
  vault: string;
  transactionId: string;
  changes: Readonly<Record<string, unknown>>;
}>): Promise<void> {
  const manifestPath = join(cortexTransactionDirectory(input.vault, input.transactionId), "manifest.json");
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  delete parsed.manifestDigest;
  const unsigned = {
    ...parsed,
    ...input.changes,
  };
  const manifestDigest = await sha256Hex(canonicalJson(unsigned));
  await writeFile(manifestPath, `${JSON.stringify({ ...unsigned, manifestDigest })}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(manifestPath, 0o600);
}

async function rewriteRestartManifestAsRollingBack(input: Readonly<{
  vault: string;
  transactionId: string;
  rollbackPending: unknown;
}>): Promise<void> {
  await rewriteRestartManifest({
    vault: input.vault,
    transactionId: input.transactionId,
    changes: {
    phase: "rolling-back",
    pendingMember: null,
    rollbackPending: input.rollbackPending,
    },
  });
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return Object.freeze({ promise, resolve: () => resolve?.() });
}

describe("AtomicVaultWriter", () => {
  it("rejects a second Cortex move while the first writer holds the cooperative vault lock", async () => {
    const vault = await temporaryVault();
    const lockPath = cortexMoveLockPath(vault);
    const ownerPath = cortexMoveLockOwnerPath(vault);
    await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
    await mkdir(join(vault, "The Cortex", "Ideas"), { recursive: true });
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Research.md"), "research", "utf8");
    await writeFile(join(vault, "The Cortex", "Research", "Child.md"), "research child", "utf8");
    await writeFile(join(vault, "The Cortex", "Ideas.md"), "ideas", "utf8");
    await writeFile(join(vault, "The Cortex", "Ideas", "Child.md"), "ideas child", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const firstReady = deferred();
    const releaseFirst = deferred();
    let ownerRecord: unknown = null;
    const firstWriter = new AtomicVaultWriter(root, {
      beforeCortexMoveRename: async () => {
        const serialized = await readFile(ownerPath, "utf8").catch(() => null);
        ownerRecord = serialized === null ? null : JSON.parse(serialized);
        firstReady.resolve();
        await releaseFirst.promise;
      },
    });
    const secondWriter = new AtomicVaultWriter(root);

    const firstMove = firstWriter.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex("research"),
    });
    await firstReady.promise;

    try {
      await expect(secondWriter.moveCortexSubtree({
        sourcePath: "The Cortex/Ideas.md",
        targetPath: "The Cortex/Archive/Ideas.md",
        expectedSourceByteHash: await sha256Hex("ideas"),
      })).rejects.toMatchObject({ code: "active-lock", retryable: false });

      expect(ownerRecord).toMatchObject({
        schemaVersion: 1,
        ownerToken: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        startedAt: expect.any(String),
      });
      expect((await lstat(lockPath)).isDirectory()).toBe(true);
      expect(await readFile(join(vault, "The Cortex", "Research.md"), "utf8")).toBe("research");
      expect(await readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).toBe("research child");
      expect(await readFile(join(vault, "The Cortex", "Ideas.md"), "utf8")).toBe("ideas");
      expect(await readFile(join(vault, "The Cortex", "Ideas", "Child.md"), "utf8")).toBe("ideas child");
      await expect(readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(vault, "The Cortex", "Archive", "Ideas.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseFirst.resolve();
    }

    await expect(firstMove).resolves.toEqual({ byteHash: await sha256Hex("research") });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases its own Cortex move lock after a post-acquisition collision so a later valid move can acquire it", async () => {
    const vault = await temporaryVault();
    const lockPath = cortexMoveLockPath(vault);
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Research.md"), "research", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    let observedLock = false;
    const failingWriter = new AtomicVaultWriter(root, {
      beforeCortexMoveRename: async ({ targetPath }) => {
        observedLock = await lstat(lockPath).then((entry) => entry.isDirectory()).catch(() => false);
        await writeFile(targetPath, "collision", "utf8");
      },
    });

    await expect(failingWriter.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex("research"),
    })).rejects.toThrow(/vault writer failed/i);

    expect(observedLock).toBe(true);
    expect(await readFile(join(vault, "The Cortex", "Research.md"), "utf8")).toBe("research");
    expect(await readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).toBe("collision");
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    await unlink(join(vault, "The Cortex", "Archive", "Research.md"));
    const validWriter = new AtomicVaultWriter(root);
    await expect(validWriter.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex("research"),
    })).resolves.toEqual({ byteHash: await sha256Hex("research") });
  });

  it("keeps a manually pre-created Cortex move lock and reports active-lock attention", async () => {
    const vault = await temporaryVault();
    const lockPath = cortexMoveLockPath(vault);
    const ownerPath = cortexMoveLockOwnerPath(vault);
    const manualOwner = {
      schemaVersion: 1,
      ownerToken: "22222222-2222-4222-8222-222222222222",
      startedAt: "2026-07-16T12:00:00.000Z",
    };
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Research.md"), "research", "utf8");
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(ownerPath, JSON.stringify(manualOwner), { encoding: "utf8", mode: 0o600 });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root);

    await expect(writer.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex("research"),
    })).rejects.toMatchObject({ code: "active-lock", retryable: false });

    expect((await lstat(lockPath)).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual(manualOwner);
    expect(await readFile(join(vault, "The Cortex", "Research.md"), "utf8")).toBe("research");
    await expect(readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an unexpected Cortex move owner token and reports recovery attention during release", async () => {
    const vault = await temporaryVault();
    const lockPath = cortexMoveLockPath(vault);
    const ownerPath = cortexMoveLockOwnerPath(vault);
    const replacementOwner = {
      schemaVersion: 1,
      ownerToken: "33333333-3333-4333-8333-333333333333",
      startedAt: "2026-07-16T12:01:00.000Z",
    };
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Research.md"), "research", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root, {
      beforeCortexMoveRename: async () => {
        await writeFile(ownerPath, JSON.stringify(replacementOwner), { encoding: "utf8", mode: 0o600 });
      },
    });

    await expect(writer.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex("research"),
    })).rejects.toMatchObject({ code: "recovery-required", retryable: false });

    expect((await lstat(lockPath)).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual(replacementOwner);
    await expect(readFile(join(vault, "The Cortex", "Research.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).toBe("research");
  });

  it("never overwrites a destination note created after final Cortex move preflight", async () => {
    const vault = await temporaryVault();
    await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Research.md"), "research", "utf8");
    await writeFile(join(vault, "The Cortex", "Research", "Child.md"), "child", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const hooks = {
      beforeCortexMoveTargetReservation: async ({ targetPath }: Readonly<{ targetPath: string }>) => {
        await writeFile(targetPath, "late interloper", "utf8");
      },
    } as AtomicVaultWriterTestHooks & {
      readonly beforeCortexMoveTargetReservation: (paths: Readonly<{ targetPath: string }>) => Promise<void>;
    };
    const writer = new AtomicVaultWriter(root, hooks);

    await expect(writer.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex("research"),
    })).rejects.toThrow(/vault writer failed/i);

    expect(await readFile(join(vault, "The Cortex", "Research.md"), "utf8")).toBe("research");
    expect(await readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).toBe("late interloper");
    expect(await readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).toBe("child");
  });

  it("rolls back when a companion source directory appears after preflight", async () => {
    const vault = await temporaryVault();
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Research.md"), "research", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const hooks = {
      beforeCortexMoveCompanionReservation: async ({ sourceDirectoryPath }: Readonly<{ sourceDirectoryPath: string }>) => {
        await mkdir(sourceDirectoryPath);
        await writeFile(join(sourceDirectoryPath, "Late.md"), "late child", "utf8");
      },
    } as AtomicVaultWriterTestHooks & {
      readonly beforeCortexMoveCompanionReservation: (paths: Readonly<{ sourceDirectoryPath: string }>) => Promise<void>;
    };
    const writer = new AtomicVaultWriter(root, hooks);

    await expect(writer.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex("research"),
    })).rejects.toThrow(/vault writer failed/i);

    expect(await readFile(join(vault, "The Cortex", "Research.md"), "utf8")).toBe("research");
    expect(await readFile(join(vault, "The Cortex", "Research", "Late.md"), "utf8")).toBe("late child");
    await expect(readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never replaces a late target companion directory while moving a Cortex subtree", async () => {
    const vault = await temporaryVault();
    await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Research.md"), "research", "utf8");
    await writeFile(join(vault, "The Cortex", "Research", "Child.md"), "child", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const hooks = {
      beforeCortexMoveCompanionReservation: async ({ targetDirectoryPath }: Readonly<{ targetDirectoryPath: string }>) => {
        await mkdir(targetDirectoryPath);
        await writeFile(join(targetDirectoryPath, "Interloper.md"), "interloper", "utf8");
      },
    } as AtomicVaultWriterTestHooks & {
      readonly beforeCortexMoveCompanionReservation: (paths: Readonly<{ targetDirectoryPath: string }>) => Promise<void>;
    };
    const writer = new AtomicVaultWriter(root, hooks);

    await expect(writer.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex("research"),
    })).rejects.toThrow(/vault writer failed/i);

    expect(await readFile(join(vault, "The Cortex", "Research.md"), "utf8")).toBe("research");
    expect(await readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).toBe("child");
    await expect(readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(vault, "The Cortex", "Archive", "Research", "Interloper.md"), "utf8")).toBe("interloper");
  });

  it("rejects a Cortex subtree destination collision injected immediately before rename", async () => {
    const vault = await temporaryVault();
    await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Research.md"), "research", "utf8");
    await writeFile(join(vault, "The Cortex", "Research", "Child.md"), "child", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root, {
      beforeCortexMoveRename: async ({ targetPath }) => {
        await writeFile(targetPath, "interloper", "utf8");
      },
    });

    await expect(
      writer.moveCortexSubtree({
        sourcePath: "The Cortex/Research.md",
        targetPath: "The Cortex/Archive/Research.md",
        expectedSourceByteHash: await sha256Hex("research"),
      }),
    ).rejects.toThrow(/vault writer failed/i);

    expect(await readFile(join(vault, "The Cortex", "Research.md"), "utf8")).toBe("research");
    expect(await readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).toBe("interloper");
    expect(await readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).toBe("child");
  });

  it("never follows a symlink while moving a Cortex subtree", async () => {
    const vault = await temporaryVault();
    const outside = await temporaryVault();
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(join(outside, "Research.md"), "outside", "utf8");
    await symlink(join(outside, "Research.md"), join(vault, "The Cortex", "Research.md"));
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root);

    await expect(
      writer.moveCortexSubtree({
        sourcePath: "The Cortex/Research.md",
        targetPath: "The Cortex/Archive/Research.md",
        expectedSourceByteHash: await sha256Hex("outside"),
      }),
    ).rejects.toThrow(/vault writer failed/i);

    expect(await readFile(join(outside, "Research.md"), "utf8")).toBe("outside");
  });

  it("moves a Cortex page file and its paired descendant directory together", async () => {
    const vault = await temporaryVault();
    await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Research.md"), "research", "utf8");
    await writeFile(join(vault, "The Cortex", "Research", "Child.md"), "child", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root);

    await expect(writer.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex("research"),
    })).resolves.toEqual({ byteHash: await sha256Hex("research") });

    await expect(readFile(join(vault, "The Cortex", "Research.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).toBe("research");
    expect(await readFile(join(vault, "The Cortex", "Archive", "Research", "Child.md"), "utf8")).toBe("child");
  });

  it("rolls a Cortex subtree file move back when interruption happens before its paired directory move", async () => {
    const vault = await temporaryVault();
    await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Research.md"), "research", "utf8");
    await writeFile(join(vault, "The Cortex", "Research", "Child.md"), "child", "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root, {
      beforeCortexMoveDirectoryRename: async () => {
        throw new Error("injected interruption");
      },
    });

    await expect(writer.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex("research"),
    })).rejects.toThrow(/vault writer failed/i);

    expect(await readFile(join(vault, "The Cortex", "Research.md"), "utf8")).toBe("research");
    expect(await readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).toBe("child");
    await expect(readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });


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

  it("commits a candidate binding from a private manifest without storing note bytes in it", async () => {
    const vault = await temporaryVault();
    const group = await candidatePlan();
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Candidate.md"), group.oldCandidate, "utf8");
    await writeFile(join(vault, "The Cortex", "Parent.md"), group.oldParent, "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const result = await transactionWriter(new AtomicVaultWriter(root)).applyCortexTreeTransaction(group.plan);

    expect(result).toMatchObject({
      transactionId: CANDIDATE_TRANSACTION_ID,
      status: "committed",
      completedMemberIds: [CANDIDATE_MEMBER_ID, CANDIDATE_PARENT_MEMBER_ID],
      error: null,
    });
    expect(await readFile(join(vault, "The Cortex", "Candidate.md"), "utf8")).toBe(group.nextCandidate);
    expect(await readFile(join(vault, "The Cortex", "Parent.md"), "utf8")).toBe(group.nextParent);
    const manifest = await readFile(join(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID), "manifest.json"), "utf8");
    expect(manifest).not.toContain(group.oldCandidate);
    expect(manifest).not.toContain(group.nextCandidate);
    expect(await readFile(join(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID), `${CANDIDATE_MEMBER_ID}.preimage`), "utf8"))
      .toBe(group.oldCandidate);
  });

  it("keeps the Cortex harness transaction writer atomic when a later member fails", async () => {
    const group = await candidatePlan();
    const harness = new CortexTreeHarness();
    harness.localFiles.set("The Cortex/Candidate.md", group.oldCandidate);
    harness.localFiles.set("The Cortex/Parent.md", group.oldParent);
    harness.writer.failWritePaths.add("The Cortex/Parent.md");

    const result = await (harness.writer as unknown as CortexTreeTransactionWriter).applyCortexTreeTransaction(group.plan);

    expect(result).toMatchObject({ status: "rolled-back", completedMemberIds: [], error: null });
    expect(harness.localFiles.get("The Cortex/Candidate.md")).toBe(group.oldCandidate);
    expect(harness.localFiles.get("The Cortex/Parent.md")).toBe(group.oldParent);
  });

  it("rolls every candidate-group member interruption back to the exact prior marker relation", async () => {
    const group = await candidatePlan();
    for (const failureMemberId of group.plan.members.map((member) => member.memberId)) {
      const vault = await temporaryVault();
      await mkdir(join(vault, "The Cortex"), { recursive: true });
      await writeFile(join(vault, "The Cortex", "Candidate.md"), group.oldCandidate, "utf8");
      await writeFile(join(vault, "The Cortex", "Parent.md"), group.oldParent, "utf8");
      const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
      const writer = new AtomicVaultWriter(root, transactionFailureHook(failureMemberId));

      const result = await transactionWriter(writer).applyCortexTreeTransaction(group.plan);

      expect(result).toMatchObject({ status: "rolled-back", completedMemberIds: [], error: null });
      expect(await readFile(join(vault, "The Cortex", "Candidate.md"), "utf8")).toBe(group.oldCandidate);
      expect(await readFile(join(vault, "The Cortex", "Parent.md"), "utf8")).toBe(group.oldParent);
      expect(group.oldCandidate).toContain("parent: pending");
      expect(group.oldParent).toContain("children: []");
      await expect(lstat(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rolls a candidate member interruption after publish but before its durable completion checkpoint back to all-old", async () => {
    const vault = await temporaryVault();
    const group = await candidatePlan();
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Candidate.md"), group.oldCandidate, "utf8");
    await writeFile(join(vault, "The Cortex", "Parent.md"), group.oldParent, "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root, {
      afterCortexTransactionMemberPublish: async ({ memberId }) => {
        if (memberId === CANDIDATE_MEMBER_ID) throw new Error("synthetic post-publish interruption");
      },
    });

    const result = await transactionWriter(writer).applyCortexTreeTransaction(group.plan);
    expect(result).toMatchObject({ status: "rolled-back", completedMemberIds: [], error: null });
    expect(await readFile(join(vault, "The Cortex", "Candidate.md"), "utf8")).toBe(group.oldCandidate);
    expect(await readFile(join(vault, "The Cortex", "Parent.md"), "utf8")).toBe(group.oldParent);
    await expect(lstat(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls a reparent moved-page interruption after publish but before completion back to the exact old topology", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Old.md"), group.oldOldParent, "utf8");
    await writeFile(join(vault, "The Cortex", "Archive.md"), group.oldNewParent, "utf8");
    await writeFile(join(vault, "The Cortex", "Research.md"), group.oldResearch, "utf8");
    await writeFile(join(vault, "The Cortex", "Research", "Child.md"), group.oldDescendant, "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root, {
      afterCortexTransactionMemberPublish: async ({ memberId }) => {
        if (memberId === MOVED_PAGE_MEMBER_ID) throw new Error("synthetic post-publish interruption");
      },
    });

    const result = await transactionWriter(writer).applyCortexTreeTransaction(group.plan);

    expect(result).toMatchObject({ status: "rolled-back", completedMemberIds: [], error: null });
    expect(await readFile(join(vault, "The Cortex", "Old.md"), "utf8")).toBe(group.oldOldParent);
    expect(await readFile(join(vault, "The Cortex", "Archive.md"), "utf8")).toBe(group.oldNewParent);
    expect(await readFile(join(vault, "The Cortex", "Research.md"), "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(vault, "The Cortex", "Archive", "Research", "Child.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(cortexTransactionDirectory(vault, REPARENT_TRANSACTION_ID))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an untampered candidate publish checkpoint after a restart back to all-old", async () => {
    const vault = await temporaryVault();
    const group = await candidatePlan();
    const candidatePath = join(vault, "The Cortex", "Candidate.md");
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(candidatePath, group.oldCandidate, "utf8");
    await writeFile(join(vault, "The Cortex", "Parent.md"), group.oldParent, "utf8");
    const preIdentity = await identityForPath(candidatePath);
    const staged = join(vault, "candidate-publish.stage");
    await writeFile(staged, group.nextCandidate, "utf8");
    await rename(staged, candidatePath);
    const postIdentity = await identityForPath(candidatePath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [],
      pendingMember: {
        memberId: CANDIDATE_MEMBER_ID,
        kind: "write",
        state: "ready",
        preIdentity,
        postIdentity: { file: postIdentity },
      },
      preimages: {
        [CANDIDATE_MEMBER_ID]: group.oldCandidate,
        [CANDIDATE_PARENT_MEMBER_ID]: group.oldParent,
      },
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(candidatePath, "utf8")).toBe(group.oldCandidate);
    expect(await readFile(join(vault, "The Cortex", "Parent.md"), "utf8")).toBe(group.oldParent);
    await expect(lstat(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an untampered reparent moved-page publish checkpoint after a restart back to the exact old topology", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Old.md"), group.oldOldParent, "utf8");
    await writeFile(join(vault, "The Cortex", "Archive.md"), group.oldNewParent, "utf8");
    await writeFile(join(vault, "The Cortex", "Research.md"), group.oldResearch, "utf8");
    await writeFile(join(vault, "The Cortex", "Research", "Child.md"), group.oldDescendant, "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const setupWriter = new AtomicVaultWriter(root);
    await setupWriter.write({
      relativePath: "The Cortex/Old.md",
      expectedByteHash: await sha256Hex(group.oldOldParent),
      content: group.nextOldParent,
    });
    await setupWriter.write({
      relativePath: "The Cortex/Archive.md",
      expectedByteHash: await sha256Hex(group.oldNewParent),
      content: group.nextNewParent,
    });
    await setupWriter.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex(group.oldResearch),
    });
    const movedPath = join(vault, "The Cortex", "Archive", "Research.md");
    const movePostIdentity = {
      targetFile: await identityForPath(movedPath),
      targetDirectory: await identityForPath(join(vault, "The Cortex", "Archive", "Research")),
    };
    const pendingPreIdentity = await identityForPath(movedPath);
    const staged = join(vault, "reparent-publish.stage");
    await writeFile(staged, group.nextResearch, "utf8");
    await rename(staged, movedPath);
    const pendingPostIdentity = await identityForPath(movedPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID],
      pendingMember: {
        memberId: MOVED_PAGE_MEMBER_ID,
        kind: "write",
        state: "ready",
        preIdentity: pendingPreIdentity,
        postIdentity: { file: pendingPostIdentity },
      },
      postIdentities: {
        [MOVE_MEMBER_ID]: movePostIdentity,
      },
      preimages: {
        [OLD_PARENT_MEMBER_ID]: group.oldOldParent,
        [NEW_PARENT_MEMBER_ID]: group.oldNewParent,
        [MOVE_MEMBER_ID]: group.oldResearch,
        [MOVED_PAGE_MEMBER_ID]: group.oldResearch,
        [DESCENDANT_MEMBER_ID]: group.oldDescendant,
      },
    });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(join(vault, "The Cortex", "Old.md"), "utf8")).toBe(group.oldOldParent);
    expect(await readFile(join(vault, "The Cortex", "Archive.md"), "utf8")).toBe(group.oldNewParent);
    expect(await readFile(join(vault, "The Cortex", "Research.md"), "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(movedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(vault, "The Cortex", "Archive", "Research", "Child.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an identity-proven target-link move checkpoint after a fresh restart", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const sourceDirectoryPath = join(vault, "The Cortex", "Research");
    const sourceFileIdentity = await identityForPath(sourcePath);
    const sourceDirectoryIdentity = await identityForPath(sourceDirectoryPath);
    await link(sourcePath, targetPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID],
      pendingMember: forwardMovePending({
        memberId: MOVE_MEMBER_ID,
        stage: "target-linked",
        sourceFileIdentity,
        sourceCompanionIdentity: sourceDirectoryIdentity,
      }),
      postIdentities: parentPostIdentities,
      preimages: reparentPreimages(group),
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(sourceDirectoryPath, "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(vault, "The Cortex", "Archive", "Research"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes an incomplete forward move before checkpointing its expanded reverse WAL", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const sourceDirectoryPath = join(vault, "The Cortex", "Research");
    const targetDirectoryPath = join(vault, "The Cortex", "Archive", "Research");
    const sourceFileIdentity = await identityForPath(sourcePath);
    const sourceDirectoryIdentity = await identityForPath(sourceDirectoryPath);
    await link(sourcePath, targetPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID],
      pendingMember: forwardMovePending({
        memberId: MOVE_MEMBER_ID,
        stage: "target-linked",
        sourceFileIdentity,
        sourceCompanionIdentity: sourceDirectoryIdentity,
      }),
      postIdentities: parentPostIdentities,
      preimages: reparentPreimages(group),
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const manifestPath = join(cortexTransactionDirectory(vault, REPARENT_TRANSACTION_ID), "manifest.json");
    let interrupted = false;
    const interruptingWriter = new AtomicVaultWriter(root, {
      afterCortexTransactionManifestPersist: async (state) => {
        if (
          state.phase !== "rolling-back" ||
          state.completedMemberIds.join(",") !== [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID].join(",")
        ) {
          return;
        }
        const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as {
          readonly rollbackPendingMember?: Readonly<{
            readonly memberId?: string;
            readonly kind?: string;
            readonly moveOperation?: Readonly<{ readonly direction?: string; readonly stage?: string }>;
          }>;
        };
        if (
          persisted.rollbackPendingMember?.memberId === MOVE_MEMBER_ID &&
          persisted.rollbackPendingMember.kind === "move" &&
          persisted.rollbackPendingMember.moveOperation?.direction === "reverse" &&
          persisted.rollbackPendingMember.moveOperation.stage === "pre-link"
        ) {
          interrupted = true;
          throw new Error("synthetic crash after reverse move WAL checkpoint");
        }
      },
    });

    const interruptedRecovery = await transactionWriter(interruptingWriter).recoverCortexTreeTransactions();

    expect(interrupted).toBe(true);
    expect(interruptedRecovery.transactions).toMatchObject([{ status: "recovery-required" }]);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      phase: "rolling-back",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID],
      rollbackPendingMember: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        moveOperation: { direction: "reverse", stage: "pre-link" },
      },
    });
    await expect(readFile(sourcePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(targetPath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(targetDirectoryPath, "Child.md"), "utf8")).toBe(group.oldDescendant);

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(sourceDirectoryPath, "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(targetDirectoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a legacy ready move checkpoint with the exact all-old layout recoverable", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const sourceDirectoryPath = join(vault, "The Cortex", "Research");
    const sourceFileIdentity = await identityForPath(sourcePath);
    const sourceDirectoryIdentity = await identityForPath(sourceDirectoryPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID],
      pendingMember: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        state: "ready",
        preIdentity: { sourceFile: sourceFileIdentity, sourceDirectory: sourceDirectoryIdentity },
        postIdentity: { targetFile: sourceFileIdentity, targetDirectory: sourceDirectoryIdentity },
      },
      postIdentities: parentPostIdentities,
      preimages: reparentPreimages(group),
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(sourceDirectoryPath, "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a companion-directory rename checkpoint after a fresh restart", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const sourceDirectoryPath = join(vault, "The Cortex", "Research");
    const targetDirectoryPath = join(vault, "The Cortex", "Archive", "Research");
    const sourceFileIdentity = await identityForPath(sourcePath);
    const sourceDirectoryIdentity = await identityForPath(sourceDirectoryPath);
    await link(sourcePath, targetPath);
    await mkdir(targetDirectoryPath);
    const reservationIdentity = await identityForPath(targetDirectoryPath);
    await rename(sourceDirectoryPath, targetDirectoryPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID],
      pendingMember: forwardMovePending({
        memberId: MOVE_MEMBER_ID,
        stage: "companion-moved",
        sourceFileIdentity,
        sourceCompanionIdentity: sourceDirectoryIdentity,
        reservationIdentity,
      }),
      postIdentities: parentPostIdentities,
      preimages: reparentPreimages(group),
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(sourceDirectoryPath, "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(targetDirectoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes only its privately recorded companion reservation after it becomes visible", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const sourceDirectoryPath = join(vault, "The Cortex", "Research");
    const targetDirectoryPath = join(vault, "The Cortex", "Archive", "Research");
    const sourceFileIdentity = await identityForPath(sourcePath);
    const sourceDirectoryIdentity = await identityForPath(sourceDirectoryPath);
    await link(sourcePath, targetPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID],
      pendingMember: forwardMovePending({
        memberId: MOVE_MEMBER_ID,
        stage: "companion-reserve",
        sourceFileIdentity,
        sourceCompanionIdentity: sourceDirectoryIdentity,
      }),
      postIdentities: parentPostIdentities,
      preimages: reparentPreimages(group),
    });
    const privateReservationPath = cortexMoveReservationPath(vault, REPARENT_TRANSACTION_ID, MOVE_MEMBER_ID);
    await mkdir(privateReservationPath, { mode: 0o700 });
    const reservationIdentity = await identityForPath(privateReservationPath);
    await rewriteRestartManifest({
      vault,
      transactionId: REPARENT_TRANSACTION_ID,
      changes: {
        pendingMember: forwardMovePending({
          memberId: MOVE_MEMBER_ID,
          stage: "companion-reserved",
          sourceFileIdentity,
          sourceCompanionIdentity: sourceDirectoryIdentity,
          reservationIdentity,
        }),
      },
    });
    await rename(privateReservationPath, targetDirectoryPath);
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(targetDirectoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a private companion reservation created before its identity checkpoint", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const sourceDirectoryPath = join(vault, "The Cortex", "Research");
    const sourceFileIdentity = await identityForPath(sourcePath);
    const sourceDirectoryIdentity = await identityForPath(sourceDirectoryPath);
    await link(sourcePath, targetPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID],
      pendingMember: forwardMovePending({
        memberId: MOVE_MEMBER_ID,
        stage: "companion-reserve",
        sourceFileIdentity,
        sourceCompanionIdentity: sourceDirectoryIdentity,
      }),
      postIdentities: parentPostIdentities,
      preimages: reparentPreimages(group),
    });
    const privateReservationPath = cortexMoveReservationPath(vault, REPARENT_TRANSACTION_ID, MOVE_MEMBER_ID);
    await mkdir(privateReservationPath, { mode: 0o700 });
    await chmod(privateReservationPath, 0o700);
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(sourceDirectoryPath, "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(privateReservationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes an expanded reverse move WAL from its target-link checkpoint", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const setupWriter = new AtomicVaultWriter(root);
    await setupWriter.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex(group.oldResearch),
    });
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const targetDirectoryPath = join(vault, "The Cortex", "Archive", "Research");
    const targetFileIdentity = await identityForPath(targetPath);
    const targetDirectoryIdentity = await identityForPath(targetDirectoryPath);
    await link(targetPath, sourcePath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "rolling-back",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID],
      rollbackPendingMember: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        moveOperation: {
          direction: "reverse",
          stage: "target-linked",
          sourceFileIdentity: targetFileIdentity,
          targetFileIdentity,
          sourceCompanionIdentity: targetDirectoryIdentity,
          targetCompanionIdentity: targetDirectoryIdentity,
          reservationIdentity: null,
        },
      },
      postIdentities: {
        ...parentPostIdentities,
        [MOVE_MEMBER_ID]: {
          targetFile: targetFileIdentity,
          targetDirectory: targetDirectoryIdentity,
        },
      },
      preimages: reparentPreimages(group),
    });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(targetDirectoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates an exact legacy all-new rollback move to an expanded reverse WAL before mutation", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    await new AtomicVaultWriter(root).moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex(group.oldResearch),
    });
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const sourceDirectoryPath = join(vault, "The Cortex", "Research");
    const targetDirectoryPath = join(vault, "The Cortex", "Archive", "Research");
    const targetFileIdentity = await identityForPath(targetPath);
    const targetDirectoryIdentity = await identityForPath(targetDirectoryPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "rolling-back",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID],
      rollbackPending: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        expectedNewIdentity: {
          targetFile: targetFileIdentity,
          targetDirectory: targetDirectoryIdentity,
        },
        intendedOldIdentity: {
          sourceFile: targetFileIdentity,
          sourceDirectory: targetDirectoryIdentity,
        },
      },
      postIdentities: {
        ...parentPostIdentities,
        [MOVE_MEMBER_ID]: {
          targetFile: targetFileIdentity,
          targetDirectory: targetDirectoryIdentity,
        },
      },
      preimages: reparentPreimages(group),
    });
    const manifestPath = join(cortexTransactionDirectory(vault, REPARENT_TRANSACTION_ID), "manifest.json");
    let interrupted = false;
    const interruptingWriter = new AtomicVaultWriter(root, {
      afterCortexTransactionManifestPersist: async () => {
        const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as {
          readonly rollbackPendingMember?: Readonly<{
            readonly memberId?: string;
            readonly kind?: string;
            readonly moveOperation?: Readonly<{ readonly direction?: string; readonly stage?: string }>;
          }>;
        };
        if (
          persisted.rollbackPendingMember?.memberId === MOVE_MEMBER_ID &&
          persisted.rollbackPendingMember.kind === "move" &&
          persisted.rollbackPendingMember.moveOperation?.direction === "reverse" &&
          persisted.rollbackPendingMember.moveOperation.stage === "pre-link"
        ) {
          interrupted = true;
          throw new Error("synthetic crash after legacy move WAL migration");
        }
      },
    });

    const interruptedRecovery = await transactionWriter(interruptingWriter).recoverCortexTreeTransactions();

    expect(interrupted).toBe(true);
    expect(interruptedRecovery.transactions).toMatchObject([{ status: "recovery-required" }]);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      phase: "rolling-back",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID],
      rollbackPendingMember: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        moveOperation: { direction: "reverse", stage: "pre-link" },
      },
    });
    await expect(readFile(sourcePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(targetPath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(targetDirectoryPath, "Child.md"), "utf8")).toBe(group.oldDescendant);

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(sourceDirectoryPath, "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(targetDirectoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("advances an exact legacy all-old rollback move without fabricating a post-action reservation", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const sourceDirectoryPath = join(vault, "The Cortex", "Research");
    const targetDirectoryPath = join(vault, "The Cortex", "Archive", "Research");
    const sourceFileIdentity = await identityForPath(sourcePath);
    const sourceDirectoryIdentity = await identityForPath(sourceDirectoryPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "rolling-back",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID],
      rollbackPending: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        expectedNewIdentity: {
          targetFile: sourceFileIdentity,
          targetDirectory: sourceDirectoryIdentity,
        },
        intendedOldIdentity: {
          sourceFile: sourceFileIdentity,
          sourceDirectory: sourceDirectoryIdentity,
        },
      },
      postIdentities: {
        ...parentPostIdentities,
        [MOVE_MEMBER_ID]: {
          targetFile: sourceFileIdentity,
          targetDirectory: sourceDirectoryIdentity,
        },
      },
      preimages: reparentPreimages(group),
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(sourceDirectoryPath, "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(targetDirectoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove a same-name external companion reservation during recovery", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const sourceDirectoryPath = join(vault, "The Cortex", "Research");
    const targetDirectoryPath = join(vault, "The Cortex", "Archive", "Research");
    const sourceFileIdentity = await identityForPath(sourcePath);
    const sourceDirectoryIdentity = await identityForPath(sourceDirectoryPath);
    await link(sourcePath, targetPath);
    await mkdir(targetDirectoryPath);
    const reservationIdentity = await identityForPath(targetDirectoryPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID],
      pendingMember: forwardMovePending({
        memberId: MOVE_MEMBER_ID,
        stage: "companion-reserved",
        sourceFileIdentity,
        sourceCompanionIdentity: sourceDirectoryIdentity,
        reservationIdentity: { ...reservationIdentity, ino: "0" },
      }),
      postIdentities: parentPostIdentities,
      preimages: reparentPreimages(group),
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{
      transactionId: REPARENT_TRANSACTION_ID,
      rootPageId: CORTEX_ROOT_PAGE_ID,
      status: "recovery-required",
      error: { code: "recovery-required", retryable: false },
    }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(targetPath, "utf8")).toBe(group.oldResearch);
    expect((await lstat(targetDirectoryPath)).isDirectory()).toBe(true);
  });

  it("fails closed on a same-hash different-inode target during an intermediate move checkpoint", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const sourceDirectoryPath = join(vault, "The Cortex", "Research");
    const sourceFileIdentity = await identityForPath(sourcePath);
    const sourceDirectoryIdentity = await identityForPath(sourceDirectoryPath);
    await link(sourcePath, targetPath);
    const replacementPath = join(vault, "replacement.md");
    await writeFile(replacementPath, group.oldResearch, "utf8");
    await rename(replacementPath, targetPath);
    const replacementIdentity = await identityForPath(targetPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID],
      pendingMember: forwardMovePending({
        memberId: MOVE_MEMBER_ID,
        stage: "target-linked",
        sourceFileIdentity,
        sourceCompanionIdentity: sourceDirectoryIdentity,
      }),
      postIdentities: parentPostIdentities,
      preimages: reparentPreimages(group),
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{
      transactionId: REPARENT_TRANSACTION_ID,
      rootPageId: CORTEX_ROOT_PAGE_ID,
      status: "recovery-required",
      error: { code: "recovery-required", retryable: false },
    }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(targetPath, "utf8")).toBe(group.oldResearch);
    expect(await identityForPath(targetPath)).toEqual(replacementIdentity);
  });

  it("does not overwrite a same-hash replacement at a candidate pending publish checkpoint", async () => {
    const vault = await temporaryVault();
    const group = await candidatePlan();
    const candidatePath = join(vault, "The Cortex", "Candidate.md");
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(candidatePath, group.oldCandidate, "utf8");
    await writeFile(join(vault, "The Cortex", "Parent.md"), group.oldParent, "utf8");
    const preIdentity = await identityForPath(candidatePath);
    const staged = join(vault, "candidate-publish.stage");
    await writeFile(staged, group.nextCandidate, "utf8");
    await rename(staged, candidatePath);
    const postIdentity = await identityForPath(candidatePath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [],
      pendingMember: {
        memberId: CANDIDATE_MEMBER_ID,
        kind: "write",
        state: "ready",
        preIdentity,
        postIdentity: { file: postIdentity },
      },
      preimages: {
        [CANDIDATE_MEMBER_ID]: group.oldCandidate,
        [CANDIDATE_PARENT_MEMBER_ID]: group.oldParent,
      },
    });
    const replacement = join(vault, "candidate-replacement.stage");
    await writeFile(replacement, group.nextCandidate, "utf8");
    await rename(replacement, candidatePath);
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{
      status: "recovery-required",
      error: { code: "recovery-required", retryable: false },
    }]);
    expect(await readFile(candidatePath, "utf8")).toBe(group.nextCandidate);
    expect(await readFile(join(vault, "The Cortex", "Parent.md"), "utf8")).toBe(group.oldParent);
    expect((await lstat(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID))).isDirectory()).toBe(true);
  });

  it("rolls every reparent-group member interruption back to the exact prior files and child marker relation", async () => {
    const group = await reparentPlan();
    for (const failureMemberId of group.plan.members.map((member) => member.memberId)) {
      const vault = await temporaryVault();
      await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
      await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
      await writeFile(join(vault, "The Cortex", "Old.md"), group.oldOldParent, "utf8");
      await writeFile(join(vault, "The Cortex", "Archive.md"), group.oldNewParent, "utf8");
      await writeFile(join(vault, "The Cortex", "Research.md"), group.oldResearch, "utf8");
      await writeFile(join(vault, "The Cortex", "Research", "Child.md"), group.oldDescendant, "utf8");
      const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
      const writer = new AtomicVaultWriter(root, transactionFailureHook(failureMemberId, { skipDurabilitySync: true }));

      const result = await transactionWriter(writer).applyCortexTreeTransaction(group.plan);

      expect(result).toMatchObject({ status: "rolled-back", completedMemberIds: [], error: null });
      expect(await readFile(join(vault, "The Cortex", "Old.md"), "utf8")).toBe(group.oldOldParent);
      expect(await readFile(join(vault, "The Cortex", "Archive.md"), "utf8")).toBe(group.oldNewParent);
      expect(await readFile(join(vault, "The Cortex", "Research.md"), "utf8")).toBe(group.oldResearch);
      expect(await readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).toBe(group.oldDescendant);
      await expect(readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(vault, "The Cortex", "Archive", "Research", "Child.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(group.oldOldParent).toContain("children: [Research]");
      expect(group.oldNewParent).toContain("children: []");
      expect(group.oldResearch).toContain("parent: Old");
      await expect(lstat(cortexTransactionDirectory(vault, REPARENT_TRANSACTION_ID))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rolls a publishing-phase reparent restart through a moved-page write back to the exact old topology", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Old.md"), group.oldOldParent, "utf8");
    await writeFile(join(vault, "The Cortex", "Archive.md"), group.oldNewParent, "utf8");
    await writeFile(join(vault, "The Cortex", "Research.md"), group.oldResearch, "utf8");
    await writeFile(join(vault, "The Cortex", "Research", "Child.md"), group.oldDescendant, "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root);
    await writer.write({
      relativePath: "The Cortex/Old.md",
      expectedByteHash: await sha256Hex(group.oldOldParent),
      content: group.nextOldParent,
    });
    await writer.write({
      relativePath: "The Cortex/Archive.md",
      expectedByteHash: await sha256Hex(group.oldNewParent),
      content: group.nextNewParent,
    });
    await writer.moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex(group.oldResearch),
    });
    await writer.write({
      relativePath: "The Cortex/Archive/Research.md",
      expectedByteHash: await sha256Hex(group.oldResearch),
      content: group.nextResearch,
    });
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID, MOVED_PAGE_MEMBER_ID],
      preimages: {
        [OLD_PARENT_MEMBER_ID]: group.oldOldParent,
        [NEW_PARENT_MEMBER_ID]: group.oldNewParent,
        [MOVE_MEMBER_ID]: group.oldResearch,
        [MOVED_PAGE_MEMBER_ID]: group.oldResearch,
        [DESCENDANT_MEMBER_ID]: group.oldDescendant,
      },
    });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(join(vault, "The Cortex", "Old.md"), "utf8")).toBe(group.oldOldParent);
    expect(await readFile(join(vault, "The Cortex", "Archive.md"), "utf8")).toBe(group.oldNewParent);
    expect(await readFile(join(vault, "The Cortex", "Research.md"), "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(vault, "The Cortex", "Archive", "Research", "Child.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes a crash after a rollback write is restored but before rollback progress persists", async () => {
    const vault = await temporaryVault();
    const group = await candidatePlan();
    const candidatePath = join(vault, "The Cortex", "Candidate.md");
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(candidatePath, group.oldCandidate, "utf8");
    await writeFile(join(vault, "The Cortex", "Parent.md"), group.oldParent, "utf8");
    const publishedStage = join(vault, "candidate-published.stage");
    await writeFile(publishedStage, group.nextCandidate, "utf8");
    await rename(publishedStage, candidatePath);
    const publishedIdentity = await identityForPath(candidatePath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [CANDIDATE_MEMBER_ID],
      preimages: {
        [CANDIDATE_MEMBER_ID]: group.oldCandidate,
        [CANDIDATE_PARENT_MEMBER_ID]: group.oldParent,
      },
    });
    const rollbackStage = join(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID), `${CANDIDATE_MEMBER_ID}.rollback`);
    await writeFile(rollbackStage, group.oldCandidate, { encoding: "utf8", mode: 0o600 });
    await chmod(rollbackStage, 0o600);
    await rename(rollbackStage, candidatePath);
    const restoredIdentity = await identityForPath(candidatePath);
    await rewriteRestartManifestAsRollingBack({
      vault,
      transactionId: CANDIDATE_TRANSACTION_ID,
      rollbackPending: {
        memberId: CANDIDATE_MEMBER_ID,
        kind: "write",
        expectedNewIdentity: { file: publishedIdentity },
        intendedOldIdentity: { file: restoredIdentity },
      },
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(candidatePath, "utf8")).toBe(group.oldCandidate);
    expect(await readFile(join(vault, "The Cortex", "Parent.md"), "utf8")).toBe(group.oldParent);
    await expect(lstat(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists an expanded rollback write WAL with its staged inode before the first replacement", async () => {
    const vault = await temporaryVault();
    const group = await candidatePlan();
    const candidatePath = join(vault, "The Cortex", "Candidate.md");
    const manifestPath = join(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID), "manifest.json");
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(candidatePath, group.oldCandidate, "utf8");
    await writeFile(join(vault, "The Cortex", "Parent.md"), group.oldParent, "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    let interrupted = false;
    const writer = new AtomicVaultWriter(root, {
      afterCortexTransactionMember: async ({ memberId }) => {
        if (memberId === CANDIDATE_MEMBER_ID) throw new Error("synthetic forward failure");
      },
      afterCortexTransactionManifestPersist: async (state) => {
        if (
          state.phase !== "rolling-back" ||
          state.completedMemberIds.join(",") !== CANDIDATE_MEMBER_ID
        ) {
          return;
        }
        const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as {
          readonly rollbackPendingMember?: Readonly<{
            readonly memberId?: string;
            readonly kind?: string;
            readonly expectedNewIdentity?: Readonly<{ readonly file?: Readonly<{ readonly dev?: string; readonly ino?: string }> }>;
            readonly intendedOldIdentity?: Readonly<{ readonly file?: Readonly<{ readonly dev?: string; readonly ino?: string }> }>;
          }>;
        };
        if (
          persisted.rollbackPendingMember?.memberId !== CANDIDATE_MEMBER_ID ||
          persisted.rollbackPendingMember.kind !== "write"
        ) {
          return;
        }
        const rollbackStage = join(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID), `${CANDIDATE_MEMBER_ID}.rollback`);
        expect(persisted).not.toHaveProperty("rollbackPending");
        expect(persisted.rollbackPendingMember).toMatchObject({
          expectedNewIdentity: { file: await identityForPath(candidatePath) },
          intendedOldIdentity: { file: await identityForPath(rollbackStage) },
        });
        interrupted = true;
        throw new Error("synthetic crash after rollback write WAL checkpoint");
      },
    });

    const interruptedResult = await transactionWriter(writer).applyCortexTreeTransaction(group.plan);

    expect(interrupted).toBe(true);
    expect(interruptedResult).toMatchObject({ status: "recovery-required" });
    expect(await readFile(candidatePath, "utf8")).toBe(group.nextCandidate);
    expect(await readFile(join(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID), `${CANDIDATE_MEMBER_ID}.rollback`), "utf8"))
      .toBe(group.oldCandidate);

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(candidatePath, "utf8")).toBe(group.oldCandidate);
    expect(await readFile(join(vault, "The Cortex", "Parent.md"), "utf8")).toBe(group.oldParent);
  });

  it("resumes an expanded rollback write after replacement but before its completed-prefix checkpoint", async () => {
    const vault = await temporaryVault();
    const group = await candidatePlan();
    const candidatePath = join(vault, "The Cortex", "Candidate.md");
    const transactionDirectory = cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID);
    const manifestPath = join(transactionDirectory, "manifest.json");
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(candidatePath, group.oldCandidate, "utf8");
    await writeFile(join(vault, "The Cortex", "Parent.md"), group.oldParent, "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const canonicalTransactionDirectory = join(
      root.canonicalRealPath,
      ".obsidian",
      "grandbox-bridge",
      "cortex-transactions",
      CANDIDATE_TRANSACTION_ID,
    );
    let rollbackWriteCheckpointed = false;
    let interrupted = false;
    const writer = new AtomicVaultWriter(root, {
      afterCortexTransactionMember: async ({ memberId }) => {
        if (memberId === CANDIDATE_MEMBER_ID) throw new Error("synthetic forward failure");
      },
      afterCortexTransactionManifestPersist: async (state) => {
        if (
          state.phase !== "rolling-back" ||
          state.completedMemberIds.join(",") !== CANDIDATE_MEMBER_ID
        ) {
          return;
        }
        const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as {
          readonly rollbackPendingMember?: Readonly<{ readonly memberId?: string; readonly kind?: string }>;
        };
        rollbackWriteCheckpointed = persisted.rollbackPendingMember?.memberId === CANDIDATE_MEMBER_ID &&
          persisted.rollbackPendingMember.kind === "write";
      },
      syncDirectory: async (directoryPath, sync) => {
        await sync();
        if (rollbackWriteCheckpointed && !interrupted && directoryPath === canonicalTransactionDirectory) {
          interrupted = true;
          throw new Error("synthetic crash after rollback write replacement");
        }
      },
    });

    const interruptedResult = await transactionWriter(writer).applyCortexTreeTransaction(group.plan);

    expect(rollbackWriteCheckpointed).toBe(true);
    expect(interrupted).toBe(true);
    expect(interruptedResult).toMatchObject({ status: "recovery-required" });
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      phase: "rolling-back",
      completedMemberIds: [CANDIDATE_MEMBER_ID],
      rollbackPendingMember: { memberId: CANDIDATE_MEMBER_ID, kind: "write" },
    });
    expect(await readFile(candidatePath, "utf8")).toBe(group.oldCandidate);
    await expect(readFile(join(transactionDirectory, `${CANDIDATE_MEMBER_ID}.rollback`), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(candidatePath, "utf8")).toBe(group.oldCandidate);
    expect(await readFile(join(vault, "The Cortex", "Parent.md"), "utf8")).toBe(group.oldParent);
  });

  it("resumes an expanded reverse move after its target link but before the next WAL checkpoint", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    await new AtomicVaultWriter(root).moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex(group.oldResearch),
    });
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const targetDirectoryPath = join(vault, "The Cortex", "Archive", "Research");
    const targetFileIdentity = await identityForPath(targetPath);
    const targetDirectoryIdentity = await identityForPath(targetDirectoryPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "rolling-back",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID],
      rollbackPendingMember: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        moveOperation: {
          direction: "reverse",
          stage: "pre-link",
          sourceFileIdentity: targetFileIdentity,
          targetFileIdentity,
          sourceCompanionIdentity: targetDirectoryIdentity,
          targetCompanionIdentity: targetDirectoryIdentity,
          reservationIdentity: null,
        },
      },
      postIdentities: {
        ...parentPostIdentities,
        [MOVE_MEMBER_ID]: { targetFile: targetFileIdentity, targetDirectory: targetDirectoryIdentity },
      },
      preimages: reparentPreimages(group),
    });
    const manifestPath = join(cortexTransactionDirectory(vault, REPARENT_TRANSACTION_ID), "manifest.json");
    const canonicalSourceParent = join(root.canonicalRealPath, "The Cortex");
    let targetLinkCheckpointed = false;
    let interrupted = false;
    const interruptingWriter = new AtomicVaultWriter(root, {
      afterCortexTransactionManifestPersist: async (state) => {
        if (
          state.phase !== "rolling-back" ||
          state.completedMemberIds.join(",") !== [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID].join(",")
        ) {
          return;
        }
        const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as {
          readonly rollbackPendingMember?: Readonly<{
            readonly memberId?: string;
            readonly kind?: string;
            readonly moveOperation?: Readonly<{ readonly direction?: string; readonly stage?: string }>;
          }>;
        };
        targetLinkCheckpointed = persisted.rollbackPendingMember?.memberId === MOVE_MEMBER_ID &&
          persisted.rollbackPendingMember.kind === "move" &&
          persisted.rollbackPendingMember.moveOperation?.direction === "reverse" &&
          persisted.rollbackPendingMember.moveOperation.stage === "target-linked";
      },
      syncDirectory: async (directoryPath, sync) => {
        await sync();
        if (targetLinkCheckpointed && !interrupted && directoryPath === canonicalSourceParent) {
          interrupted = true;
          throw new Error("synthetic crash after reverse target link");
        }
      },
    });

    const interruptedRecovery = await transactionWriter(interruptingWriter).recoverCortexTreeTransactions();

    expect(interrupted).toBe(true);
    expect(interruptedRecovery.transactions).toMatchObject([{ status: "recovery-required" }]);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      phase: "rolling-back",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID],
      rollbackPendingMember: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        moveOperation: { direction: "reverse", stage: "target-linked" },
      },
    });
    expect(await identityForPath(sourcePath)).toEqual(await identityForPath(targetPath));
    await expect(lstat(join(vault, "The Cortex", "Research"))).rejects.toMatchObject({ code: "ENOENT" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(targetDirectoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes an expanded reverse move after its companion rename but before source unlink", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await seedReparentOldTopology(vault, group);
    const parentPostIdentities = await publishReparentParentPrefix(vault, group);
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    await new AtomicVaultWriter(root).moveCortexSubtree({
      sourcePath: "The Cortex/Research.md",
      targetPath: "The Cortex/Archive/Research.md",
      expectedSourceByteHash: await sha256Hex(group.oldResearch),
    });
    const sourcePath = join(vault, "The Cortex", "Research.md");
    const sourceDirectoryPath = join(vault, "The Cortex", "Research");
    const targetPath = join(vault, "The Cortex", "Archive", "Research.md");
    const targetDirectoryPath = join(vault, "The Cortex", "Archive", "Research");
    const targetFileIdentity = await identityForPath(targetPath);
    const targetDirectoryIdentity = await identityForPath(targetDirectoryPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "rolling-back",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID],
      rollbackPendingMember: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        moveOperation: {
          direction: "reverse",
          stage: "pre-link",
          sourceFileIdentity: targetFileIdentity,
          targetFileIdentity,
          sourceCompanionIdentity: targetDirectoryIdentity,
          targetCompanionIdentity: targetDirectoryIdentity,
          reservationIdentity: null,
        },
      },
      postIdentities: {
        ...parentPostIdentities,
        [MOVE_MEMBER_ID]: { targetFile: targetFileIdentity, targetDirectory: targetDirectoryIdentity },
      },
      preimages: reparentPreimages(group),
    });
    const manifestPath = join(cortexTransactionDirectory(vault, REPARENT_TRANSACTION_ID), "manifest.json");
    const canonicalSourceParent = join(root.canonicalRealPath, "The Cortex");
    let companionRenameCheckpointed = false;
    let interrupted = false;
    const interruptingWriter = new AtomicVaultWriter(root, {
      afterCortexTransactionManifestPersist: async (state) => {
        if (
          state.phase !== "rolling-back" ||
          state.completedMemberIds.join(",") !== [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID].join(",")
        ) {
          return;
        }
        const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as {
          readonly rollbackPendingMember?: Readonly<{
            readonly memberId?: string;
            readonly kind?: string;
            readonly moveOperation?: Readonly<{ readonly direction?: string; readonly stage?: string }>;
          }>;
        };
        companionRenameCheckpointed = persisted.rollbackPendingMember?.memberId === MOVE_MEMBER_ID &&
          persisted.rollbackPendingMember.kind === "move" &&
          persisted.rollbackPendingMember.moveOperation?.direction === "reverse" &&
          persisted.rollbackPendingMember.moveOperation.stage === "companion-moved";
      },
      syncDirectory: async (directoryPath, sync) => {
        await sync();
        if (companionRenameCheckpointed && !interrupted && directoryPath === canonicalSourceParent) {
          interrupted = true;
          throw new Error("synthetic crash after reverse companion rename");
        }
      },
    });

    const interruptedRecovery = await transactionWriter(interruptingWriter).recoverCortexTreeTransactions();

    expect(interrupted).toBe(true);
    expect(interruptedRecovery.transactions).toMatchObject([{ status: "recovery-required" }]);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      phase: "rolling-back",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID],
      rollbackPendingMember: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        moveOperation: { direction: "reverse", stage: "companion-moved" },
      },
    });
    expect(await readFile(join(sourceDirectoryPath, "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(lstat(targetDirectoryPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await identityForPath(sourcePath)).toEqual(await identityForPath(targetPath));

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(sourcePath, "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(sourceDirectoryPath, "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(targetDirectoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes a crash after rollback intent persists but before a write restore", async () => {
    const vault = await temporaryVault();
    const group = await candidatePlan();
    const candidatePath = join(vault, "The Cortex", "Candidate.md");
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(candidatePath, group.oldCandidate, "utf8");
    await writeFile(join(vault, "The Cortex", "Parent.md"), group.oldParent, "utf8");
    const publishedStage = join(vault, "candidate-published.stage");
    await writeFile(publishedStage, group.nextCandidate, "utf8");
    await rename(publishedStage, candidatePath);
    const publishedIdentity = await identityForPath(candidatePath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [CANDIDATE_MEMBER_ID],
      preimages: {
        [CANDIDATE_MEMBER_ID]: group.oldCandidate,
        [CANDIDATE_PARENT_MEMBER_ID]: group.oldParent,
      },
    });
    const rollbackStage = join(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID), `${CANDIDATE_MEMBER_ID}.rollback`);
    await writeFile(rollbackStage, group.oldCandidate, { encoding: "utf8", mode: 0o600 });
    await chmod(rollbackStage, 0o600);
    const stagedIdentity = await identityForPath(rollbackStage);
    await rewriteRestartManifestAsRollingBack({
      vault,
      transactionId: CANDIDATE_TRANSACTION_ID,
      rollbackPending: {
        memberId: CANDIDATE_MEMBER_ID,
        kind: "write",
        expectedNewIdentity: { file: publishedIdentity },
        intendedOldIdentity: { file: stagedIdentity },
      },
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(candidatePath, "utf8")).toBe(group.oldCandidate);
    expect(await readFile(join(vault, "The Cortex", "Parent.md"), "utf8")).toBe(group.oldParent);
    await expect(lstat(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discards a staged rollback preimage before its WAL checkpoint and resumes safely", async () => {
    const vault = await temporaryVault();
    const group = await candidatePlan();
    const candidatePath = join(vault, "The Cortex", "Candidate.md");
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(candidatePath, group.oldCandidate, "utf8");
    await writeFile(join(vault, "The Cortex", "Parent.md"), group.oldParent, "utf8");
    const publishedStage = join(vault, "candidate-published.stage");
    await writeFile(publishedStage, group.nextCandidate, "utf8");
    await rename(publishedStage, candidatePath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [CANDIDATE_MEMBER_ID],
      preimages: {
        [CANDIDATE_MEMBER_ID]: group.oldCandidate,
        [CANDIDATE_PARENT_MEMBER_ID]: group.oldParent,
      },
    });
    const rollbackStage = join(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID), `${CANDIDATE_MEMBER_ID}.rollback`);
    await writeFile(rollbackStage, group.oldCandidate, { encoding: "utf8", mode: 0o600 });
    await chmod(rollbackStage, 0o600);
    await rewriteRestartManifestAsRollingBack({
      vault,
      transactionId: CANDIDATE_TRANSACTION_ID,
      rollbackPending: null,
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(candidatePath, "utf8")).toBe(group.oldCandidate);
    await expect(lstat(cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["published", "restored"] as const)("fails closed on a same-hash different-inode %s rollback artifact", async (window) => {
    const vault = await temporaryVault();
    const group = await candidatePlan();
    const candidatePath = join(vault, "The Cortex", "Candidate.md");
    const transactionDirectory = cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID);
    const rollbackStage = join(transactionDirectory, `${CANDIDATE_MEMBER_ID}.rollback`);
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(candidatePath, group.oldCandidate, "utf8");
    await writeFile(join(vault, "The Cortex", "Parent.md"), group.oldParent, "utf8");
    const publishedStage = join(vault, "candidate-published.stage");
    await writeFile(publishedStage, group.nextCandidate, "utf8");
    await rename(publishedStage, candidatePath);
    const publishedIdentity = await identityForPath(candidatePath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "rolling-back",
      completedMemberIds: [CANDIDATE_MEMBER_ID],
      rollbackPendingMember: null,
      preimages: {
        [CANDIDATE_MEMBER_ID]: group.oldCandidate,
        [CANDIDATE_PARENT_MEMBER_ID]: group.oldParent,
      },
    });
    await writeFile(rollbackStage, group.oldCandidate, { encoding: "utf8", mode: 0o600 });
    await chmod(rollbackStage, 0o600);
    const stagedIdentity = await identityForPath(rollbackStage);
    await rewriteRestartManifest({
      vault,
      transactionId: CANDIDATE_TRANSACTION_ID,
      changes: {
        rollbackPendingMember: {
          memberId: CANDIDATE_MEMBER_ID,
          kind: "write",
          expectedNewIdentity: { file: publishedIdentity },
          intendedOldIdentity: { file: stagedIdentity },
        },
      },
    });
    if (window === "restored") {
      await rename(rollbackStage, candidatePath);
    }
    const replacement = join(vault, `candidate-${window}-replacement.stage`);
    const expectedContent = window === "published" ? group.nextCandidate : group.oldCandidate;
    await writeFile(replacement, expectedContent, "utf8");
    await rename(replacement, candidatePath);
    const replacementIdentity = await identityForPath(candidatePath);
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{
      status: "recovery-required",
      error: { code: "recovery-required", retryable: false },
    }]);
    expect(await readFile(candidatePath, "utf8")).toBe(expectedContent);
    expect(await identityForPath(candidatePath)).toEqual(replacementIdentity);
    expect(await readFile(join(vault, "The Cortex", "Parent.md"), "utf8")).toBe(group.oldParent);
    if (window === "published") {
      expect(await identityForPath(rollbackStage)).toEqual(stagedIdentity);
      return;
    }
    await expect(lstat(rollbackStage)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a malformed expanded rollback stage before mutating an earlier completed member", async () => {
    const vault = await temporaryVault();
    const group = await candidatePlan();
    const candidatePath = join(vault, "The Cortex", "Candidate.md");
    const parentPath = join(vault, "The Cortex", "Parent.md");
    const transactionDirectory = cortexTransactionDirectory(vault, CANDIDATE_TRANSACTION_ID);
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(candidatePath, group.nextCandidate, "utf8");
    await writeFile(parentPath, group.nextParent, "utf8");
    const candidateIdentity = await identityForPath(candidatePath);
    const parentIdentity = await identityForPath(parentPath);
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "rolling-back",
      completedMemberIds: [CANDIDATE_MEMBER_ID, CANDIDATE_PARENT_MEMBER_ID],
      rollbackPendingMember: null,
      preimages: {
        [CANDIDATE_MEMBER_ID]: group.oldCandidate,
        [CANDIDATE_PARENT_MEMBER_ID]: group.oldParent,
      },
    });
    const malformedStage = join(transactionDirectory, `${CANDIDATE_PARENT_MEMBER_ID}.rollback`);
    await writeFile(malformedStage, "not the verified parent preimage", { encoding: "utf8", mode: 0o600 });
    await chmod(malformedStage, 0o600);
    const malformedIdentity = await identityForPath(malformedStage);
    await rewriteRestartManifest({
      vault,
      transactionId: CANDIDATE_TRANSACTION_ID,
      changes: {
        rollbackPendingMember: {
          memberId: CANDIDATE_PARENT_MEMBER_ID,
          kind: "write",
          expectedNewIdentity: { file: parentIdentity },
          intendedOldIdentity: { file: malformedIdentity },
        },
      },
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{
      status: "recovery-required",
      error: { code: "recovery-required", retryable: false },
    }]);
    expect(await readFile(candidatePath, "utf8")).toBe(group.nextCandidate);
    expect(await identityForPath(candidatePath)).toEqual(candidateIdentity);
    expect(await readFile(parentPath, "utf8")).toBe(group.nextParent);
    expect(await identityForPath(parentPath)).toEqual(parentIdentity);
    expect(await readFile(malformedStage, "utf8")).toBe("not the verified parent preimage");
  });

  it("restarts after a later write rollback and checkpoints the earlier reverse move with its restored inode", async () => {
    const vault = await temporaryVault();
    const group = await scannerSafeReparentPlan();
    await seedScannerSafeReparentOldTopology(vault, group);
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    const writer = new AtomicVaultWriter(root);
    await expect(transactionWriter(writer).applyCortexTreeTransaction(group.plan))
      .resolves.toMatchObject({ status: "committed", error: null });
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "rolling-back",
      completedMemberIds: group.plan.members.map((member) => member.memberId),
      rollbackPendingMember: null,
      preimages: reparentPreimages(group),
    });
    const manifestPath = join(cortexTransactionDirectory(vault, REPARENT_TRANSACTION_ID), "manifest.json");
    const movedPagePath = join(vault, "The Cortex", "Archive", "Research.md");
    let interrupted = false;
    const interruptingWriter = new AtomicVaultWriter(root, {
      afterCortexTransactionManifestPersist: async (state) => {
        if (
          state.phase !== "rolling-back" ||
          state.completedMemberIds.join(",") !== [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID, MOVE_MEMBER_ID].join(",")
        ) {
          return;
        }
        const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as {
          readonly rollbackPendingMember?: Readonly<{
            readonly memberId?: string;
            readonly kind?: string;
            readonly moveOperation?: Readonly<{ readonly direction?: string; readonly stage?: string }>;
          }>;
          readonly members?: readonly Readonly<{
            readonly memberId?: string;
            readonly postIdentity?: Readonly<{ readonly targetFile?: Readonly<{ readonly dev?: string; readonly ino?: string }> }>;
          }>[];
        };
        if (
          persisted.rollbackPendingMember?.memberId !== MOVE_MEMBER_ID ||
          persisted.rollbackPendingMember.kind !== "move" ||
          persisted.rollbackPendingMember.moveOperation?.direction !== "reverse" ||
          persisted.rollbackPendingMember.moveOperation.stage !== "pre-link"
        ) {
          return;
        }
        expect(persisted.members?.find((member) => member.memberId === MOVE_MEMBER_ID)?.postIdentity?.targetFile)
          .toEqual(await identityForPath(movedPagePath));
        interrupted = true;
        throw new Error("synthetic crash after later write rollback before earlier reverse move");
      },
    });

    const interruptedRecovery = await transactionWriter(interruptingWriter).recoverCortexTreeTransactions();

    expect(interrupted).toBe(true);
    expect(interruptedRecovery.transactions).toMatchObject([{ status: "recovery-required" }]);
    expect(await readFile(movedPagePath, "utf8")).toBe(group.oldResearch);

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
    expect(await readFile(join(vault, "The Cortex", "Old.md"), "utf8")).toBe(group.oldOldParent);
    expect(await readFile(join(vault, "The Cortex", "Archive.md"), "utf8")).toBe(group.oldNewParent);
    expect(await readFile(join(vault, "The Cortex", "Old", "Research.md"), "utf8")).toBe(group.oldResearch);
    expect(await readFile(join(vault, "The Cortex", "Old", "Research", "Child.md"), "utf8")).toBe(group.oldDescendant);
    await expect(readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await scanCortexVaultNotes(root)).map((entry) => [entry.path, entry.kind])).toEqual([
      ["The Cortex.md", "owned"],
      ["The Cortex/Archive.md", "owned"],
      ["The Cortex/Old.md", "owned"],
      ["The Cortex/Old/Research.md", "owned"],
      ["The Cortex/Old/Research/Child.md", "owned"],
    ]);
  });

  it("proves the exact all-new reparent topology after a committed-manifest restart", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Old.md"), group.oldOldParent, "utf8");
    await writeFile(join(vault, "The Cortex", "Archive.md"), group.oldNewParent, "utf8");
    await writeFile(join(vault, "The Cortex", "Research.md"), group.oldResearch, "utf8");
    await writeFile(join(vault, "The Cortex", "Research", "Child.md"), group.oldDescendant, "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(transactionWriter(new AtomicVaultWriter(root)).applyCortexTreeTransaction(group.plan))
      .resolves.toMatchObject({ status: "committed", error: null });
    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{ status: "committed", error: null }]);
    expect(await readFile(join(vault, "The Cortex", "Old.md"), "utf8")).toBe(group.nextOldParent);
    expect(await readFile(join(vault, "The Cortex", "Archive.md"), "utf8")).toBe(group.nextNewParent);
    expect(await readFile(join(vault, "The Cortex", "Archive", "Research.md"), "utf8")).toBe(group.nextResearch);
    expect(await readFile(join(vault, "The Cortex", "Archive", "Research", "Child.md"), "utf8")).toBe(group.nextDescendant);
    await expect(readFile(join(vault, "The Cortex", "Research.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(vault, "The Cortex", "Research", "Child.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["prepared", []],
    ["publishing", [RESTART_WRITE_MEMBER_ID]],
    ["committed", [RESTART_WRITE_MEMBER_ID, RESTART_CREATE_MEMBER_ID]],
    ["finalized", [RESTART_WRITE_MEMBER_ID, RESTART_CREATE_MEMBER_ID]],
  ] as const)("recovers a restart from the %s manifest phase using only local transaction evidence", async (phase, completedMemberIds) => {
    const vault = await temporaryVault();
    const group = await restartPlan();
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(join(vault, "The Cortex.md"), completedMemberIds.length > 0 ? group.nextRoot : group.oldRoot, "utf8");
    if (completedMemberIds.length === group.plan.members.length) {
      await writeFile(join(vault, "The Cortex", "Child.md"), group.nextChild, "utf8");
    }
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase,
      completedMemberIds,
      preimages: { [RESTART_WRITE_MEMBER_ID]: group.oldRoot },
    });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    if (phase === "prepared" || phase === "publishing") {
      expect(recovery.transactions).toMatchObject([{ status: "rolled-back", completedMemberIds: [], error: null }]);
      expect(await readFile(join(vault, "The Cortex.md"), "utf8")).toBe(group.oldRoot);
      await expect(readFile(join(vault, "The Cortex", "Child.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(cortexTransactionDirectory(vault, RESTART_TRANSACTION_ID))).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }

    expect(recovery.transactions).toMatchObject([{
      transactionId: RESTART_TRANSACTION_ID,
      status: "committed",
      completedMemberIds: [RESTART_WRITE_MEMBER_ID, RESTART_CREATE_MEMBER_ID],
      error: null,
    }]);
    expect(await readFile(join(vault, "The Cortex.md"), "utf8")).toBe(group.nextRoot);
    expect(await readFile(join(vault, "The Cortex", "Child.md"), "utf8")).toBe(group.nextChild);
  });

  it("fails closed on a same-hash member replacement instead of overwriting it during recovery", async () => {
    const vault = await temporaryVault();
    const group = await restartPlan();
    const rootPath = join(vault, "The Cortex.md");
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(rootPath, group.nextRoot, "utf8");
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [RESTART_WRITE_MEMBER_ID],
      preimages: { [RESTART_WRITE_MEMBER_ID]: group.oldRoot },
    });
    const replacement = join(vault, "replacement.md");
    await writeFile(replacement, group.nextRoot, "utf8");
    await rename(replacement, rootPath);
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{
      transactionId: RESTART_TRANSACTION_ID,
      status: "recovery-required",
      error: { code: "recovery-required", retryable: false },
    }]);
    expect(await readFile(rootPath, "utf8")).toBe(group.nextRoot);
    expect((await lstat(cortexTransactionDirectory(vault, RESTART_TRANSACTION_ID))).isDirectory()).toBe(true);
  });

  it("fails closed on a tampered private preimage without changing a committed member", async () => {
    const vault = await temporaryVault();
    const group = await restartPlan();
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(join(vault, "The Cortex.md"), group.oldRoot, "utf8");
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });
    await expect(transactionWriter(new AtomicVaultWriter(root)).applyCortexTreeTransaction(group.plan))
      .resolves.toMatchObject({ status: "committed" });
    const preimage = join(cortexTransactionDirectory(vault, RESTART_TRANSACTION_ID), `${RESTART_WRITE_MEMBER_ID}.preimage`);
    await writeFile(preimage, "tampered preimage", "utf8");

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{
      status: "recovery-required",
      error: { code: "recovery-required", retryable: false },
    }]);
    expect(await readFile(join(vault, "The Cortex.md"), "utf8")).toBe(group.nextRoot);
  });

  it("validates every publishing preimage before a rollback can partially restore a later member", async () => {
    const vault = await temporaryVault();
    const group = await reparentPlan();
    await mkdir(join(vault, "The Cortex", "Research"), { recursive: true });
    await mkdir(join(vault, "The Cortex", "Archive"), { recursive: true });
    await writeFile(join(vault, "The Cortex", "Old.md"), group.nextOldParent, "utf8");
    await writeFile(join(vault, "The Cortex", "Archive.md"), group.nextNewParent, "utf8");
    await writeFile(join(vault, "The Cortex", "Research.md"), group.oldResearch, "utf8");
    await writeFile(join(vault, "The Cortex", "Research", "Child.md"), group.oldDescendant, "utf8");
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "publishing",
      completedMemberIds: [OLD_PARENT_MEMBER_ID, NEW_PARENT_MEMBER_ID],
      preimages: {
        [OLD_PARENT_MEMBER_ID]: group.oldOldParent,
        [NEW_PARENT_MEMBER_ID]: group.oldNewParent,
        [MOVE_MEMBER_ID]: group.oldResearch,
        [MOVED_PAGE_MEMBER_ID]: group.oldResearch,
        [DESCENDANT_MEMBER_ID]: group.oldDescendant,
      },
    });
    await writeFile(
      join(cortexTransactionDirectory(vault, REPARENT_TRANSACTION_ID), `${OLD_PARENT_MEMBER_ID}.preimage`),
      "tampered old parent preimage",
      "utf8",
    );
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    const recovery = await transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions();

    expect(recovery.transactions).toMatchObject([{
      status: "recovery-required",
      error: { code: "recovery-required", retryable: false },
    }]);
    expect(await readFile(join(vault, "The Cortex", "Old.md"), "utf8")).toBe(group.nextOldParent);
    expect(await readFile(join(vault, "The Cortex", "Archive.md"), "utf8")).toBe(group.nextNewParent);
    expect((await lstat(cortexTransactionDirectory(vault, REPARENT_TRANSACTION_ID))).isDirectory()).toBe(true);
  });

  it("does not inspect or mutate pending manifests while another Cortex writer owns the cooperative lock", async () => {
    const vault = await temporaryVault();
    const group = await restartPlan();
    await mkdir(join(vault, "The Cortex"), { recursive: true });
    await writeFile(join(vault, "The Cortex.md"), group.oldRoot, "utf8");
    await writeRestartManifest({
      vault,
      plan: group.plan,
      phase: "prepared",
      completedMemberIds: [],
      preimages: { [RESTART_WRITE_MEMBER_ID]: group.oldRoot },
    });
    const lockPath = cortexMoveLockPath(vault);
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(cortexMoveLockOwnerPath(vault), JSON.stringify({
      schemaVersion: 1,
      ownerToken: "44444444-4444-4444-8444-444444444444",
      startedAt: "2026-07-16T12:00:00.000Z",
    }), { encoding: "utf8", mode: 0o600 });
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(transactionWriter(new AtomicVaultWriter(root)).recoverCortexTreeTransactions())
      .rejects.toMatchObject({ code: "active-lock", retryable: false });

    expect(await readFile(join(vault, "The Cortex.md"), "utf8")).toBe(group.oldRoot);
    expect((await lstat(cortexTransactionDirectory(vault, RESTART_TRANSACTION_ID))).isDirectory()).toBe(true);
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
  });
});
