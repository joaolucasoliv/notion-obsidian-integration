import { describe, expect, it } from "vitest";
import { parseBridgeState } from "./state";

const INSTALLATION_ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";
const BRIDGE_ID = "0bd79300-8068-4f26-9490-c1a923574d1d";
const NOTION_PAGE_ID = "59833787-2cf9-4fdf-8782-e53db20768a5";
const HASH = "727315411367e16793c5140eedbe2371b9619a47ce90e2b3e3b3704e2e725adc";
const TIMESTAMP = "2026-07-14T12:34:56.000Z";

function exactState() {
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    pairs: {},
    graph: null,
    lastFullReconciliationAt: null,
    lastRun: null,
  };
}

function populatedState() {
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    pairs: {
      [BRIDGE_ID]: {
        bridgeId: BRIDGE_ID,
        localPath: "Notes/Grandbox Bridge.md",
        notionPageId: NOTION_PAGE_ID,
        status: "synced",
        lastLocalSemanticHash: HASH,
        lastNotionSemanticHash: HASH,
        lastCommonSemanticHash: HASH,
        lastCommonLocalByteHash: HASH,
        lastNotionEditedAt: TIMESTAMP,
        lastSyncedAt: TIMESTAMP,
      },
    },
    graph: {
      projectionHash: HASH,
      graphId: "primary-graph",
      keyId: "key-2026-07",
      sequence: 1,
      lastPublishedAt: TIMESTAMP,
    },
    lastFullReconciliationAt: TIMESTAMP,
    lastRun: {
      mode: "apply",
      outcome: "success",
      planned: 1,
      writes: 1,
      pushed: 1,
      pulled: 0,
      conflicts: 0,
      errors: 0,
      graphUploads: 1,
      startedAt: TIMESTAMP,
      completedAt: TIMESTAMP,
    },
  };
}

describe("parseBridgeState", () => {
  it("accepts the exact v1 shape and rejects unknown fields", () => {
    const valid = exactState();

    expect(parseBridgeState(valid)).toEqual(valid);
    expect(() => parseBridgeState({ ...valid, token: "must-not-exist" })).toThrow(/unrecognized/i);
  });

  it("rejects unsupported schema versions", () => {
    expect(() => parseBridgeState({ ...exactState(), schemaVersion: 2 })).toThrow(/schemaVersion/i);
  });

  it("requires UUID installation, pair, and Notion identities", () => {
    expect(() => parseBridgeState({ ...exactState(), installationId: "not-a-uuid" })).toThrow(/installationId/i);

    const invalidBridgeId = populatedState();
    invalidBridgeId.pairs[BRIDGE_ID].bridgeId = "not-a-uuid";
    expect(() => parseBridgeState(invalidBridgeId)).toThrow(/bridgeId/i);

    const invalidNotionPageId = populatedState();
    invalidNotionPageId.pairs[BRIDGE_ID].notionPageId = "not-a-uuid";
    expect(() => parseBridgeState(invalidNotionPageId)).toThrow(/notionPageId/i);
  });

  it("requires offset ISO timestamps", () => {
    expect(() =>
      parseBridgeState({ ...exactState(), lastFullReconciliationAt: "2026-07-14 12:34:56" }),
    ).toThrow(/lastFullReconciliationAt/i);

    const invalidPairTimestamp = populatedState();
    invalidPairTimestamp.pairs[BRIDGE_ID].lastSyncedAt = "yesterday";
    expect(() => parseBridgeState(invalidPairTimestamp)).toThrow(/lastSyncedAt/i);

    const invalidRunTimestamp = populatedState();
    invalidRunTimestamp.lastRun.completedAt = "soon";
    expect(() => parseBridgeState(invalidRunTimestamp)).toThrow(/completedAt/i);
  });

  it("accepts every pair status and rejects unknown statuses", () => {
    const statuses = ["synced", "conflict", "detached", "missing-local", "missing-notion", "error"] as const;

    for (const status of statuses) {
      const state = populatedState();
      state.pairs[BRIDGE_ID].status = status;
      expect(parseBridgeState(state).pairs[BRIDGE_ID]?.status).toBe(status);
    }

    const invalid = populatedState();
    invalid.pairs[BRIDGE_ID].status = "pending";
    expect(() => parseBridgeState(invalid)).toThrow(/status/i);
  });

  it("rejects unknown fields in nested pair, graph, and run records", () => {
    const pairUnknown = populatedState();
    Object.assign(pairUnknown.pairs[BRIDGE_ID], { extra: true });
    expect(() => parseBridgeState(pairUnknown)).toThrow(/unrecognized/i);

    const graphUnknown = populatedState();
    Object.assign(graphUnknown.graph, { extra: true });
    expect(() => parseBridgeState(graphUnknown)).toThrow(/unrecognized/i);

    const runUnknown = populatedState();
    Object.assign(runUnknown.lastRun, { extra: true });
    expect(() => parseBridgeState(runUnknown)).toThrow(/unrecognized/i);
  });
});
