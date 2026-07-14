import { describe, expect, it } from "vitest";
import { parseJournalCompletion, parseJournalIntent } from "./journal";

const JOURNAL_ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";
const INSTALLATION_ID = "0bd79300-8068-4f26-9490-c1a923574d1d";
const REMOTE_ID = "59833787-2cf9-4fdf-8782-e53db20768a5";
const BRIDGE_ID = "81d1679b-09ef-42bc-8fe1-60c2a6ff1685";
const HASH = "727315411367e16793c5140eedbe2371b9619a47ce90e2b3e3b3704e2e725adc";
const TIMESTAMP = "2026-07-14T12:34:56.000Z";

function validIntent() {
  return {
    schemaVersion: 1,
    id: JOURNAL_ID,
    installationId: INSTALLATION_ID,
    effectKind: "write-local",
    relativePath: "Notes/Bridge.md",
    remoteId: REMOTE_ID,
    allocationId: HASH,
    expectedByteHash: HASH,
    expectedSemanticHash: HASH,
    expectedRemoteEditedAt: TIMESTAMP,
    createdAt: TIMESTAMP,
  };
}

function validCompletion() {
  return {
    schemaVersion: 1,
    resultByteHash: HASH,
    resultSemanticHash: HASH,
    resultRemoteId: REMOTE_ID,
    allocatedBridgeId: BRIDGE_ID,
    observedRemoteEditedAt: TIMESTAMP,
    completedAt: TIMESTAMP,
  };
}

describe("journal schemas", () => {
  it("parses strict readonly intent and completion metadata", () => {
    const intent = parseJournalIntent(validIntent());
    const completion = parseJournalCompletion(validCompletion());

    expect(intent).toEqual(validIntent());
    expect(completion).toEqual(validCompletion());
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(completion)).toBe(true);
  });

  it.each(["content", "markdown", "bodyMarkdown", "credential", "headers"])(
    "rejects journal payload field %s",
    (field) => {
      expect(() => parseJournalIntent({ ...validIntent(), [field]: "redacted" })).toThrow(/unrecognized/i);
      expect(() => parseJournalCompletion({ ...validCompletion(), [field]: "redacted" })).toThrow(/unrecognized/i);
    },
  );

  it.each([
    "/absolute.md",
    "C:/Windows/System32/x.md",
    "C:relative.md",
    "z:relative.md",
    "../outside.md",
    "Notes/\0bad.md",
    "Notes/line\nbreak.md",
    "x".repeat(1_025),
  ])(
    "rejects unsafe or overlong journal path %s",
    (relativePath) => {
      expect(() => parseJournalIntent({ ...validIntent(), relativePath })).toThrow(/relativePath/i);
    },
  );

  it("rejects unknown versions, effects, IDs, hashes, and timestamps", () => {
    const overlongTimestamp = `2026-07-14T12:34:56.${"1".repeat(1_000)}Z`;

    expect(() => parseJournalIntent({ ...validIntent(), schemaVersion: 2 })).toThrow(/schemaVersion/i);
    expect(() => parseJournalIntent({ ...validIntent(), effectKind: "delete-local" })).toThrow(/effectKind/i);
    expect(() => parseJournalIntent({ ...validIntent(), id: "not-an-id" })).toThrow(/id/i);
    expect(() => parseJournalIntent({ ...validIntent(), expectedByteHash: "not-a-hash" })).toThrow(
      /expectedByteHash/i,
    );
    expect(() => parseJournalIntent({ ...validIntent(), createdAt: "yesterday" })).toThrow(/createdAt/i);
    expect(() => parseJournalIntent({ ...validIntent(), createdAt: overlongTimestamp })).toThrow(/createdAt/i);
    expect(() => parseJournalCompletion({ ...validCompletion(), resultRemoteId: "not-an-id" })).toThrow(
      /resultRemoteId/i,
    );
    expect(() => parseJournalCompletion({ ...validCompletion(), completedAt: "soon" })).toThrow(/completedAt/i);
  });

  it("accepts absent metadata only as explicit nulls", () => {
    const intent = {
      ...validIntent(),
      relativePath: null,
      remoteId: null,
      allocationId: null,
      expectedByteHash: null,
      expectedSemanticHash: null,
      expectedRemoteEditedAt: null,
    };
    const completion = {
      ...validCompletion(),
      resultByteHash: null,
      resultSemanticHash: null,
      resultRemoteId: null,
      allocatedBridgeId: null,
      observedRemoteEditedAt: null,
    };

    expect(parseJournalIntent(intent)).toEqual(intent);
    expect(parseJournalCompletion(completion)).toEqual(completion);
  });
});
