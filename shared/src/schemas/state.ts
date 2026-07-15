import { z } from "zod";
import { bridgeRunSummarySchema } from "./summary.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 hash");
const timestampSchema = z.string().datetime({ offset: true });

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

export type ParsedBridgeStateV1 = z.infer<typeof bridgeStateV1Schema>;

export function parseBridgeState(input: unknown): ParsedBridgeStateV1 {
  return bridgeStateV1Schema.parse(input);
}
