import { z } from "zod";

const uuidSchema = z.uuid();
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 hash");
const timestampSchema = z.string().max(64).datetime({ offset: true });

const relativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .superRefine((value, context) => {
    const segments = value.split("/");
    const unsafe =
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      value.includes("\\") ||
      value.includes("\0") ||
      /[\r\n]/.test(value) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..");

    if (unsafe) {
      context.addIssue({ code: "custom", message: "Expected a normalized vault-relative path" });
    }
  });

export const journalEffectKindSchema = z.enum([
  "commit-state",
  "initialize-pair",
  "create-notion-page",
  "update-notion-body-exact",
  "update-notion-properties",
  "write-local",
  "create-conflict",
  "set-notion-status",
  "register-relay-page",
  "unregister-relay-page",
]);

export const journalIntentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: uuidSchema,
    installationId: uuidSchema,
    effectKind: journalEffectKindSchema,
    relativePath: relativePathSchema.nullable(),
    remoteId: uuidSchema.nullable(),
    allocationId: hashSchema.nullable(),
    expectedByteHash: hashSchema.nullable(),
    expectedSemanticHash: hashSchema.nullable(),
    resultByteHash: hashSchema.nullable(),
    resultSemanticHash: hashSchema.nullable(),
    expectedRemoteEditedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.effectKind !== "commit-state") return;
    for (const field of [
      "relativePath",
      "remoteId",
      "allocationId",
      "expectedByteHash",
      "expectedSemanticHash",
      "resultByteHash",
      "resultSemanticHash",
      "expectedRemoteEditedAt",
    ] as const) {
      if (value[field] !== null) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "commit-state must not include effect material",
        });
      }
    }
  })
  .readonly();

export const journalCompletionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    resultByteHash: hashSchema.nullable(),
    resultSemanticHash: hashSchema.nullable(),
    resultRemoteId: uuidSchema.nullable(),
    allocatedBridgeId: uuidSchema.nullable(),
    observedRemoteEditedAt: timestampSchema.nullable(),
    completedAt: timestampSchema,
  })
  .strict()
  .readonly();

export type JournalEffectKind = z.infer<typeof journalEffectKindSchema>;
export type JournalIntentV1 = z.infer<typeof journalIntentV1Schema>;
export type JournalCompletionV1 = z.infer<typeof journalCompletionV1Schema>;

export function parseJournalIntent(input: unknown): JournalIntentV1 {
  return journalIntentV1Schema.parse(input);
}

export function parseJournalCompletion(input: unknown): JournalCompletionV1 {
  return journalCompletionV1Schema.parse(input);
}
