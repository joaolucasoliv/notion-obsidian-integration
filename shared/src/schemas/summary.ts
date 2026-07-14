import { z } from "zod";

const timestampSchema = z.string().max(64).datetime({ offset: true });
const summaryCountSchema = z.number().finite().int().min(0).max(1_000_000);

export const bridgeRunSummarySchema = z
  .object({
    mode: z.enum(["preview", "apply"]),
    outcome: z.enum(["success", "noop", "partial", "conflict", "failed", "recovery-required"]),
    planned: summaryCountSchema,
    writes: summaryCountSchema,
    pushed: summaryCountSchema,
    pulled: summaryCountSchema,
    conflicts: summaryCountSchema,
    errors: summaryCountSchema,
    graphUploads: summaryCountSchema,
    startedAt: timestampSchema,
    completedAt: timestampSchema,
  })
  .strict()
  .readonly();

export type ParsedBridgeRunSummary = z.infer<typeof bridgeRunSummarySchema>;

export function parseBridgeRunSummary(input: unknown): ParsedBridgeRunSummary {
  return bridgeRunSummarySchema.parse(input);
}
