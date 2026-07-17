import { z } from "zod";
import type { BridgeStateV1 } from "../contracts/core.ts";
import { bridgeRunSummarySchema } from "./summary.ts";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 hash");
const timestampSchema = z.string().datetime({ offset: true });
const canonicalUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "Expected a canonical UUID");

const safeRelativePathSchema = z
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

export const pairStatusSchema = z.enum([
  "synced",
  "conflict",
  "detached",
  "missing-local",
  "missing-notion",
  "error",
]);

export const pairStateV1Schema = z
  .object({
    bridgeId: z.uuid(),
    localPath: z.string().min(1),
    notionPageId: z.uuid(),
    status: pairStatusSchema,
    lastLocalSemanticHash: sha256Schema,
    lastNotionSemanticHash: sha256Schema,
    lastCommonSemanticHash: sha256Schema,
    lastCommonLocalByteHash: sha256Schema,
    lastNotionEditedAt: timestampSchema,
    lastSyncedAt: timestampSchema,
  })
  .strict()
  .readonly();

export const graphPublishStateV1Schema = z
  .object({
    projectionHash: sha256Schema.nullable(),
    graphId: z.string().min(1),
    keyId: z.string().min(1),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lastPublishedAt: timestampSchema.nullable(),
  })
  .strict()
  .readonly();

export const bridgeStateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    installationId: z.uuid(),
    pairs: z.record(z.uuid(), pairStateV1Schema).readonly(),
    graph: graphPublishStateV1Schema.nullable(),
    lastFullReconciliationAt: timestampSchema.nullable(),
    lastRun: bridgeRunSummarySchema.nullable(),
  })
  .strict()
  .readonly();

export const cortexPageStatusSchema = z.enum([
  "synced",
  "conflict",
  "missing-local",
  "missing-notion",
  "attention",
  "error",
]);

export const cortexPageStateV1Schema = z
  .object({
    pageId: canonicalUuidSchema,
    parentPageId: canonicalUuidSchema.nullable(),
    rootPageId: canonicalUuidSchema,
    localPath: safeRelativePathSchema,
    title: z.string().min(1).max(512),
    status: cortexPageStatusSchema,
    lastLocalSemanticHash: sha256Schema,
    lastNotionSemanticHash: sha256Schema,
    lastCommonSemanticHash: sha256Schema,
    lastCommonStructureHash: sha256Schema,
    lastCommonLocalByteHash: sha256Schema,
    lastNotionEditedAt: timestampSchema,
    lastSyncedAt: timestampSchema,
    lastSeenTraversalId: canonicalUuidSchema,
  })
  .strict()
  .readonly();

export const cortexTreeStateV1Schema = z
  .object({
    rootPageId: canonicalUuidSchema,
    rootFilePath: z.literal("The Cortex.md"),
    rootDirectoryPath: z.literal("The Cortex"),
    pages: z.record(canonicalUuidSchema, cortexPageStateV1Schema).readonly(),
    lastSuccessfulTraversalId: canonicalUuidSchema.nullable(),
  })
  .strict()
  .superRefine((tree, context) => {
    const root = tree.pages[tree.rootPageId];
    if (root === undefined) {
      context.addIssue({
        code: "custom",
        path: ["pages", tree.rootPageId],
        message: "Cortex state must include the configured root page",
      });
    }

    const seenPageIds = new Set<string>();
    for (const [key, page] of Object.entries(tree.pages)) {
      if (key !== page.pageId) {
        context.addIssue({
          code: "custom",
          path: ["pages", key, "pageId"],
          message: "Cortex page-map key must equal pageId",
        });
      }
      if (seenPageIds.has(page.pageId)) {
        context.addIssue({
          code: "custom",
          path: ["pages", key, "pageId"],
          message: "Cortex pageId must be unique",
        });
      }
      seenPageIds.add(page.pageId);

      if (page.rootPageId !== tree.rootPageId) {
        context.addIssue({
          code: "custom",
          path: ["pages", key, "rootPageId"],
          message: "Cortex page rootPageId must match the tree root",
        });
      }

      if (page.pageId === tree.rootPageId) {
        if (page.parentPageId !== null) {
          context.addIssue({
            code: "custom",
            path: ["pages", key, "parentPageId"],
            message: "Cortex root page parentPageId must be null",
          });
        }
        if (page.localPath !== tree.rootFilePath) {
          context.addIssue({
            code: "custom",
            path: ["pages", key, "localPath"],
            message: "Cortex root page localPath must match rootFilePath",
          });
        }
        continue;
      }

      if (page.parentPageId === null || tree.pages[page.parentPageId] === undefined) {
        context.addIssue({
          code: "custom",
          path: ["pages", key, "parentPageId"],
          message: "Cortex descendant must reference a known parent page",
        });
      }
      if (!page.localPath.startsWith(`${tree.rootDirectoryPath}/`)) {
        context.addIssue({
          code: "custom",
          path: ["pages", key, "localPath"],
          message: "Cortex descendant localPath must be inside rootDirectoryPath",
        });
      }
    }
  })
  .readonly();

export const bridgeStateV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    installationId: z.uuid(),
    pairs: z.record(z.uuid(), pairStateV1Schema).readonly(),
    graph: graphPublishStateV1Schema.nullable(),
    lastFullReconciliationAt: timestampSchema.nullable(),
    lastRun: bridgeRunSummarySchema.nullable(),
    cortex: cortexTreeStateV1Schema.nullable(),
  })
  .strict()
  .readonly();

export type ParsedLegacyBridgeStateV1 = z.infer<typeof bridgeStateV1Schema>;
export type ParsedBridgeStateV2 = z.infer<typeof bridgeStateV2Schema>;
/**
 * Compatibility facade for the unchanged direct-pair runtime. The parser
 * always returns a V2 value at runtime; this alias lets that runtime preserve
 * its isolated pair behavior until Cortex orchestration is added.
 */
export type ParsedBridgeStateV1 = BridgeStateV1;

export function parseBridgeStateV2(input: unknown): ParsedBridgeStateV2 {
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    (input as { schemaVersion?: unknown }).schemaVersion === 1
  ) {
    const legacy = bridgeStateV1Schema.parse(input);
    return bridgeStateV2Schema.parse({ ...legacy, schemaVersion: 2, cortex: null });
  }
  return bridgeStateV2Schema.parse(input);
}

export function parseBridgeState(input: unknown): ParsedBridgeStateV1 {
  return parseBridgeStateV2(input) as unknown as ParsedBridgeStateV1;
}
