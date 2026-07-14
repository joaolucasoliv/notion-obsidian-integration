import { describe, expect, it } from "vitest";
import { parseSafeLogEntry } from "./errors";

const RUN_ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";
const INSTALLATION_ID = "0bd79300-8068-4f26-9490-c1a923574d1d";
const BRIDGE_ID = "f12a399a-2b99-4d1f-8d85-92102db62535";
const JOURNAL_ID = "87288d2f-35cc-45b2-9eae-ad366ea19ccf";
const REMOTE_ID = "8de72cbd-b222-4738-8871-c2fe9a3b0f06";
const HASH = "727315411367e16793c5140eedbe2371b9619a47ce90e2b3e3b3704e2e725adc";

const validEntries = [
  {
    level: "info",
    event: "run-started",
    fields: { runId: RUN_ID, installationId: INSTALLATION_ID, mode: "apply", reason: "manual" },
  },
  {
    level: "info",
    event: "run-completed",
    fields: {
      runId: RUN_ID,
      installationId: INSTALLATION_ID,
      mode: "apply",
      outcome: "success",
      planned: 3,
      writes: 2,
      pushed: 1,
      pulled: 1,
      conflicts: 0,
      errors: 0,
      graphUploads: 1,
      durationMs: 250,
    },
  },
  {
    level: "error",
    event: "run-failed",
    fields: {
      runId: RUN_ID,
      installationId: INSTALLATION_ID,
      mode: "apply",
      reason: "reconciliation",
      outcome: "failed",
      errorCode: "invalid-state",
      retryable: false,
      durationMs: 250,
    },
  },
  {
    level: "warn",
    event: "pair-conflict",
    fields: {
      runId: RUN_ID,
      installationId: INSTALLATION_ID,
      bridgeId: BRIDGE_ID,
      remoteId: REMOTE_ID,
      pairStatus: "conflict",
      expectedHash: HASH,
      resultHash: HASH,
    },
  },
  {
    level: "error",
    event: "pair-error",
    fields: {
      runId: RUN_ID,
      installationId: INSTALLATION_ID,
      bridgeId: BRIDGE_ID,
      remoteId: REMOTE_ID,
      pairStatus: "error",
      errorCode: "conversion-failed",
      retryable: false,
    },
  },
  {
    level: "error",
    event: "recovery-required",
    fields: {
      runId: RUN_ID,
      installationId: INSTALLATION_ID,
      journalId: JOURNAL_ID,
      bridgeId: BRIDGE_ID,
      errorCode: "recovery-required",
      retryable: false,
    },
  },
  {
    level: "error",
    event: "credential-unavailable",
    fields: {
      runId: RUN_ID,
      installationId: INSTALLATION_ID,
      slot: "notion-token",
      errorCode: "credential-unavailable",
      retryable: true,
    },
  },
  {
    level: "warn",
    event: "notion-retry",
    fields: {
      runId: RUN_ID,
      installationId: INSTALLATION_ID,
      remoteId: REMOTE_ID,
      attempt: 2,
      statusCode: 429,
      delayMs: 1_000,
      errorCode: "rate-limited",
      retryable: true,
    },
  },
] as const;

function entryFor(event: (typeof validEntries)[number]["event"]) {
  const entry = validEntries.find((candidate) => candidate.event === event);

  if (!entry) {
    throw new Error(`Missing test fixture for ${event}`);
  }

  return structuredClone(entry);
}

describe("parseSafeLogEntry", () => {
  it.each(validEntries)("accepts and freezes the bounded $event vocabulary", (input) => {
    const parsed = parseSafeLogEntry(input);

    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.fields)).toBe(true);
  });

  it("accepts an event without a fields object", () => {
    expect(parseSafeLogEntry({ level: "warn", event: "notion-retry" })).toEqual({
      level: "warn",
      event: "notion-retry",
    });
  });

  it.each(validEntries.map(({ event }) => event))("accepts empty optional fields for %s", (event) => {
    const parsed = parseSafeLogEntry({ level: "debug", event, fields: {} });

    expect(parsed.fields).toEqual({});
    expect(Object.isFrozen(parsed.fields)).toBe(true);
  });

  it.each([
    ["credential-unavailable", { outcome: "failed" }],
    ["credential-unavailable", { statusCode: 401 }],
    ["notion-retry", { slot: "notion-token" }],
    ["run-completed", { journalId: JOURNAL_ID }],
    ["pair-conflict", { planned: 1 }],
    ["pair-conflict", { writes: 1 }],
  ] as const)("rejects fields from another event on %s", (event, extraFields) => {
    const input = entryFor(event);
    Object.assign(input.fields, extraFields);

    expect(() => parseSafeLogEntry(input)).toThrow(/unrecognized/i);
  });

  it.each([
    "message",
    "path",
    "body",
    "noteBody",
    "providerText",
    "provider-text",
    "credential",
    "authorization",
    "cookie",
    "pairingCode",
    "headers",
  ])(
    "rejects unsafe field name %s",
    (field) => {
      const input = entryFor("run-completed");
      Object.assign(input.fields, { [field]: "redacted" });

      expect(() => parseSafeLogEntry(input)).toThrow(/unrecognized/i);
    },
  );

  it.each([
    ["run-started", "runId", "provider output"],
    ["pair-conflict", "expectedHash", "not-a-hash"],
    ["run-started", "mode", "automatic"],
    ["run-completed", "outcome", "maybe"],
    ["run-started", "reason", "provider-trigger"],
    ["run-failed", "errorCode", "provider error text"],
  ] as const)("rejects arbitrary string value for %s.%s", (event, field, value) => {
    const input = entryFor(event);
    Object.assign(input.fields, { [field]: value });

    expect(() => parseSafeLogEntry(input)).toThrow(/invalid|expected/i);
  });

  it.each([
    ["run-completed", "writes", -1],
    ["run-completed", "writes", 1_000_001],
    ["run-completed", "durationMs", Number.POSITIVE_INFINITY],
    ["notion-retry", "attempt", 1.5],
    ["notion-retry", "attempt", 4],
    ["notion-retry", "statusCode", 99],
    ["notion-retry", "delayMs", 300_001],
  ] as const)("rejects unsafe numeric value for %s.%s", (event, field, value) => {
    const input = entryFor(event);
    Object.assign(input.fields, { [field]: value });

    expect(() => parseSafeLogEntry(input)).toThrow(/invalid|expected|too big|too small/i);
  });

  it("rejects unknown top-level fields and event codes", () => {
    expect(() => parseSafeLogEntry({ ...entryFor("run-completed"), output: "redacted" })).toThrow(/unrecognized/i);
    expect(() => parseSafeLogEntry({ ...entryFor("run-completed"), event: "provider-message" })).toThrow(/event/i);
  });
});
