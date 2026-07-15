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
const durationMsSchema = z.number().finite().int().min(0).max(86_400_000);
const modeSchema = z.enum(["preview", "apply"]);
const outcomeSchema = z.enum(["success", "noop", "partial", "conflict", "failed", "recovery-required"]);
const reasonSchema = z.enum(["manual", "obsidian-event", "schedule", "reconciliation"]);
const errorCodeSchema = z.enum(SAFE_ERROR_CODES);
const pairStatusSchema = z.enum(["synced", "conflict", "detached", "missing-local", "missing-notion", "error"]);
const levelSchema = z.enum(["debug", "info", "warn", "error"]);

const runStartedFieldsSchema = z
  .object({
    runId: uuidSchema.optional(),
    installationId: uuidSchema.optional(),
    mode: modeSchema.optional(),
    reason: reasonSchema.optional(),
  })
  .strict()
  .readonly();

const runCompletedFieldsSchema = z
  .object({
    runId: uuidSchema.optional(),
    installationId: uuidSchema.optional(),
    mode: modeSchema.optional(),
    outcome: outcomeSchema.optional(),
    planned: countSchema.optional(),
    writes: countSchema.optional(),
    pushed: countSchema.optional(),
    pulled: countSchema.optional(),
    conflicts: countSchema.optional(),
    errors: countSchema.optional(),
    graphUploads: countSchema.optional(),
    durationMs: durationMsSchema.optional(),
  })
  .strict()
  .readonly();

const runFailedFieldsSchema = z
  .object({
    runId: uuidSchema.optional(),
    installationId: uuidSchema.optional(),
    mode: modeSchema.optional(),
    reason: reasonSchema.optional(),
    outcome: outcomeSchema.optional(),
    errorCode: errorCodeSchema.optional(),
    retryable: z.boolean().optional(),
    durationMs: durationMsSchema.optional(),
  })
  .strict()
  .readonly();

const pairConflictFieldsSchema = z
  .object({
    runId: uuidSchema.optional(),
    installationId: uuidSchema.optional(),
    bridgeId: uuidSchema.optional(),
    remoteId: uuidSchema.optional(),
    pairStatus: pairStatusSchema.optional(),
    expectedHash: hashSchema.optional(),
    resultHash: hashSchema.optional(),
  })
  .strict()
  .readonly();

const pairErrorFieldsSchema = z
  .object({
    runId: uuidSchema.optional(),
    installationId: uuidSchema.optional(),
    bridgeId: uuidSchema.optional(),
    remoteId: uuidSchema.optional(),
    pairStatus: pairStatusSchema.optional(),
    errorCode: errorCodeSchema.optional(),
    retryable: z.boolean().optional(),
  })
  .strict()
  .readonly();

const recoveryRequiredFieldsSchema = z
  .object({
    runId: uuidSchema.optional(),
    installationId: uuidSchema.optional(),
    journalId: uuidSchema.optional(),
    bridgeId: uuidSchema.optional(),
    errorCode: errorCodeSchema.optional(),
    retryable: z.boolean().optional(),
  })
  .strict()
  .readonly();

const credentialUnavailableFieldsSchema = z
  .object({
    runId: uuidSchema.optional(),
    installationId: uuidSchema.optional(),
    slot: z.enum(["notion-token", "relay-token", "relay-token-pending", "graph-key"]).optional(),
    errorCode: errorCodeSchema.optional(),
    retryable: z.boolean().optional(),
  })
  .strict()
  .readonly();

const notionRetryFieldsSchema = z
  .object({
    runId: uuidSchema.optional(),
    installationId: uuidSchema.optional(),
    remoteId: uuidSchema.optional(),
    attempt: z.number().finite().int().min(1).max(3).optional(),
    statusCode: z.number().finite().int().min(100).max(599).optional(),
    delayMs: z.number().finite().int().min(0).max(300_000).optional(),
    errorCode: errorCodeSchema.optional(),
    retryable: z.boolean().optional(),
  })
  .strict()
  .readonly();

export const safeLogEntrySchema = z
  .discriminatedUnion("event", [
    z.object({ level: levelSchema, event: z.literal("run-started"), fields: runStartedFieldsSchema.optional() }).strict(),
    z
      .object({ level: levelSchema, event: z.literal("run-completed"), fields: runCompletedFieldsSchema.optional() })
      .strict(),
    z.object({ level: levelSchema, event: z.literal("run-failed"), fields: runFailedFieldsSchema.optional() }).strict(),
    z.object({ level: levelSchema, event: z.literal("pair-conflict"), fields: pairConflictFieldsSchema.optional() }).strict(),
    z.object({ level: levelSchema, event: z.literal("pair-error"), fields: pairErrorFieldsSchema.optional() }).strict(),
    z
      .object({ level: levelSchema, event: z.literal("recovery-required"), fields: recoveryRequiredFieldsSchema.optional() })
      .strict(),
    z
      .object({
        level: levelSchema,
        event: z.literal("credential-unavailable"),
        fields: credentialUnavailableFieldsSchema.optional(),
      })
      .strict(),
    z.object({ level: levelSchema, event: z.literal("notion-retry"), fields: notionRetryFieldsSchema.optional() }).strict(),
  ])
  .readonly();

export type SafeLogLevel = z.infer<typeof safeLogEntrySchema>["level"];
export type SafeLogEntry = z.infer<typeof safeLogEntrySchema>;
export type SafeLogFields = NonNullable<SafeLogEntry["fields"]>;

export function parseSafeLogEntry(input: unknown): SafeLogEntry {
  return safeLogEntrySchema.parse(input);
}
