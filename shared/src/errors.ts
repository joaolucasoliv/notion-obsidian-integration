import { z } from "zod";

export const SAFE_ERROR_CODES = [
  "invalid-config",
  "invalid-state",
  "unsafe-path",
  "credential-unavailable",
  "active-lock",
  "recovery-required",
  "authentication-failed",
  "authorization-failed",
  "not-found",
  "rate-limited",
  "network-failed",
  "timeout",
  "request-too-large",
  "response-too-large",
  "invalid-response",
  "revision-race",
  "unsupported-content",
  "identity-collision",
  "conversion-failed",
  "internal-error",
] as const;

export type SafeErrorCode = (typeof SAFE_ERROR_CODES)[number];

export interface SafeError {
  readonly code: SafeErrorCode;
  readonly retryable: boolean;
}

export const SAFE_LOG_EVENT_CODES = [
  "run-started",
  "run-completed",
  "run-failed",
  "pair-conflict",
  "pair-error",
  "recovery-required",
  "credential-unavailable",
  "notion-retry",
] as const;

export type SafeLogEventCode = (typeof SAFE_LOG_EVENT_CODES)[number];

const uuidSchema = z.uuid();
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 hash");
const countSchema = z.number().finite().int().min(0).max(1_000_000);

export const safeLogFieldsSchema = z
  .object({
    runId: uuidSchema.optional(),
    installationId: uuidSchema.optional(),
    bridgeId: uuidSchema.optional(),
    journalId: uuidSchema.optional(),
    remoteId: uuidSchema.optional(),
    hash: hashSchema.optional(),
    expectedHash: hashSchema.optional(),
    resultHash: hashSchema.optional(),
    mode: z.enum(["preview", "apply"]).optional(),
    outcome: z.enum(["success", "noop", "partial", "conflict", "failed", "recovery-required"]).optional(),
    reason: z.enum(["manual", "obsidian-event", "schedule", "reconciliation"]).optional(),
    errorCode: z.enum(SAFE_ERROR_CODES).optional(),
    slot: z.enum(["notion-token", "relay-token", "graph-key"]).optional(),
    pairStatus: z.enum(["synced", "conflict", "detached", "missing-local", "missing-notion", "error"]).optional(),
    count: countSchema.optional(),
    planned: countSchema.optional(),
    writes: countSchema.optional(),
    pushed: countSchema.optional(),
    pulled: countSchema.optional(),
    conflicts: countSchema.optional(),
    errors: countSchema.optional(),
    graphUploads: countSchema.optional(),
    durationMs: z.number().finite().int().min(0).max(86_400_000).optional(),
    attempt: z.number().finite().int().min(1).max(3).optional(),
    statusCode: z.number().finite().int().min(100).max(599).optional(),
    delayMs: z.number().finite().int().min(0).max(300_000).optional(),
    sequence: z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    retryable: z.boolean().optional(),
  })
  .strict()
  .readonly();

export const safeLogEntrySchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]),
    event: z.enum(SAFE_LOG_EVENT_CODES),
    fields: safeLogFieldsSchema.optional(),
  })
  .strict()
  .readonly();

export type SafeLogLevel = z.infer<typeof safeLogEntrySchema>["level"];
export type SafeLogFields = z.infer<typeof safeLogFieldsSchema>;
export type SafeLogEntry = z.infer<typeof safeLogEntrySchema>;

export function parseSafeLogEntry(input: unknown): SafeLogEntry {
  return safeLogEntrySchema.parse(input);
}
