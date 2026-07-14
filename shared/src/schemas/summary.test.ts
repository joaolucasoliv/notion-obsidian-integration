import { describe, expect, it } from "vitest";
import { parseBridgeRunSummary } from "./summary";

const TIMESTAMP = "2026-07-14T12:34:56.000Z";

function validSummary() {
  return {
    mode: "apply",
    outcome: "success",
    planned: 1,
    writes: 1,
    pushed: 1,
    pulled: 0,
    conflicts: 0,
    errors: 0,
    graphUploads: 0,
    startedAt: TIMESTAMP,
    completedAt: TIMESTAMP,
  };
}

describe("parseBridgeRunSummary", () => {
  it("parses the exact readonly run-summary contract", () => {
    const input = validSummary();
    const parsed = parseBridgeRunSummary(input);

    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects unknown keys, modes, outcomes, and malformed timestamps", () => {
    const overlongTimestamp = `2026-07-14T12:34:56.${"1".repeat(1_000)}Z`;

    expect(() => parseBridgeRunSummary({ ...validSummary(), output: "redacted" })).toThrow(/unrecognized/i);
    expect(() => parseBridgeRunSummary({ ...validSummary(), mode: "automatic" })).toThrow(/mode/i);
    expect(() => parseBridgeRunSummary({ ...validSummary(), outcome: "maybe" })).toThrow(/outcome/i);
    expect(() => parseBridgeRunSummary({ ...validSummary(), completedAt: "soon" })).toThrow(/completedAt/i);
    expect(() => parseBridgeRunSummary({ ...validSummary(), completedAt: overlongTimestamp })).toThrow(/completedAt/i);
  });

  it.each([-1, 1.5, 1_000_001, Number.POSITIVE_INFINITY])("rejects unsafe count %s", (writes) => {
    expect(() => parseBridgeRunSummary({ ...validSummary(), writes })).toThrow(/writes/i);
  });
});
