import {
  canonicalJson,
  sha256Hex,
  type CortexTreeTransactionMember,
  type CortexTreeTransactionPlan,
} from "@grandbox-bridge/shared";
import { z } from "zod";
import { MAX_LOCAL_NOTE_BYTES } from "../markdown/frontmatter.js";
import {
  CORTEX_ROOT_DIRECTORY_PATH,
  isCortexLocalPath,
} from "../cortex/path.js";

const canonicalUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "Expected a canonical UUID");
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 hash");
const transactionPhaseSchema = z.enum(["prepared", "publishing", "rolling-back", "committed", "finalized"]);
const pendingMemberStateSchema = z.enum(["reserved", "ready"]);
const legacyPendingMoveStateSchema = z.enum(["ready", "target-link", "companion-reserve", "companion-rename", "source-unlink"]);
const cortexMoveDirectionSchema = z.enum(["forward", "reverse"]);
const cortexMoveStageSchema = z.enum([
  "pre-link",
  "target-linked",
  "companion-reserve",
  "companion-reserved",
  "companion-moved",
  "source-unlinked",
]);
const filesystemIdentitySchema = z
  .object({
    dev: z.string().regex(/^[0-9]+$/, "Expected a filesystem device identity"),
    ino: z.string().regex(/^[0-9]+$/, "Expected a filesystem inode identity"),
  })
  .strict();
const filePostIdentitySchema = z.object({ file: filesystemIdentitySchema }).strict();
const movePostIdentitySchema = z
  .object({
    targetFile: filesystemIdentitySchema,
    targetDirectory: filesystemIdentitySchema.nullable(),
  })
  .strict();
const movePreIdentitySchema = z
  .object({
    sourceFile: filesystemIdentitySchema,
    sourceDirectory: filesystemIdentitySchema.nullable(),
  })
  .strict();

type FilesystemIdentityEvidence = z.infer<typeof filesystemIdentitySchema>;
type FilePostIdentityEvidence = z.infer<typeof filePostIdentitySchema>;
type MovePostIdentityEvidence = z.infer<typeof movePostIdentitySchema>;

function isFilePostIdentity(
  value: FilePostIdentityEvidence | MovePostIdentityEvidence,
): value is FilePostIdentityEvidence {
  return "file" in value;
}

function isMovePostIdentity(
  value: FilePostIdentityEvidence | MovePostIdentityEvidence,
): value is MovePostIdentityEvidence {
  return "targetFile" in value;
}

function sameFilesystemIdentityEvidence(left: FilesystemIdentityEvidence, right: FilesystemIdentityEvidence): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameNullableFilesystemIdentityEvidence(
  left: FilesystemIdentityEvidence | null,
  right: FilesystemIdentityEvidence | null,
): boolean {
  return left === null ? right === null : right !== null && sameFilesystemIdentityEvidence(left, right);
}

const moveOperationSchema = z
  .object({
    direction: cortexMoveDirectionSchema,
    stage: cortexMoveStageSchema,
    sourceFileIdentity: filesystemIdentitySchema,
    targetFileIdentity: filesystemIdentitySchema,
    sourceCompanionIdentity: filesystemIdentitySchema.nullable(),
    targetCompanionIdentity: filesystemIdentitySchema.nullable(),
    reservationIdentity: filesystemIdentitySchema.nullable(),
  })
  .strict();

const pendingWriteMemberSchema = z
  .object({
    memberId: canonicalUuidSchema,
    kind: z.literal("write"),
    state: pendingMemberStateSchema,
    preIdentity: filesystemIdentitySchema,
    postIdentity: filePostIdentitySchema.nullable(),
  })
  .strict();

const pendingCreateMemberSchema = z
  .object({
    memberId: canonicalUuidSchema,
    kind: z.literal("create"),
    state: pendingMemberStateSchema,
    preIdentity: z.null(),
    postIdentity: filePostIdentitySchema.nullable(),
  })
  .strict();

const legacyPendingMoveMemberSchema = z
  .object({
    memberId: canonicalUuidSchema,
    kind: z.literal("move"),
    state: legacyPendingMoveStateSchema,
    preIdentity: movePreIdentitySchema,
    postIdentity: movePostIdentitySchema,
    reservationIdentity: filesystemIdentitySchema.nullable().optional(),
  })
  .strict();

/** A ready move without an operation is the sole pre-WAL move compatibility form. */
const pendingMoveMemberSchema = z
  .object({
    memberId: canonicalUuidSchema,
    kind: z.literal("move"),
    state: z.literal("ready").optional(),
    preIdentity: movePreIdentitySchema.optional(),
    postIdentity: movePostIdentitySchema.optional(),
    reservationIdentity: filesystemIdentitySchema.nullable().optional(),
    moveOperation: moveOperationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.moveOperation !== undefined) {
      if (
        value.state !== undefined ||
        value.preIdentity !== undefined ||
        value.postIdentity !== undefined ||
        value.reservationIdentity !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "move operations must not retain legacy move state or identity fields",
        });
      }
      return;
    }
    if (value.state !== "ready" || value.preIdentity === undefined || value.postIdentity === undefined) {
      context.addIssue({
        code: "custom",
        message: "legacy move manifests require the exact ready state and durable identity evidence",
      });
      return;
    }
    if (value.reservationIdentity !== undefined && value.reservationIdentity !== null) {
      context.addIssue({
        code: "custom",
        message: "legacy ready move manifests must not retain a companion reservation identity",
      });
    }
  });

const pendingMemberSchema = z.discriminatedUnion("kind", [
  pendingWriteMemberSchema,
  pendingCreateMemberSchema,
  pendingMoveMemberSchema,
]);

const rollbackPendingWriteMemberSchema = z
  .object({
    memberId: canonicalUuidSchema,
    kind: z.literal("write"),
    expectedNewIdentity: filePostIdentitySchema,
    intendedOldIdentity: filePostIdentitySchema,
  })
  .strict();

const rollbackPendingCreateMemberSchema = z
  .object({
    memberId: canonicalUuidSchema,
    kind: z.literal("create"),
    expectedNewIdentity: filePostIdentitySchema,
    intendedOldAbsent: z.literal(true),
  })
  .strict();

const legacyRollbackPendingMoveMemberSchema = z
  .object({
    memberId: canonicalUuidSchema,
    kind: z.literal("move"),
    expectedNewIdentity: movePostIdentitySchema,
    intendedOldIdentity: movePreIdentitySchema,
  })
  .strict();

const legacyRollbackPendingSchema = z.discriminatedUnion("kind", [
  rollbackPendingWriteMemberSchema,
  rollbackPendingCreateMemberSchema,
  legacyRollbackPendingMoveMemberSchema,
]);

const rollbackPendingMemberSchema = z.discriminatedUnion("kind", [
  rollbackPendingWriteMemberSchema,
  rollbackPendingCreateMemberSchema,
  z
    .object({
      memberId: canonicalUuidSchema,
      kind: z.literal("move"),
      moveOperation: moveOperationSchema,
    })
    .strict(),
]);

function isCortexMarkdownPath(value: string): boolean {
  return isCortexLocalPath(value) && value.endsWith(".md");
}

function isCortexDescendantMarkdownPath(value: string): boolean {
  return value.startsWith(`${CORTEX_ROOT_DIRECTORY_PATH}/`) && isCortexMarkdownPath(value);
}

const cortexMarkdownPathSchema = z.string().superRefine((value, context) => {
  if (!isCortexMarkdownPath(value)) {
    context.addIssue({ code: "custom", message: "Expected a safe Cortex markdown path" });
  }
});

const cortexDescendantMarkdownPathSchema = z.string().superRefine((value, context) => {
  if (!isCortexDescendantMarkdownPath(value)) {
    context.addIssue({ code: "custom", message: "Expected a safe Cortex descendant markdown path" });
  }
});

const noteContentSchema = z.string().superRefine((value, context) => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > MAX_LOCAL_NOTE_BYTES) {
    context.addIssue({ code: "custom", message: "Cortex transaction note content exceeds the local note size limit" });
    return;
  }
  try {
    if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) {
      context.addIssue({ code: "custom", message: "Cortex transaction note content must be valid UTF-8" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "Cortex transaction note content must be valid UTF-8" });
  }
});

const transactionMemberSchema = z.discriminatedUnion("kind", [
  z
    .object({
      memberId: canonicalUuidSchema,
      kind: z.literal("write"),
      relativePath: cortexMarkdownPathSchema,
      expectedByteHash: hashSchema,
      resultByteHash: hashSchema,
      content: noteContentSchema,
    })
    .strict(),
  z
    .object({
      memberId: canonicalUuidSchema,
      kind: z.literal("create"),
      relativePath: cortexDescendantMarkdownPathSchema,
      expectedAbsent: z.literal(true),
      resultByteHash: hashSchema,
      content: noteContentSchema,
    })
    .strict(),
  z
    .object({
      memberId: canonicalUuidSchema,
      kind: z.literal("move"),
      sourcePath: cortexDescendantMarkdownPathSchema,
      targetPath: cortexDescendantMarkdownPathSchema,
      expectedSourceByteHash: hashSchema,
    })
    .strict(),
]);

const transactionPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    transactionId: canonicalUuidSchema,
    rootPageId: canonicalUuidSchema,
    participantIds: z.array(canonicalUuidSchema).min(1).max(5_000),
    members: z.array(transactionMemberSchema).min(1).max(5_000),
  })
  .strict();

const manifestMemberSchema = z.discriminatedUnion("kind", [
  z
    .object({
      memberId: canonicalUuidSchema,
      kind: z.literal("write"),
      relativePath: cortexMarkdownPathSchema,
      expectedByteHash: hashSchema,
      resultByteHash: hashSchema,
      preimageFile: z.string().min(1).max(128),
      postIdentity: filePostIdentitySchema.optional(),
      rollbackRestoredIdentity: filePostIdentitySchema.optional(),
    })
    .strict(),
  z
    .object({
      memberId: canonicalUuidSchema,
      kind: z.literal("create"),
      relativePath: cortexDescendantMarkdownPathSchema,
      expectedAbsent: z.literal(true),
      resultByteHash: hashSchema,
      preimageFile: z.null(),
      postIdentity: filePostIdentitySchema.optional(),
    })
    .strict(),
  z
    .object({
      memberId: canonicalUuidSchema,
      kind: z.literal("move"),
      sourcePath: cortexDescendantMarkdownPathSchema,
      targetPath: cortexDescendantMarkdownPathSchema,
      expectedSourceByteHash: hashSchema,
      resultByteHash: hashSchema,
      preimageFile: z.string().min(1).max(128),
      postIdentity: movePostIdentitySchema.optional(),
    })
    .strict(),
]);

const manifestInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    transactionId: canonicalUuidSchema,
    rootPageId: canonicalUuidSchema,
    participantIds: z.array(canonicalUuidSchema).min(1).max(5_000),
    phase: transactionPhaseSchema,
    completedMemberIds: z.array(canonicalUuidSchema).max(5_000),
    pendingMember: pendingMemberSchema.nullable().optional(),
    rollbackPending: legacyRollbackPendingSchema.nullable().optional(),
    rollbackPendingMember: rollbackPendingMemberSchema.nullable().optional(),
    members: z.array(manifestMemberSchema).min(1).max(5_000),
  })
  .strict();

const manifestSchema = manifestInputSchema.extend({ manifestDigest: hashSchema }).strict();

export type CortexTreeTransactionManifestPhase = z.infer<typeof transactionPhaseSchema>;
export type CortexTreeTransactionManifestMember = z.infer<typeof manifestMemberSchema>;
export type CortexMoveDirection = z.infer<typeof cortexMoveDirectionSchema>;
export type CortexTreeTransactionMoveOperation = z.infer<typeof moveOperationSchema>;
/**
 * Task 2 consumes `moveOperation`; this compatibility view keeps the current
 * writer's legacy pending-move surface type-stable until it is migrated.
 */
export type CortexTreeTransactionPendingMember =
  | z.infer<typeof pendingWriteMemberSchema>
  | z.infer<typeof pendingCreateMemberSchema>
  | (z.infer<typeof legacyPendingMoveMemberSchema> & {
    readonly moveOperation?: CortexTreeTransactionMoveOperation;
  });
export type CortexTreeTransactionRollbackPending = z.infer<typeof legacyRollbackPendingSchema>;
export type CortexTreeTransactionRollbackPendingMember = z.infer<typeof rollbackPendingMemberSchema>;
export type CortexTreeTransactionManifestInput = z.infer<typeof manifestInputSchema>;
export interface CortexTreeTransactionManifest {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly rootPageId: string;
  readonly participantIds: readonly string[];
  readonly phase: CortexTreeTransactionManifestPhase;
  readonly completedMemberIds: readonly string[];
  readonly pendingMember: CortexTreeTransactionPendingMember | null;
  readonly rollbackPendingMember: CortexTreeTransactionRollbackPendingMember | null;
  /** Legacy writer view retained only until the rollback executor is migrated. */
  readonly rollbackPending: CortexTreeTransactionRollbackPending | null;
  readonly members: readonly CortexTreeTransactionManifestMember[];
  readonly manifestDigest: string;
}

function contractError(reason: string): never {
  throw new Error(`Invalid Cortex tree transaction: ${reason}`);
}

function assertSortedUniqueParticipantIds(rootPageId: string, participantIds: readonly string[]): void {
  for (let index = 1; index < participantIds.length; index += 1) {
    if (participantIds[index - 1]! >= participantIds[index]!) {
      contractError("participant IDs must be strictly sorted and unique");
    }
  }
  if (!participantIds.includes(rootPageId)) {
    contractError("participant IDs must include the root page ID");
  }
}

function assertUniqueMemberIds(members: readonly { readonly memberId: string }[]): void {
  const memberIds = new Set<string>();
  for (const member of members) {
    if (memberIds.has(member.memberId)) {
      contractError("member IDs must be unique");
    }
    memberIds.add(member.memberId);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertMovePaths(sourcePath: string, targetPath: string): void {
  if (sourcePath === targetPath) {
    contractError("move member paths must differ");
  }
  const sourceDirectory = sourcePath.slice(0, -3);
  const targetDirectory = targetPath.slice(0, -3);
  if (pathsOverlap(sourceDirectory, targetDirectory)) {
    contractError("move member companion paths must not overlap");
  }
}

async function assertPlanFacts(plan: z.infer<typeof transactionPlanSchema>): Promise<void> {
  assertSortedUniqueParticipantIds(plan.rootPageId, plan.participantIds);
  assertUniqueMemberIds(plan.members);
  for (const member of plan.members) {
    if (member.kind === "move") {
      assertMovePaths(member.sourcePath, member.targetPath);
      continue;
    }
    if (await sha256Hex(member.content) !== member.resultByteHash) {
      contractError("write and create member result hashes must match their supplied content");
    }
  }
}

function assertMoveOperationFacts(
  operation: CortexTreeTransactionMoveOperation,
  direction: CortexMoveDirection,
): void {
  if (operation.direction !== direction) {
    contractError(`${direction} move operations must declare the ${direction} direction`);
  }
  if (!sameFilesystemIdentityEvidence(operation.sourceFileIdentity, operation.targetFileIdentity)) {
    contractError("move operation source and target file identities must match exactly");
  }
  if (!sameNullableFilesystemIdentityEvidence(operation.sourceCompanionIdentity, operation.targetCompanionIdentity)) {
    contractError("move operation source and target companion identities must match exactly");
  }

  const hasCompanion = operation.sourceCompanionIdentity !== null;
  const companionStage = operation.stage === "companion-reserve" ||
    operation.stage === "companion-reserved" ||
    operation.stage === "companion-moved";
  if (!hasCompanion && companionStage) {
    contractError("companion move stages require durable companion identity evidence");
  }

  const requiresReservation = operation.stage === "companion-reserved" ||
    operation.stage === "companion-moved" ||
    (operation.stage === "source-unlinked" && hasCompanion);
  if (requiresReservation && operation.reservationIdentity === null) {
    contractError("visible companion reservations require an exact durable reservation identity");
  }
  if (
    requiresReservation &&
    operation.reservationIdentity !== null &&
    operation.sourceCompanionIdentity !== null &&
    sameFilesystemIdentityEvidence(operation.reservationIdentity, operation.sourceCompanionIdentity)
  ) {
    contractError("companion reservation identity must be distinct from the moved companion identity");
  }
  if (!requiresReservation && operation.reservationIdentity !== null) {
    contractError("move operation stage must not retain an inapplicable companion reservation identity");
  }
}

function assertManifestFacts(manifest: z.infer<typeof manifestSchema>): void {
  assertSortedUniqueParticipantIds(manifest.rootPageId, manifest.participantIds);
  assertUniqueMemberIds(manifest.members);

  const memberIds = manifest.members.map((member) => member.memberId);
  const completed = manifest.completedMemberIds;
  if (!completed.every((memberId, index) => memberIds[index] === memberId)) {
    contractError("completed member IDs must be an ordered member prefix");
  }

  if (manifest.rollbackPending !== undefined && manifest.rollbackPendingMember !== undefined) {
    contractError("manifests must not retain both legacy and expanded rollback WAL fields");
  }

  const pending = manifest.pendingMember ?? null;
  const rollback = manifest.rollbackPendingMember ?? manifest.rollbackPending ?? null;

  if (manifest.phase === "prepared" && (completed.length !== 0 || pending !== null || rollback !== null)) {
    contractError("prepared manifests must not have completed, pending, or rollback members");
  }
  if (manifest.phase === "publishing") {
    if (completed.length >= manifest.members.length) {
      contractError("publishing manifests must retain an incomplete member");
    }
    if (rollback !== null) {
      contractError("publishing manifests must not retain a rollback member");
    }
  }
  if (manifest.phase === "rolling-back") {
    if (pending !== null) {
      contractError("rolling-back manifests must not retain a forward pending member");
    }
    if (rollback !== null) {
      const current = manifest.members[completed.length - 1];
      if (
        current === undefined ||
        current.memberId !== rollback.memberId ||
        current.kind !== rollback.kind ||
        current.postIdentity === undefined
      ) {
        contractError("rollback member must be the final completed member with durable post-publish identity evidence");
      }
      if (rollback.kind === "write" || rollback.kind === "create") {
        if (
          current.kind !== rollback.kind ||
          !isFilePostIdentity(current.postIdentity) ||
          !sameFilesystemIdentityEvidence(current.postIdentity.file, rollback.expectedNewIdentity.file)
        ) {
          contractError("rollback member expected new identity must match its completed file identity");
        }
      } else if ("moveOperation" in rollback) {
        if (current.kind !== "move" || !isMovePostIdentity(current.postIdentity)) {
          contractError("rollback move member must retain completed move identity evidence");
        }
        assertMoveOperationFacts(rollback.moveOperation, "reverse");
        if (
          !sameFilesystemIdentityEvidence(current.postIdentity.targetFile, rollback.moveOperation.sourceFileIdentity) ||
          !sameFilesystemIdentityEvidence(current.postIdentity.targetFile, rollback.moveOperation.targetFileIdentity) ||
          !sameNullableFilesystemIdentityEvidence(
            current.postIdentity.targetDirectory,
            rollback.moveOperation.sourceCompanionIdentity,
          ) ||
          !sameNullableFilesystemIdentityEvidence(
            current.postIdentity.targetDirectory,
            rollback.moveOperation.targetCompanionIdentity,
          )
        ) {
          contractError("rollback move operation identities must match its completed move identity evidence");
        }
      } else if (
        current.kind !== "move" ||
        !isMovePostIdentity(current.postIdentity) ||
        !sameFilesystemIdentityEvidence(current.postIdentity.targetFile, rollback.expectedNewIdentity.targetFile) ||
        !sameNullableFilesystemIdentityEvidence(current.postIdentity.targetDirectory, rollback.expectedNewIdentity.targetDirectory) ||
        !sameFilesystemIdentityEvidence(rollback.expectedNewIdentity.targetFile, rollback.intendedOldIdentity.sourceFile) ||
        !sameNullableFilesystemIdentityEvidence(
          rollback.expectedNewIdentity.targetDirectory,
          rollback.intendedOldIdentity.sourceDirectory,
        )
      ) {
        contractError("legacy rollback move identity must match its completed move identity evidence");
      }
    }
  }
  if (
    (manifest.phase === "committed" || manifest.phase === "finalized") &&
    (completed.length !== manifest.members.length || pending !== null || rollback !== null)
  ) {
    contractError(`${manifest.phase} manifests must have every member completed without a pending or rollback member`);
  }

  if (pending !== null) {
    const pendingMember = manifest.members[completed.length];
    if (
      manifest.phase !== "publishing" ||
      pendingMember === undefined ||
      pendingMember.memberId !== pending.memberId ||
      pendingMember.kind !== pending.kind
    ) {
      contractError("pending member must be the next publishing member after the completed prefix");
    }
    if (pending.kind === "move") {
      if (pending.moveOperation !== undefined) {
        assertMoveOperationFacts(pending.moveOperation, "forward");
      } else {
        const reservationIdentity = pending.reservationIdentity ?? null;
        if (
          pending.state !== "ready" ||
          pending.preIdentity === undefined ||
          pending.postIdentity === undefined ||
          !isMovePostIdentity(pending.postIdentity)
        ) {
          contractError("legacy move manifests require the exact ready state and target identity evidence");
        }
        if (
          !sameFilesystemIdentityEvidence(pending.preIdentity.sourceFile, pending.postIdentity.targetFile) ||
          !sameNullableFilesystemIdentityEvidence(
            pending.preIdentity.sourceDirectory,
            pending.postIdentity.targetDirectory,
          )
        ) {
          contractError("legacy ready move members must preserve source identity evidence at the target");
        }
        if (reservationIdentity !== null) {
          contractError("legacy ready move state must not retain a companion reservation identity");
        }
      }
    } else if (pending.state === "reserved") {
      if (pending.postIdentity !== null) {
        contractError("only write or create members may reserve a pending staged identity");
      }
    } else if (pending.postIdentity === null) {
      contractError("ready pending members must retain expected post-publish identity evidence");
    } else if (!("file" in pending.postIdentity)) {
      contractError("ready pending write and create members require file identity evidence");
    }
  }

  for (const member of manifest.members) {
    const completedMember = completed.includes(member.memberId);
    if (completedMember !== (member.postIdentity !== undefined)) {
      contractError("completed members must retain durable post-publish identity evidence only");
    }
    if (
      member.kind === "write" &&
      member.rollbackRestoredIdentity !== undefined &&
      (manifest.phase !== "rolling-back" || member.postIdentity !== undefined)
    ) {
      contractError("only an already-restored write in a rolling-back manifest may retain rollback identity evidence");
    }
    if (member.kind === "create") {
      if (member.preimageFile !== null) {
        contractError("create members must not own a preimage file");
      }
      continue;
    }

    if (member.preimageFile !== `${member.memberId}.preimage`) {
      contractError("member preimage files must be owned by their member ID");
    }
    if (member.kind === "move") {
      assertMovePaths(member.sourcePath, member.targetPath);
      if (member.expectedSourceByteHash !== member.resultByteHash) {
        contractError("move member result hash must preserve the source hash");
      }
    }
  }
}

function freezePlan(plan: z.infer<typeof transactionPlanSchema>): CortexTreeTransactionPlan {
  return Object.freeze({
    ...plan,
    participantIds: Object.freeze([...plan.participantIds]),
    members: Object.freeze(plan.members.map((member) => Object.freeze({ ...member }) as CortexTreeTransactionMember)),
  });
}

function freezeManifest(manifest: z.infer<typeof manifestSchema>): CortexTreeTransactionManifest {
  const frozen: Record<string, unknown> = {
    ...manifest,
    participantIds: Object.freeze([...manifest.participantIds]),
    completedMemberIds: Object.freeze([...manifest.completedMemberIds]),
    members: Object.freeze(manifest.members.map((member) => Object.freeze({ ...member }))),
  };

  const optionalWalFields: ReadonlyArray<Readonly<{
    readonly name: "pendingMember" | "rollbackPending" | "rollbackPendingMember";
    readonly value: unknown;
  }>> = [
    { name: "pendingMember", value: manifest.pendingMember },
    { name: "rollbackPending", value: manifest.rollbackPending },
    { name: "rollbackPendingMember", value: manifest.rollbackPendingMember },
  ];
  for (const field of optionalWalFields) {
    if (field.value === undefined) {
      Object.defineProperty(frozen, field.name, {
        configurable: false,
        enumerable: false,
        value: null,
        writable: false,
      });
      continue;
    }
    frozen[field.name] = field.value === null ? null : Object.freeze({ ...(field.value as object) });
  }

  return Object.freeze(frozen) as unknown as CortexTreeTransactionManifest;
}

/** Parses a runtime-only transaction plan before any private manifest exists. */
export async function parseCortexTreeTransactionPlan(input: unknown): Promise<CortexTreeTransactionPlan> {
  const parsed = transactionPlanSchema.parse(input);
  await assertPlanFacts(parsed);
  return freezePlan(parsed);
}

/** Returns the SHA-256 of the canonical manifest metadata, excluding the digest field itself. */
export async function calculateCortexTreeTransactionManifestDigest(input: unknown): Promise<string> {
  const parsed = manifestInputSchema.parse(input);
  const { pendingMember, rollbackPending, rollbackPendingMember, ...required } = parsed;
  return sha256Hex(canonicalJson({
    ...required,
    ...(pendingMember === undefined ? {} : { pendingMember }),
    ...(rollbackPending === undefined ? {} : { rollbackPending }),
    ...(rollbackPendingMember === undefined ? {} : { rollbackPendingMember }),
  }));
}

/** Adds a canonical digest to strict private manifest metadata. */
export async function createCortexTreeTransactionManifest(input: unknown): Promise<CortexTreeTransactionManifest> {
  const parsed = manifestInputSchema.parse(input);
  const manifestDigest = await calculateCortexTreeTransactionManifestDigest(parsed);
  return parseCortexTreeTransactionManifest({ ...parsed, manifestDigest });
}

/** Parses and verifies a private manifest without ever accepting note bytes. */
export async function parseCortexTreeTransactionManifest(input: unknown): Promise<CortexTreeTransactionManifest> {
  const parsed = manifestSchema.parse(input);
  assertManifestFacts(parsed);
  const { manifestDigest, ...unsigned } = parsed;
  const expectedDigest = await calculateCortexTreeTransactionManifestDigest(unsigned);
  if (manifestDigest !== expectedDigest) {
    contractError("manifest digest does not match canonical metadata");
  }
  return freezeManifest(parsed);
}
