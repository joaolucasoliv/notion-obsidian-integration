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
export type SafeLogLevel = "debug" | "info" | "warn" | "error";
export type SafeLogValue = string | number | boolean | null;

export interface SafeLogEntry {
  readonly level: SafeLogLevel;
  readonly event: SafeLogEventCode;
  readonly fields?: Readonly<Record<string, SafeLogValue>>;
}
