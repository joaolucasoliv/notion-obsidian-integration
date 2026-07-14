import { describe, expect, it } from "vitest";
import { parseSafeLogEntry } from "./errors";

const RUN_ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";
const INSTALLATION_ID = "0bd79300-8068-4f26-9490-c1a923574d1d";
const HASH = "727315411367e16793c5140eedbe2371b9619a47ce90e2b3e3b3704e2e725adc";

function validEntry() {
  return {
    level: "info",
    event: "run-completed",
    fields: {
      runId: RUN_ID,
      installationId: INSTALLATION_ID,
      hash: HASH,
      mode: "apply",
      outcome: "success",
      reason: "manual",
      errorCode: "invalid-state",
      count: 12,
      durationMs: 250,
      retryable: false,
    },
  };
}

describe("parseSafeLogEntry", () => {
  it("accepts only the bounded shared log vocabulary", () => {
    const input = validEntry();
    const parsed = parseSafeLogEntry(input);

    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.fields)).toBe(true);
    expect(parseSafeLogEntry({ level: "warn", event: "notion-retry" })).toEqual({
      level: "warn",
      event: "notion-retry",
    });
  });

  it.each(["message", "path", "noteBody", "credential", "authorization", "cookie", "pairingCode", "headers"])(
    "rejects unsafe field name %s",
    (field) => {
      const input = validEntry();
      Object.assign(input.fields, { [field]: "redacted" });

      expect(() => parseSafeLogEntry(input)).toThrow(/unrecognized/i);
    },
  );

  it.each([
    ["runId", "provider output"],
    ["hash", "not-a-hash"],
    ["mode", "automatic"],
    ["outcome", "maybe"],
    ["reason", "provider-trigger"],
    ["errorCode", "provider error text"],
  ])("rejects arbitrary string value for %s", (field, value) => {
    const input = validEntry();
    Object.assign(input.fields, { [field]: value });

    expect(() => parseSafeLogEntry(input)).toThrow(/invalid|expected/i);
  });

  it.each([
    ["count", -1],
    ["count", 1_000_001],
    ["durationMs", Number.POSITIVE_INFINITY],
    ["attempt", 1.5],
    ["attempt", 4],
    ["statusCode", 99],
    ["delayMs", 300_001],
  ])("rejects unsafe numeric value for %s", (field, value) => {
    const input = validEntry();
    Object.assign(input.fields, { [field]: value });

    expect(() => parseSafeLogEntry(input)).toThrow(/invalid|expected|too big|too small/i);
  });

  it("rejects unknown top-level fields and event codes", () => {
    expect(() => parseSafeLogEntry({ ...validEntry(), output: "redacted" })).toThrow(/unrecognized/i);
    expect(() => parseSafeLogEntry({ ...validEntry(), event: "provider-message" })).toThrow(/event/i);
  });
});
