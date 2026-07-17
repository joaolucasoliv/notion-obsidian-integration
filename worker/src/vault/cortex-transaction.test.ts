import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@grandbox-bridge/shared";
import {
  calculateCortexTreeTransactionManifestDigest,
  parseCortexTreeTransactionManifest,
  parseCortexTreeTransactionPlan,
} from "./cortex-transaction";

const ROOT_ID = "0f168e77-fb55-4a1d-9a73-0891e7eb2c35";
const PAGE_A_ID = "411d25ac-178d-4ea7-a6c8-df597a62c4fc";
const PAGE_B_ID = "5d277a86-8a5d-4eab-a891-c1a0534e765a";
const TRANSACTION_ID = "7d277a86-8a5d-4eab-a891-c1a0534e765a";
const WRITE_MEMBER_ID = "8d277a86-8a5d-4eab-a891-c1a0534e765a";
const CREATE_MEMBER_ID = "9d277a86-8a5d-4eab-a891-c1a0534e765a";
const MOVE_MEMBER_ID = "ad277a86-8a5d-4eab-a891-c1a0534e765a";
const HASH_A = "727315411367e16793c5140eedbe2371b9619a47ce90e2b3e3b3704e2e725adc";
const HASH_B = "827315411367e16793c5140eedbe2371b9619a47ce90e2b3e3b3704e2e725adc";
const HASH_C = "927315411367e16793c5140eedbe2371b9619a47ce90e2b3e3b3704e2e725adc";
const NOTE_BODY = "private transaction note body must never reach durable metadata";
const NOTE_BODY_HASH = "28ec7f965d2a6a5c48cc95c2cc069f5b94dc66e682254cc0ed4fdfb188cf0622";

function validPlan() {
  return {
    schemaVersion: 1,
    transactionId: TRANSACTION_ID,
    rootPageId: ROOT_ID,
    participantIds: [ROOT_ID, PAGE_A_ID, PAGE_B_ID],
    members: [
      {
        memberId: WRITE_MEMBER_ID,
        kind: "write",
        relativePath: "The Cortex.md",
        expectedByteHash: HASH_A,
        resultByteHash: NOTE_BODY_HASH,
        content: NOTE_BODY,
      },
      {
        memberId: CREATE_MEMBER_ID,
        kind: "create",
        relativePath: "The Cortex/Research.md",
        expectedAbsent: true,
        resultByteHash: NOTE_BODY_HASH,
        content: NOTE_BODY,
      },
      {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        sourcePath: "The Cortex/Old/Topic.md",
        targetPath: "The Cortex/New/Topic.md",
        expectedSourceByteHash: HASH_A,
      },
    ],
  };
}

function validManifestInput() {
  return {
    schemaVersion: 1,
    transactionId: TRANSACTION_ID,
    rootPageId: ROOT_ID,
    participantIds: [ROOT_ID, PAGE_A_ID, PAGE_B_ID],
    phase: "prepared",
    completedMemberIds: [],
    pendingMember: null,
    members: [
      {
        memberId: WRITE_MEMBER_ID,
        kind: "write",
        relativePath: "The Cortex.md",
        expectedByteHash: HASH_A,
        resultByteHash: HASH_B,
        preimageFile: `${WRITE_MEMBER_ID}.preimage`,
      },
      {
        memberId: CREATE_MEMBER_ID,
        kind: "create",
        relativePath: "The Cortex/Research.md",
        expectedAbsent: true,
        resultByteHash: HASH_C,
        preimageFile: null,
      },
      {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        sourcePath: "The Cortex/Old/Topic.md",
        targetPath: "The Cortex/New/Topic.md",
        expectedSourceByteHash: HASH_A,
        resultByteHash: HASH_A,
        preimageFile: `${MOVE_MEMBER_ID}.preimage`,
      },
    ],
  };
}

async function signedManifest(input = validManifestInput()) {
  return {
    ...input,
    manifestDigest: await calculateCortexTreeTransactionManifestDigest(input),
  };
}

async function rawSignedManifest(input: unknown) {
  return {
    ...(input as object),
    manifestDigest: await sha256Hex(canonicalJson(input)),
  };
}

function forwardMoveOperation(overrides: Record<string, unknown> = {}) {
  return {
    direction: "forward",
    stage: "pre-link",
    sourceFileIdentity: { dev: "1", ino: "2" },
    targetFileIdentity: { dev: "1", ino: "2" },
    sourceCompanionIdentity: null,
    targetCompanionIdentity: null,
    reservationIdentity: null,
    ...overrides,
  };
}

function forwardMovePendingMember(overrides: Record<string, unknown> = {}) {
  return {
    memberId: MOVE_MEMBER_ID,
    kind: "move",
    moveOperation: forwardMoveOperation(),
    ...overrides,
  };
}

function legacyWriterRollbackManifest() {
  const input = validManifestInput();
  return {
    ...input,
    phase: "rolling-back",
    completedMemberIds: [WRITE_MEMBER_ID],
    pendingMember: null,
    rollbackPending: {
      memberId: WRITE_MEMBER_ID,
      kind: "write",
      expectedNewIdentity: { file: { dev: "1", ino: "2" } },
      intendedOldIdentity: { file: { dev: "1", ino: "3" } },
    },
    members: input.members.map((member) => member.memberId === WRITE_MEMBER_ID
      ? { ...member, postIdentity: { file: { dev: "1", ino: "2" } } }
      : member),
  };
}

describe("Cortex tree transaction contracts", () => {
  it("parses exact discriminated write, create, and move members without putting note bytes in the manifest", async () => {
    const plan = await parseCortexTreeTransactionPlan(validPlan());
    const manifest = await parseCortexTreeTransactionManifest(await signedManifest());

    expect(plan.members.map((member) => member.kind)).toEqual(["write", "create", "move"]);
    expect(manifest.members.map((member) => member.kind)).toEqual(["write", "create", "move"]);
    expect(JSON.stringify(manifest)).not.toContain(NOTE_BODY);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
  });

  it.each([
    ["write", (plan: ReturnType<typeof validPlan>) => { plan.members[0]!.relativePath = "../outside.md"; }],
    ["create", (plan: ReturnType<typeof validPlan>) => { plan.members[1]!.relativePath = "Notes/outside.md"; }],
    ["move", (plan: ReturnType<typeof validPlan>) => { plan.members[2]!.targetPath = "/outside.md"; }],
  ])("rejects unsafe Cortex %s member paths", async (_kind, mutate) => {
    const plan = validPlan();
    mutate(plan);

    await expect(parseCortexTreeTransactionPlan(plan)).rejects.toThrow(/path/i);
  });

  it("rejects duplicate transaction member identities", async () => {
    const plan = validPlan();
    plan.members[1]!.memberId = WRITE_MEMBER_ID;

    await expect(parseCortexTreeTransactionPlan(plan)).rejects.toThrow(/member/i);
  });

  it.each([
    ["write", (plan: ReturnType<typeof validPlan>) => { plan.members[0]!.resultByteHash = HASH_B; }],
    ["create", (plan: ReturnType<typeof validPlan>) => { plan.members[1]!.resultByteHash = HASH_C; }],
  ])("rejects a %s member whose result hash does not match its content", async (_kind, mutate) => {
    const plan = validPlan();
    mutate(plan);

    await expect(parseCortexTreeTransactionPlan(plan)).rejects.toThrow(/result.*hash|content/i);
  });

  it("rejects unsorted transaction participants", async () => {
    const plan = validPlan();
    plan.participantIds = [PAGE_A_ID, ROOT_ID, PAGE_B_ID];

    await expect(parseCortexTreeTransactionPlan(plan)).rejects.toThrow(/participant/i);
  });

  it("rejects invalid manifest phases and canonical digest mismatches", async () => {
    const invalidPhase = await signedManifest({ ...validManifestInput(), phase: "publishing" });
    const invalidCommitted = await signedManifest({ ...validManifestInput(), phase: "committed" });
    const manifest = await signedManifest();

    await expect(parseCortexTreeTransactionManifest({ ...invalidPhase, phase: "unknown" })).rejects.toThrow(/phase/i);
    await expect(parseCortexTreeTransactionManifest(invalidCommitted)).rejects.toThrow(/completed|phase/i);
    await expect(
      parseCortexTreeTransactionManifest({ ...manifest, manifestDigest: "f".repeat(64) }),
    ).rejects.toThrow(/digest/i);
  });

  it("rejects a manifest preimage that is not owned by its member", async () => {
    const input = validManifestInput();
    input.members[0]!.preimageFile = `${MOVE_MEMBER_ID}.preimage`;
    const manifest = await signedManifest(input);

    await expect(parseCortexTreeTransactionManifest(manifest)).rejects.toThrow(/preimage/i);
  });

  it("rejects a completed member without durable post-publish identity evidence", async () => {
    const input = validManifestInput();
    const manifest = await signedManifest({
      ...input,
      phase: "publishing",
      completedMemberIds: [WRITE_MEMBER_ID],
    });

    await expect(parseCortexTreeTransactionManifest(manifest)).rejects.toThrow(/post.*identity/i);
  });

  it("accepts one digest-covered rollback WAL record only in a rolling-back manifest", async () => {
    const input = validManifestInput();
    const rollingBack = {
      ...input,
      phase: "rolling-back",
      completedMemberIds: [WRITE_MEMBER_ID],
      pendingMember: null,
      rollbackPendingMember: {
        memberId: WRITE_MEMBER_ID,
        kind: "write",
        expectedNewIdentity: { file: { dev: "1", ino: "2" } },
        intendedOldIdentity: { file: { dev: "1", ino: "3" } },
      },
      members: input.members.map((member) => member.memberId === WRITE_MEMBER_ID
        ? { ...member, postIdentity: { file: { dev: "1", ino: "2" } } }
        : member),
    };

    const manifest = await signedManifest(rollingBack);
    await expect(parseCortexTreeTransactionManifest(manifest)).resolves.toMatchObject({
      phase: "rolling-back",
      pendingMember: null,
      rollbackPendingMember: { memberId: WRITE_MEMBER_ID, kind: "write" },
    });
    await expect(parseCortexTreeTransactionManifest({
      ...manifest,
      rollbackPendingMember: {
        ...rollingBack.rollbackPendingMember,
        intendedOldIdentity: { file: { dev: "1", ino: "99" } },
      },
    })).rejects.toThrow(/digest/i);
    await expect(parseCortexTreeTransactionManifest(await rawSignedManifest({
      ...rollingBack,
      pendingMember: {
        memberId: CREATE_MEMBER_ID,
        kind: "create",
        state: "reserved",
        preIdentity: null,
        postIdentity: null,
      },
    }))).rejects.toThrow(/rollback|pending|phase/i);
  });

  it("parses and preserves the writer's legacy rollbackPending manifest shape", async () => {
    const legacy = legacyWriterRollbackManifest();
    const persisted = await rawSignedManifest(legacy);
    const parsed = await parseCortexTreeTransactionManifest(persisted);
    const serialized = JSON.stringify(parsed);

    expect(parsed).toMatchObject({ rollbackPending: legacy.rollbackPending });
    expect(JSON.parse(serialized)).toEqual(persisted);
    expect(serialized).not.toContain("rollbackPendingMember");
    await expect(parseCortexTreeTransactionManifest(JSON.parse(serialized))).resolves.toMatchObject({
      rollbackPending: legacy.rollbackPending,
    });
    await expect(parseCortexTreeTransactionManifest(await rawSignedManifest({
      ...legacy,
      rollbackPending: { ...legacy.rollbackPending, unexpected: true },
    }))).rejects.toThrow(/unrecognized/i);
  });

  it("preserves absent optional WAL fields through parse and JSON serialization", async () => {
    const { pendingMember: _pendingMember, ...withoutOptionalWalFields } = validManifestInput();
    const signed = await signedManifest(withoutOptionalWalFields);
    const parsed = await parseCortexTreeTransactionManifest(signed);
    const serialized = JSON.stringify(parsed);
    const roundTripped = JSON.parse(serialized);

    expect(roundTripped).not.toHaveProperty("pendingMember");
    expect(roundTripped).not.toHaveProperty("rollbackPending");
    expect(roundTripped).not.toHaveProperty("rollbackPendingMember");
    await expect(parseCortexTreeTransactionManifest(roundTripped)).resolves.toMatchObject({
      phase: "prepared",
    });
  });

  it("parses a digest-covered forward move operation", async () => {
    const input = validManifestInput();
    const manifest = await signedManifest({
      ...input,
      phase: "publishing",
      completedMemberIds: [WRITE_MEMBER_ID, CREATE_MEMBER_ID],
      pendingMember: forwardMovePendingMember(),
      rollbackPendingMember: null,
      members: input.members.map((member) => member.memberId === WRITE_MEMBER_ID
        ? { ...member, postIdentity: { file: { dev: "1", ino: "5" } } }
        : member.memberId === CREATE_MEMBER_ID
          ? { ...member, postIdentity: { file: { dev: "1", ino: "6" } } }
          : member),
    });

    await expect(parseCortexTreeTransactionManifest(manifest)).resolves.toMatchObject({
      phase: "publishing",
      pendingMember: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        moveOperation: { direction: "forward", stage: "pre-link" },
      },
      rollbackPendingMember: null,
    });
    await expect(parseCortexTreeTransactionManifest({
      ...manifest,
      pendingMember: forwardMovePendingMember({
        moveOperation: forwardMoveOperation({ stage: "target-linked" }),
      }),
    })).rejects.toThrow(/digest/i);
  });

  it("rejects a move operation whose source and target file identities differ", async () => {
    const input = validManifestInput();
    const manifest = await rawSignedManifest({
      ...input,
      phase: "publishing",
      completedMemberIds: [WRITE_MEMBER_ID, CREATE_MEMBER_ID],
      pendingMember: forwardMovePendingMember({
        moveOperation: forwardMoveOperation({ targetFileIdentity: { dev: "1", ino: "99" } }),
      }),
      rollbackPendingMember: null,
    });

    await expect(parseCortexTreeTransactionManifest(manifest)).rejects.toThrow(/source.*target.*file|identity/i);
  });

  it("rejects a visible companion reservation without its exact durable identity", async () => {
    const input = validManifestInput();
    const manifest = await rawSignedManifest({
      ...input,
      phase: "publishing",
      completedMemberIds: [WRITE_MEMBER_ID, CREATE_MEMBER_ID],
      pendingMember: forwardMovePendingMember({
        moveOperation: forwardMoveOperation({
          stage: "companion-reserved",
          sourceCompanionIdentity: { dev: "1", ino: "3" },
          targetCompanionIdentity: { dev: "1", ino: "3" },
          reservationIdentity: null,
        }),
      }),
      rollbackPendingMember: null,
      members: input.members.map((member) => member.memberId === WRITE_MEMBER_ID
        ? { ...member, postIdentity: { file: { dev: "1", ino: "5" } } }
        : member.memberId === CREATE_MEMBER_ID
          ? { ...member, postIdentity: { file: { dev: "1", ino: "6" } } }
          : member),
    });

    await expect(parseCortexTreeTransactionManifest(manifest)).rejects.toThrow(/reservation/i);
  });

  it.each(["companion-reserved", "companion-moved", "source-unlinked"])(
    "rejects a %s companion reservation whose identity aliases the moved companion",
    async (stage) => {
      const input = validManifestInput();
      const manifest = await rawSignedManifest({
        ...input,
        phase: "publishing",
        completedMemberIds: [WRITE_MEMBER_ID, CREATE_MEMBER_ID],
        pendingMember: forwardMovePendingMember({
          moveOperation: forwardMoveOperation({
            stage,
            sourceCompanionIdentity: { dev: "1", ino: "3" },
            targetCompanionIdentity: { dev: "1", ino: "3" },
            reservationIdentity: { dev: "1", ino: "3" },
          }),
        }),
        rollbackPendingMember: null,
        members: input.members.map((member) => member.memberId === WRITE_MEMBER_ID
          ? { ...member, postIdentity: { file: { dev: "1", ino: "5" } } }
          : member.memberId === CREATE_MEMBER_ID
            ? { ...member, postIdentity: { file: { dev: "1", ino: "6" } } }
            : member),
      });

      await expect(parseCortexTreeTransactionManifest(manifest)).rejects.toThrow(/reservation.*distinct|alias/i);
    },
  );

  it("rejects a legacy rollback move whose expected target file identity differs from the completed move", async () => {
    const input = validManifestInput();
    const manifest = await rawSignedManifest({
      ...input,
      phase: "rolling-back",
      completedMemberIds: [WRITE_MEMBER_ID, CREATE_MEMBER_ID, MOVE_MEMBER_ID],
      pendingMember: null,
      rollbackPending: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        expectedNewIdentity: {
          targetFile: { dev: "1", ino: "99" },
          targetDirectory: null,
        },
        intendedOldIdentity: {
          sourceFile: { dev: "1", ino: "99" },
          sourceDirectory: null,
        },
      },
      members: input.members.map((member) => member.memberId === WRITE_MEMBER_ID
        ? { ...member, postIdentity: { file: { dev: "1", ino: "5" } } }
        : member.memberId === CREATE_MEMBER_ID
          ? { ...member, postIdentity: { file: { dev: "1", ino: "6" } } }
          : { ...member, postIdentity: { targetFile: { dev: "1", ino: "2" }, targetDirectory: null } }),
    });

    await expect(parseCortexTreeTransactionManifest(manifest)).rejects.toThrow(/expected.*target.*identity|legacy.*move/i);
  });

  it("rejects a move operation whose source and target companion identities differ", async () => {
    const input = validManifestInput();
    const manifest = await rawSignedManifest({
      ...input,
      phase: "publishing",
      completedMemberIds: [WRITE_MEMBER_ID, CREATE_MEMBER_ID],
      pendingMember: forwardMovePendingMember({
        moveOperation: forwardMoveOperation({
          sourceCompanionIdentity: { dev: "1", ino: "3" },
          targetCompanionIdentity: { dev: "1", ino: "4" },
        }),
      }),
      rollbackPendingMember: null,
    });

    await expect(parseCortexTreeTransactionManifest(manifest)).rejects.toThrow(/companion.*identit|identity/i);
  });

  it("rejects simultaneous forward and rollback WAL records", async () => {
    const input = validManifestInput();
    const completedMembers = input.members.map((member) => member.kind === "move"
      ? { ...member, postIdentity: { targetFile: { dev: "1", ino: "2" }, targetDirectory: null } }
      : member);
    const manifest = await rawSignedManifest({
      ...input,
      phase: "rolling-back",
      completedMemberIds: [WRITE_MEMBER_ID, CREATE_MEMBER_ID, MOVE_MEMBER_ID],
      pendingMember: forwardMovePendingMember(),
      rollbackPendingMember: {
        memberId: MOVE_MEMBER_ID,
        kind: "move",
        moveOperation: { ...forwardMoveOperation(), direction: "reverse" },
      },
      members: completedMembers,
    });

    await expect(parseCortexTreeTransactionManifest(manifest)).rejects.toThrow(/forward|rollback|wal|pending/i);
  });

  it("rejects a rollback WAL outside a rolling-back manifest", async () => {
    const input = validManifestInput();
    const manifest = await rawSignedManifest({
      ...input,
      phase: "publishing",
      completedMemberIds: [WRITE_MEMBER_ID],
      pendingMember: null,
      rollbackPendingMember: {
        memberId: WRITE_MEMBER_ID,
        kind: "write",
        expectedNewIdentity: { file: { dev: "1", ino: "2" } },
        intendedOldIdentity: { file: { dev: "1", ino: "3" } },
      },
      members: input.members.map((member) => member.memberId === WRITE_MEMBER_ID
        ? { ...member, postIdentity: { file: { dev: "1", ino: "2" } } }
        : member),
    });

    await expect(parseCortexTreeTransactionManifest(manifest)).rejects.toThrow(/rollback|rolling-back|phase/i);
  });

  it("rejects an unordered completed prefix while rolling back", async () => {
    const input = validManifestInput();
    const manifest = await rawSignedManifest({
      ...input,
      phase: "rolling-back",
      completedMemberIds: [CREATE_MEMBER_ID, WRITE_MEMBER_ID],
      pendingMember: null,
      rollbackPendingMember: {
        memberId: WRITE_MEMBER_ID,
        kind: "write",
        expectedNewIdentity: { file: { dev: "1", ino: "2" } },
        intendedOldIdentity: { file: { dev: "1", ino: "3" } },
      },
      members: input.members.map((member) => member.memberId === WRITE_MEMBER_ID
        ? { ...member, postIdentity: { file: { dev: "1", ino: "2" } } }
        : member.memberId === CREATE_MEMBER_ID
          ? { ...member, postIdentity: { file: { dev: "1", ino: "4" } } }
          : member),
    });

    await expect(parseCortexTreeTransactionManifest(manifest)).rejects.toThrow(/completed.*prefix|ordered/i);
  });

  it("keeps only a legacy ready move without a move operation", async () => {
    const input = validManifestInput();
    const legacyReady = {
      memberId: MOVE_MEMBER_ID,
      kind: "move",
      state: "ready",
      preIdentity: {
        sourceFile: { dev: "1", ino: "2" },
        sourceDirectory: { dev: "1", ino: "3" },
      },
      postIdentity: {
        targetFile: { dev: "1", ino: "2" },
        targetDirectory: { dev: "1", ino: "3" },
      },
      reservationIdentity: null,
    };
    const legacyManifest = await rawSignedManifest({
      ...input,
      phase: "publishing",
      completedMemberIds: [WRITE_MEMBER_ID, CREATE_MEMBER_ID],
      pendingMember: legacyReady,
      members: input.members.map((member) => member.memberId === WRITE_MEMBER_ID
        ? { ...member, postIdentity: { file: { dev: "1", ino: "5" } } }
        : member.memberId === CREATE_MEMBER_ID
          ? { ...member, postIdentity: { file: { dev: "1", ino: "6" } } }
          : member),
    });

    await expect(parseCortexTreeTransactionManifest(legacyManifest)).resolves.toMatchObject({
      pendingMember: { kind: "move", state: "ready" },
    });
    const { manifestDigest: _legacyDigest, ...legacyUnsigned } = legacyManifest;
    await expect(parseCortexTreeTransactionManifest(await rawSignedManifest({
      ...legacyUnsigned,
      pendingMember: { ...legacyReady, state: "target-link" },
    }))).rejects.toThrow(/ready|legacy/i);
  });

  it("uses a canonical manifest digest independent of object property insertion order", async () => {
    const input = validManifestInput();
    const reordered = {
      members: input.members,
      completedMemberIds: input.completedMemberIds,
      pendingMember: input.pendingMember,
      phase: input.phase,
      participantIds: input.participantIds,
      rootPageId: input.rootPageId,
      transactionId: input.transactionId,
      schemaVersion: input.schemaVersion,
    };

    await expect(calculateCortexTreeTransactionManifestDigest(reordered)).resolves.toBe(
      await calculateCortexTreeTransactionManifestDigest(input),
    );
  });
});
