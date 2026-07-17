import { z } from "zod";

const uuidSchema = z.uuid();
const canonicalUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "Expected a canonical UUID");
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 hash");
const timestampSchema = z.string().max(64).datetime({ offset: true });
const cortexRootFilePath = "The Cortex.md";
const cortexDirectoryPrefix = "The Cortex/";

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

const cortexRelativePathSchema = relativePathSchema.superRefine((value, context) => {
  if (value !== cortexRootFilePath && !value.startsWith(cortexDirectoryPrefix)) {
    context.addIssue({ code: "custom", message: "Expected a path inside the reserved Cortex root" });
  }
});

const cortexExpectedPostconditionSchema = z
  .object({
    pageId: canonicalUuidSchema.nullable(),
    parentPageId: canonicalUuidSchema.nullable(),
    title: z.string().min(1).max(512).nullable(),
    relativePath: cortexRelativePathSchema.nullable(),
    byteHash: hashSchema.nullable(),
    semanticHash: hashSchema.nullable(),
    structureHash: hashSchema.nullable(),
    editedAt: timestampSchema.nullable(),
  })
  .strict()
  .readonly();

const cortexEffectPayloadSchema = z
  .object({
    rootPageId: canonicalUuidSchema,
    pageId: canonicalUuidSchema.nullable(),
    sourcePath: cortexRelativePathSchema.nullable(),
    targetPath: cortexRelativePathSchema.nullable(),
    expectedPostcondition: cortexExpectedPostconditionSchema,
  })
  .strict()
  .readonly();

const cortexTransactionPayloadSchema = z
  .object({
    rootPageId: canonicalUuidSchema,
    transactionId: canonicalUuidSchema,
    manifestDigest: hashSchema,
    participantIds: z.array(canonicalUuidSchema).min(1).max(5_000),
  })
  .strict()
  .readonly();

const cortexJournalEffectKinds = new Set([
  "create-cortex-page",
  "update-cortex-body",
  "update-cortex-title",
  "move-cortex-page",
  "create-cortex-local",
  "write-cortex-local",
  "move-cortex-subtree",
  "create-cortex-conflict",
  "advance-cortex-state",
]);

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
  "create-cortex-page",
  "update-cortex-body",
  "update-cortex-title",
  "move-cortex-page",
  "create-cortex-local",
  "write-cortex-local",
  "move-cortex-subtree",
  "create-cortex-conflict",
  "advance-cortex-state",
  "commit-cortex-tree-transaction",
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
    cortex: cortexEffectPayloadSchema.nullable().optional(),
    cortexTransaction: cortexTransactionPayloadSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.effectKind === "commit-cortex-tree-transaction") {
      const issue = (path: readonly (string | number)[], message: string) => {
        context.addIssue({ code: "custom", path: [...path], message });
      };
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
          issue([field], "Cortex tree transaction commits must not include single-effect material");
        }
      }
      if (value.cortex !== undefined && value.cortex !== null) {
        issue(["cortex"], "Cortex tree transaction commits must not include single-page Cortex data");
      }
      if (value.cortexTransaction === undefined) {
        issue(["cortexTransaction"], "Cortex tree transaction commits require immutable transaction metadata");
        return;
      }
      const transaction = value.cortexTransaction;
      for (let index = 1; index < transaction.participantIds.length; index += 1) {
        if (transaction.participantIds[index - 1]! >= transaction.participantIds[index]!) {
          issue(["cortexTransaction", "participantIds"], "Cortex transaction participant IDs must be strictly sorted and unique");
          break;
        }
      }
      if (!transaction.participantIds.includes(transaction.rootPageId)) {
        issue(
          ["cortexTransaction", "participantIds"],
          "Cortex transaction participant IDs must include the transaction root page ID",
        );
      }
      return;
    }

    if (value.cortexTransaction !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["cortexTransaction"],
        message: "Only Cortex tree transaction commits may carry transaction metadata",
      });
    }

    if (value.effectKind === "commit-state") {
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
    }

    if (cortexJournalEffectKinds.has(value.effectKind)) {
      if (value.cortex === undefined || value.cortex === null) {
        context.addIssue({
          code: "custom",
          path: ["cortex"],
          message: "Cortex effects require immutable Cortex postcondition data",
        });
        return;
      }

      const cortex = value.cortex;
      const postcondition = cortex.expectedPostcondition;
      const issue = (path: readonly (string | number)[], message: string) => {
        context.addIssue({ code: "custom", path: [...path], message });
      };
      const requirePresent = (candidate: unknown, path: readonly (string | number)[], message: string) => {
        if (candidate === null) issue(path, message);
      };
      const requireAbsent = (candidate: unknown, path: readonly (string | number)[], message: string) => {
        if (candidate !== null) issue(path, message);
      };
      const requireEqual = (
        actual: unknown,
        expected: unknown,
        path: readonly (string | number)[],
        message: string,
      ) => {
        if (actual !== expected) issue(path, message);
      };
      const requireExistingPagePath = (candidate: string | null, path: readonly (string | number)[]) => {
        if (candidate === null || cortex.pageId === null) return;
        if (cortex.pageId === cortex.rootPageId) {
          requireEqual(candidate, cortexRootFilePath, path, "Cortex root page must use The Cortex.md");
        } else if (!candidate.startsWith(cortexDirectoryPrefix)) {
          issue(path, "Cortex descendant page must use a path inside The Cortex/");
        }
      };
      const requireExistingPagePaths = () => {
        requireExistingPagePath(cortex.sourcePath, ["cortex", "sourcePath"]);
        requireExistingPagePath(cortex.targetPath, ["cortex", "targetPath"]);
        requireExistingPagePath(postcondition.relativePath, ["cortex", "expectedPostcondition", "relativePath"]);
      };
      // A root conflict is not a write to the root note: it creates the one
      // deterministic artifact named for that root under its reserved subtree.
      // Keep the root-note path rule intact for every other existing-page
      // effect, while making this distinct artifact identity explicit.
      const requireRootConflictArtifactPaths = () => {
        const expectedPath = `${cortexDirectoryPrefix}.conflicts/${cortex.rootPageId}.conflict.md`;
        requireEqual(cortex.targetPath, expectedPath, ["cortex", "targetPath"], "Cortex root conflict must use its exact conflict artifact path");
        requireEqual(
          postcondition.relativePath,
          expectedPath,
          ["cortex", "expectedPostcondition", "relativePath"],
          "Cortex root conflict must use its exact conflict artifact path",
        );
      };
      const requireNewPagePaths = () => {
        for (const [candidate, path] of [
          [cortex.sourcePath, ["cortex", "sourcePath"]],
          [cortex.targetPath, ["cortex", "targetPath"]],
          [postcondition.relativePath, ["cortex", "expectedPostcondition", "relativePath"]],
        ] as const) {
          if (candidate !== null && !candidate.startsWith(cortexDirectoryPrefix)) {
            issue(path, "New Cortex pages must be created inside The Cortex/");
          }
        }
      };
      const requireEnvelopePath = (localPath: "required" | "absent") => {
        if (localPath === "absent") {
          requireAbsent(value.relativePath, ["relativePath"], "Cortex state advances must not carry a local relativePath");
          return;
        }
        requirePresent(value.relativePath, ["relativePath"], "Cortex effect requires a local relativePath");
        requireEqual(value.relativePath, cortex.targetPath, ["relativePath"], "Cortex relativePath must match targetPath");
        requireEqual(
          value.relativePath,
          postcondition.relativePath,
          ["relativePath"],
          "Cortex relativePath must match the postcondition relativePath",
        );
      };
      const requirePaths = (source: "required" | "absent", target: "root" | "required") => {
        if (source === "required") {
          requirePresent(cortex.sourcePath, ["cortex", "sourcePath"], "Cortex effect requires a sourcePath");
        } else {
          requireAbsent(cortex.sourcePath, ["cortex", "sourcePath"], "Cortex effect must not carry a sourcePath");
        }
        if (target === "root") {
          requireEqual(cortex.targetPath, cortexRootFilePath, ["cortex", "targetPath"], "Cortex state advances target The Cortex.md");
        } else {
          requirePresent(cortex.targetPath, ["cortex", "targetPath"], "Cortex effect requires a targetPath");
        }
      };
      const requirePostcondition = () => {
        requirePresent(postcondition.title, ["cortex", "expectedPostcondition", "title"], "Cortex effect requires a postcondition title");
        requirePresent(
          postcondition.relativePath,
          ["cortex", "expectedPostcondition", "relativePath"],
          "Cortex effect requires a postcondition relativePath",
        );
        requirePresent(
          postcondition.byteHash,
          ["cortex", "expectedPostcondition", "byteHash"],
          "Cortex effect requires a postcondition byteHash",
        );
        requirePresent(
          postcondition.semanticHash,
          ["cortex", "expectedPostcondition", "semanticHash"],
          "Cortex effect requires a postcondition semanticHash",
        );
        requirePresent(
          postcondition.structureHash,
          ["cortex", "expectedPostcondition", "structureHash"],
          "Cortex effect requires a postcondition structureHash",
        );
        requirePresent(
          postcondition.editedAt,
          ["cortex", "expectedPostcondition", "editedAt"],
          "Cortex effect requires a postcondition editedAt",
        );
        requireEqual(
          postcondition.relativePath,
          cortex.targetPath,
          ["cortex", "expectedPostcondition", "relativePath"],
          "Cortex postcondition relativePath must match targetPath",
        );
        requireEqual(
          postcondition.byteHash,
          value.resultByteHash,
          ["cortex", "expectedPostcondition", "byteHash"],
          "Cortex postcondition byteHash must match resultByteHash",
        );
        requireEqual(
          postcondition.semanticHash,
          value.resultSemanticHash,
          ["cortex", "expectedPostcondition", "semanticHash"],
          "Cortex postcondition semanticHash must match resultSemanticHash",
        );
      };
      const requireHashesAndRevision = (expectedByteHash: "required" | "absent") => {
        if (expectedByteHash === "required") {
          requirePresent(value.expectedByteHash, ["expectedByteHash"], "Cortex effect requires an expectedByteHash");
        } else {
          requireAbsent(value.expectedByteHash, ["expectedByteHash"], "Cortex create effect must expect an absent local file");
        }
        requirePresent(value.expectedSemanticHash, ["expectedSemanticHash"], "Cortex effect requires an expectedSemanticHash");
        requirePresent(value.resultByteHash, ["resultByteHash"], "Cortex effect requires a resultByteHash");
        requirePresent(value.resultSemanticHash, ["resultSemanticHash"], "Cortex effect requires a resultSemanticHash");
        requirePresent(
          value.expectedRemoteEditedAt,
          ["expectedRemoteEditedAt"],
          "Cortex effect requires an expected remote revision",
        );
      };
      const requireExistingPage = () => {
        requirePresent(cortex.pageId, ["cortex", "pageId"], "Cortex effect requires an immutable pageId");
        requirePresent(value.remoteId, ["remoteId"], "Cortex effect requires an immutable remoteId");
        requireEqual(value.remoteId, cortex.pageId, ["remoteId"], "Cortex remoteId must match cortex pageId");
        requireEqual(
          postcondition.pageId,
          cortex.pageId,
          ["cortex", "expectedPostcondition", "pageId"],
          "Cortex postcondition pageId must match cortex pageId",
        );
      };

      switch (value.effectKind) {
        case "create-cortex-page":
          // A new remote page has no Notion page ID before it is created. Its
          // allocation ID is the immutable recovery identity until completion.
          requireAbsent(cortex.pageId, ["cortex", "pageId"], "Cortex page creation must not predeclare a pageId");
          requireAbsent(value.remoteId, ["remoteId"], "Cortex page creation must not predeclare a remoteId");
          requireAbsent(
            postcondition.pageId,
            ["cortex", "expectedPostcondition", "pageId"],
            "Cortex page creation must not predeclare a postcondition pageId",
          );
          requirePresent(value.allocationId, ["allocationId"], "Cortex page creation requires an allocationId");
          requirePresent(
            postcondition.parentPageId,
            ["cortex", "expectedPostcondition", "parentPageId"],
            "Cortex page creation requires a postcondition parentPageId",
          );
          requirePaths("required", "required");
          requireNewPagePaths();
          requireEnvelopePath("required");
          requireEqual(cortex.sourcePath, cortex.targetPath, ["cortex", "targetPath"], "Cortex page creation must preserve its local path");
          requireHashesAndRevision("required");
          requirePostcondition();
          break;
        case "update-cortex-body":
          requireExistingPage();
          requireExistingPagePaths();
          requirePaths("required", "required");
          requireEnvelopePath("required");
          requireEqual(cortex.sourcePath, cortex.targetPath, ["cortex", "targetPath"], "Cortex body updates must preserve their local path");
          requireHashesAndRevision("required");
          requirePostcondition();
          break;
        case "update-cortex-title":
          requireExistingPage();
          requireExistingPagePaths();
          requirePaths("required", "required");
          requireEnvelopePath("required");
          requireHashesAndRevision("required");
          requirePostcondition();
          break;
        case "move-cortex-page":
          requireExistingPage();
          requireExistingPagePaths();
          requirePaths("required", "required");
          requireEnvelopePath("required");
          requirePresent(
            postcondition.parentPageId,
            ["cortex", "expectedPostcondition", "parentPageId"],
            "Cortex page moves require a postcondition parentPageId",
          );
          requireHashesAndRevision("required");
          requirePostcondition();
          break;
        case "create-cortex-local":
          requireExistingPage();
          requireExistingPagePaths();
          requirePaths("absent", "required");
          requireEnvelopePath("required");
          requireHashesAndRevision("absent");
          requirePostcondition();
          break;
        case "write-cortex-local":
          requireExistingPage();
          requireExistingPagePaths();
          requirePaths("required", "required");
          requireEnvelopePath("required");
          requireEqual(cortex.sourcePath, cortex.targetPath, ["cortex", "targetPath"], "Cortex local writes must preserve their local path");
          requireHashesAndRevision("required");
          requirePostcondition();
          break;
        case "move-cortex-subtree":
          requireExistingPage();
          requireExistingPagePaths();
          requirePaths("required", "required");
          requireEnvelopePath("required");
          if (cortex.sourcePath === cortex.targetPath) {
            issue(["cortex", "targetPath"], "Cortex subtree moves require a distinct targetPath");
          }
          requireHashesAndRevision("required");
          requirePostcondition();
          break;
        case "create-cortex-conflict":
          requireExistingPage();
          if (cortex.pageId === cortex.rootPageId) requireRootConflictArtifactPaths();
          else requireExistingPagePaths();
          requirePaths("absent", "required");
          requireEnvelopePath("required");
          requireHashesAndRevision("absent");
          requirePostcondition();
          break;
        case "advance-cortex-state":
          requireExistingPage();
          requireEqual(cortex.pageId, cortex.rootPageId, ["cortex", "pageId"], "Cortex state advances require the root pageId");
          requireExistingPagePaths();
          requirePaths("absent", "root");
          requireEnvelopePath("absent");
          requireAbsent(
            postcondition.parentPageId,
            ["cortex", "expectedPostcondition", "parentPageId"],
            "Cortex root state postcondition must not have a parentPageId",
          );
          requireHashesAndRevision("required");
          requirePostcondition();
          break;
        default:
          break;
      }
      return;
    }

    if (value.cortex !== undefined && value.cortex !== null) {
      context.addIssue({
        code: "custom",
        path: ["cortex"],
        message: "Legacy effects must not carry Cortex effect data",
      });
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
export type CortexJournalExpectedPostcondition = z.infer<typeof cortexExpectedPostconditionSchema>;
export type CortexJournalEffectPayload = z.infer<typeof cortexEffectPayloadSchema>;
export type CortexTransactionJournalEffectPayload = z.infer<typeof cortexTransactionPayloadSchema>;
export type JournalIntentV1 = z.infer<typeof journalIntentV1Schema>;
export type JournalCompletionV1 = z.infer<typeof journalCompletionV1Schema>;

export function parseJournalIntent(input: unknown): JournalIntentV1 {
  return journalIntentV1Schema.parse(input);
}

export function parseJournalCompletion(input: unknown): JournalCompletionV1 {
  return journalCompletionV1Schema.parse(input);
}
