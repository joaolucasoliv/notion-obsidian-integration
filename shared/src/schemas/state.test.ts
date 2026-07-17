import { describe, expect, it } from "vitest";
import { parseBridgeState } from "./state";

const INSTALLATION_ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";
const BRIDGE_ID = "0bd79300-8068-4f26-9490-c1a923574d1d";
const NOTION_PAGE_ID = "59833787-2cf9-4fdf-8782-e53db20768a5";
const CORTEX_ROOT_PAGE_ID = "730318aa-8c1b-4d84-98ac-07274f77bcef";
const CORTEX_CHILD_PAGE_ID = "85928d88-b12e-4c57-a8c5-81175d5ff623";
const CORTEX_DUPLICATE_PAGE_KEY = "4a4f2863-0f3a-4a81-9c5d-c6afb3e0f99d";
const TRAVERSAL_ID = "cbe8f480-73a3-4f2b-a638-c7a1fc77e053";
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

function cortexState() {
  return {
    schemaVersion: 2,
    installationId: INSTALLATION_ID,
    pairs: {},
    graph: null,
    lastFullReconciliationAt: null,
    lastRun: null,
    cortex: {
      rootPageId: CORTEX_ROOT_PAGE_ID,
      rootFilePath: "The Cortex.md",
      rootDirectoryPath: "The Cortex",
      pages: {
        [CORTEX_ROOT_PAGE_ID]: {
          pageId: CORTEX_ROOT_PAGE_ID,
          parentPageId: null,
          rootPageId: CORTEX_ROOT_PAGE_ID,
          localPath: "The Cortex.md",
          title: "The Cortex",
          status: "synced",
          lastLocalSemanticHash: HASH,
          lastNotionSemanticHash: HASH,
          lastCommonSemanticHash: HASH,
          lastCommonStructureHash: HASH,
          lastCommonLocalByteHash: HASH,
          lastNotionEditedAt: TIMESTAMP,
          lastSyncedAt: TIMESTAMP,
          lastSeenTraversalId: TRAVERSAL_ID,
        },
        [CORTEX_CHILD_PAGE_ID]: {
          pageId: CORTEX_CHILD_PAGE_ID,
          parentPageId: CORTEX_ROOT_PAGE_ID,
          rootPageId: CORTEX_ROOT_PAGE_ID,
          localPath: "The Cortex/Research.md",
          title: "Research",
          status: "synced",
          lastLocalSemanticHash: HASH,
          lastNotionSemanticHash: HASH,
          lastCommonSemanticHash: HASH,
          lastCommonStructureHash: HASH,
          lastCommonLocalByteHash: HASH,
          lastNotionEditedAt: TIMESTAMP,
          lastSyncedAt: TIMESTAMP,
          lastSeenTraversalId: TRAVERSAL_ID,
        },
      },
      lastSuccessfulTraversalId: TRAVERSAL_ID,
    },
  };
}

describe("parseBridgeState", () => {
  it("strictly reads the exact V1 state and normalizes it to V2 without Cortex", () => {
    const valid = exactState();

    expect(parseBridgeState(valid)).toEqual({ ...valid, schemaVersion: 2, cortex: null });
    expect(() => parseBridgeState({ ...valid, token: "must-not-exist" })).toThrow(/unrecognized/i);
    expect(() => parseBridgeState({ ...valid, cortex: null })).toThrow(/unrecognized/i);
  });

  it("accepts a strict V2 Cortex tree with immutable page identities", () => {
    const valid = cortexState();

    expect(parseBridgeState(valid)).toEqual(valid);
    expect(() => parseBridgeState({ ...valid, cortex: { ...valid.cortex, extra: true } })).toThrow(/unrecognized/i);
  });

  it("rejects unsupported schema versions", () => {
    expect(() => parseBridgeState({ ...exactState(), schemaVersion: 3 })).toThrow(/schemaVersion/i);
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

  it("requires canonical Cortex UUIDs and page-map keys that match each page identity", () => {
    const nonCanonical = cortexState();
    const child = nonCanonical.cortex.pages[CORTEX_CHILD_PAGE_ID];
    delete nonCanonical.cortex.pages[CORTEX_CHILD_PAGE_ID];
    nonCanonical.cortex.pages[CORTEX_CHILD_PAGE_ID.toUpperCase()] = {
      ...child,
      pageId: CORTEX_CHILD_PAGE_ID.toUpperCase(),
    };
    expect(() => parseBridgeState(nonCanonical)).toThrow(/pages|pageId/i);

    const mismatchedKey = cortexState();
    const originalChild = mismatchedKey.cortex.pages[CORTEX_CHILD_PAGE_ID];
    delete mismatchedKey.cortex.pages[CORTEX_CHILD_PAGE_ID];
    mismatchedKey.cortex.pages[CORTEX_DUPLICATE_PAGE_KEY] = originalChild;
    expect(() => parseBridgeState(mismatchedKey)).toThrow(/pages|pageId/i);
  });

  it("rejects duplicate Cortex page identities", () => {
    const duplicate = cortexState();
    duplicate.cortex.pages[CORTEX_DUPLICATE_PAGE_KEY] = {
      ...duplicate.cortex.pages[CORTEX_CHILD_PAGE_ID],
    };

    expect(() => parseBridgeState(duplicate)).toThrow(/pages|pageId/i);
  });

  it.each([
    "/absolute.md",
    "./The Cortex/Research.md",
    "The Cortex/../Research.md",
    "The Cortex\\Research.md",
  ])("rejects unsafe Cortex local paths: %s", (localPath) => {
    const invalid = cortexState();
    invalid.cortex.pages[CORTEX_CHILD_PAGE_ID].localPath = localPath;

    expect(() => parseBridgeState(invalid)).toThrow(/localPath/i);
  });

  it("validates Cortex timestamps, hashes, and tree root/path consistency", () => {
    const invalidHash = cortexState();
    invalidHash.cortex.pages[CORTEX_CHILD_PAGE_ID].lastCommonStructureHash = "not-a-hash";
    expect(() => parseBridgeState(invalidHash)).toThrow(/lastCommonStructureHash/i);

    const invalidNotionEditedAt = cortexState();
    invalidNotionEditedAt.cortex.pages[CORTEX_CHILD_PAGE_ID].lastNotionEditedAt = "yesterday";
    expect(() => parseBridgeState(invalidNotionEditedAt)).toThrow(/lastNotionEditedAt/i);

    const invalidSyncedAt = cortexState();
    invalidSyncedAt.cortex.pages[CORTEX_CHILD_PAGE_ID].lastSyncedAt = "soon";
    expect(() => parseBridgeState(invalidSyncedAt)).toThrow(/lastSyncedAt/i);

    const invalidTraversalId = cortexState();
    invalidTraversalId.cortex.pages[CORTEX_CHILD_PAGE_ID].lastSeenTraversalId = "not-a-uuid";
    expect(() => parseBridgeState(invalidTraversalId)).toThrow(/lastSeenTraversalId/i);

    const rootHasParent = cortexState();
    rootHasParent.cortex.pages[CORTEX_ROOT_PAGE_ID].parentPageId = CORTEX_CHILD_PAGE_ID;
    expect(() => parseBridgeState(rootHasParent)).toThrow(/parentPageId|root/i);

    const rootHasWrongPath = cortexState();
    rootHasWrongPath.cortex.pages[CORTEX_ROOT_PAGE_ID].localPath = "The Cortex/Root.md";
    expect(() => parseBridgeState(rootHasWrongPath)).toThrow(/localPath|root/i);

    const mismatchedRoot = cortexState();
    mismatchedRoot.cortex.pages[CORTEX_CHILD_PAGE_ID].rootPageId = CORTEX_CHILD_PAGE_ID;
    expect(() => parseBridgeState(mismatchedRoot)).toThrow(/rootPageId|root/i);
  });
});
