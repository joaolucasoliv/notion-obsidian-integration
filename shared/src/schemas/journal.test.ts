import { describe, expect, it } from "vitest";
import { parseJournalCompletion, parseJournalIntent } from "./journal";

const JOURNAL_ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";
const INSTALLATION_ID = "0bd79300-8068-4f26-9490-c1a923574d1d";
const REMOTE_ID = "59833787-2cf9-4fdf-8782-e53db20768a5";
const BRIDGE_ID = "81d1679b-09ef-42bc-8fe1-60c2a6ff1685";
const CORTEX_ROOT_ID = "0f168e77-fb55-4a1d-9a73-0891e7eb2c35";
const CORTEX_PAGE_ID = "411d25ac-178d-4ea7-a6c8-df597a62c4fc";
const CORTEX_PARENT_ID = "5d277a86-8a5d-4eab-a891-c1a0534e765a";
const CORTEX_TRANSACTION_ID = "7d277a86-8a5d-4eab-a891-c1a0534e765a";
const CORTEX_SOURCE_PATH = "The Cortex/Source.md";
const CORTEX_TARGET_PATH = "The Cortex/Target.md";
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
    resultByteHash: HASH,
    resultSemanticHash: HASH,
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

function validCortexIntent(effectKind: string) {
  const intent = {
    ...validIntent(),
    effectKind,
    relativePath: CORTEX_TARGET_PATH,
    remoteId: CORTEX_PAGE_ID,
    cortex: {
      rootPageId: CORTEX_ROOT_ID,
      pageId: CORTEX_PAGE_ID,
      sourcePath: CORTEX_SOURCE_PATH,
      targetPath: CORTEX_TARGET_PATH,
      expectedPostcondition: {
        pageId: CORTEX_PAGE_ID,
        parentPageId: CORTEX_PARENT_ID,
        title: "Target",
        relativePath: CORTEX_TARGET_PATH,
        byteHash: HASH,
        semanticHash: HASH,
        structureHash: HASH,
        editedAt: TIMESTAMP,
      },
    },
  };

  if (effectKind === "create-cortex-page") {
    return {
      ...intent,
      remoteId: null,
      allocationId: HASH,
      cortex: {
        ...intent.cortex,
        pageId: null,
        sourcePath: CORTEX_TARGET_PATH,
        expectedPostcondition: {
          ...intent.cortex.expectedPostcondition,
          pageId: null,
        },
      },
    };
  }
  if (effectKind === "update-cortex-body" || effectKind === "write-cortex-local") {
    return {
      ...intent,
      relativePath: CORTEX_SOURCE_PATH,
      cortex: {
        ...intent.cortex,
        targetPath: CORTEX_SOURCE_PATH,
        expectedPostcondition: {
          ...intent.cortex.expectedPostcondition,
          relativePath: CORTEX_SOURCE_PATH,
        },
      },
    };
  }
  if (effectKind === "create-cortex-local") {
    return {
      ...intent,
      expectedByteHash: null,
      cortex: { ...intent.cortex, sourcePath: null },
    };
  }
  if (effectKind === "create-cortex-conflict") {
    return {
      ...intent,
      expectedByteHash: null,
      cortex: { ...intent.cortex, sourcePath: null },
    };
  }
  if (effectKind === "advance-cortex-state") {
    return {
      ...intent,
      relativePath: null,
      remoteId: CORTEX_ROOT_ID,
      cortex: {
        ...intent.cortex,
        pageId: CORTEX_ROOT_ID,
        sourcePath: null,
        targetPath: "The Cortex.md",
        expectedPostcondition: {
          ...intent.cortex.expectedPostcondition,
          pageId: CORTEX_ROOT_ID,
          parentPageId: null,
          title: "The Cortex",
          relativePath: "The Cortex.md",
        },
      },
    };
  }
  return intent;
}

function validCortexTreeTransactionIntent() {
  return {
    ...validIntent(),
    effectKind: "commit-cortex-tree-transaction",
    relativePath: null,
    remoteId: null,
    allocationId: null,
    expectedByteHash: null,
    expectedSemanticHash: null,
    resultByteHash: null,
    resultSemanticHash: null,
    expectedRemoteEditedAt: null,
    cortexTransaction: {
      rootPageId: CORTEX_ROOT_ID,
      transactionId: CORTEX_TRANSACTION_ID,
      manifestDigest: HASH,
      participantIds: [CORTEX_ROOT_ID, CORTEX_PAGE_ID, CORTEX_PARENT_ID],
    },
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

  it.each([
    "content",
    "noteBytes",
    "markdown",
    "bodyMarkdown",
    "credential",
    "secret",
    "headers",
    "requestHeaders",
    "providerBody",
  ])(
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
    "./Notes/Bridge.md",
    "Notes/../Bridge.md",
    "Notes\\Bridge.md",
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
      resultByteHash: null,
      resultSemanticHash: null,
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

  it("allows a metadata-only state commit fence and rejects note material on it", () => {
    const fence = {
      ...validIntent(),
      effectKind: "commit-state",
      relativePath: null,
      remoteId: null,
      allocationId: null,
      expectedByteHash: null,
      expectedSemanticHash: null,
      resultByteHash: null,
      resultSemanticHash: null,
      expectedRemoteEditedAt: null,
    };

    expect(parseJournalIntent(fence)).toEqual(fence);
    expect(() => parseJournalIntent({ ...fence, bodyMarkdown: "must not persist" })).toThrow(/unrecognized/i);
    expect(() => parseJournalIntent({ ...fence, resultSemanticHash: HASH })).toThrow(/commit-state/i);
  });

  it("parses a metadata-only Cortex tree transaction journal effect without serializing note content", () => {
    const intent = validCortexTreeTransactionIntent();
    const parsed = parseJournalIntent(intent);
    const noteBody = "private transaction note body must never reach journal storage";

    expect(parsed).toEqual(intent);
    expect(JSON.stringify(parsed)).not.toContain(noteBody);
    expect(() => parseJournalIntent({ ...intent, bodyMarkdown: noteBody })).toThrow(/unrecognized/i);
  });

  it("rejects a Cortex transaction journal whose root is not one of its sorted participants", () => {
    const unsorted = validCortexTreeTransactionIntent();
    unsorted.cortexTransaction.participantIds = [CORTEX_PAGE_ID, CORTEX_ROOT_ID, CORTEX_PARENT_ID];
    expect(() => parseJournalIntent(unsorted)).toThrow(/participant/i);

    const missingRoot = validCortexTreeTransactionIntent();
    missingRoot.cortexTransaction.participantIds = [CORTEX_PAGE_ID, CORTEX_PARENT_ID];
    expect(() => parseJournalIntent(missingRoot)).toThrow(/root|participant/i);
  });

  it("requires nullable planned local postcondition hashes on every intent", () => {
    const missingByteHash = validIntent();
    const missingSemanticHash = validIntent();
    delete (missingByteHash as { resultByteHash?: string | null }).resultByteHash;
    delete (missingSemanticHash as { resultSemanticHash?: string | null }).resultSemanticHash;

    expect(() => parseJournalIntent(missingByteHash)).toThrow(/resultByteHash/i);
    expect(() => parseJournalIntent(missingSemanticHash)).toThrow(/resultSemanticHash/i);
  });

  it.each([
    "create-cortex-page",
    "update-cortex-body",
    "update-cortex-title",
    "move-cortex-page",
    "create-cortex-local",
    "write-cortex-local",
    "move-cortex-subtree",
    "create-cortex-conflict",
    "advance-cortex-state",
  ])("accepts the Cortex journal vocabulary with immutable expected postconditions: %s", (effectKind) => {
    const intent = validCortexIntent(effectKind);

    expect(parseJournalIntent(intent)).toEqual(intent);
  });

  it("rejects a Cortex effect that lacks immutable expected postcondition data", () => {
    const incomplete = validCortexIntent("update-cortex-body");
    delete (incomplete.cortex as { expectedPostcondition?: unknown }).expectedPostcondition;

    expect(() => parseJournalIntent(incomplete)).toThrow(/expectedPostcondition/i);
  });

  it("rejects a Cortex body effect whose expected postcondition omits its semantic and structure hashes", () => {
    const incomplete = validCortexIntent("update-cortex-body");
    incomplete.cortex.expectedPostcondition.semanticHash = null;
    incomplete.cortex.expectedPostcondition.structureHash = null;

    expect(() => parseJournalIntent(incomplete)).toThrow(/semanticHash|structureHash/i);
  });

  it("requires effect-specific immutable recovery evidence", () => {
    const createRemote = validCortexIntent("create-cortex-page");
    createRemote.allocationId = null;
    expect(() => parseJournalIntent(createRemote)).toThrow(/allocationId/i);

    const updateBody = validCortexIntent("update-cortex-body");
    updateBody.cortex.pageId = null;
    expect(() => parseJournalIntent(updateBody)).toThrow(/pageId/i);

    const updateTitle = validCortexIntent("update-cortex-title");
    updateTitle.expectedRemoteEditedAt = null;
    expect(() => parseJournalIntent(updateTitle)).toThrow(/expectedRemoteEditedAt/i);

    const moveRemote = validCortexIntent("move-cortex-page");
    moveRemote.cortex.expectedPostcondition.parentPageId = null;
    expect(() => parseJournalIntent(moveRemote)).toThrow(/parentPageId/i);

    const createLocal = validCortexIntent("create-cortex-local");
    createLocal.cortex.targetPath = null;
    expect(() => parseJournalIntent(createLocal)).toThrow(/targetPath/i);

    const writeLocal = validCortexIntent("write-cortex-local");
    writeLocal.expectedByteHash = null;
    expect(() => parseJournalIntent(writeLocal)).toThrow(/expectedByteHash/i);

    const moveLocal = validCortexIntent("move-cortex-subtree");
    moveLocal.cortex.sourcePath = null;
    expect(() => parseJournalIntent(moveLocal)).toThrow(/sourcePath/i);

    const conflict = validCortexIntent("create-cortex-conflict");
    conflict.resultByteHash = null;
    expect(() => parseJournalIntent(conflict)).toThrow(/resultByteHash/i);

    const advanceState = validCortexIntent("advance-cortex-state");
    advanceState.cortex.expectedPostcondition.relativePath = null;
    expect(() => parseJournalIntent(advanceState)).toThrow(/relativePath/i);
  });

  it("limits Cortex recovery paths to the reserved root and subtree", () => {
    const sourceOutsideTree = validCortexIntent("update-cortex-body");
    sourceOutsideTree.cortex.sourcePath = "Notes/Outside.md";
    expect(() => parseJournalIntent(sourceOutsideTree)).toThrow(/sourcePath/i);

    const targetOutsideTree = validCortexIntent("update-cortex-title");
    targetOutsideTree.cortex.targetPath = "Notes/Outside.md";
    expect(() => parseJournalIntent(targetOutsideTree)).toThrow(/targetPath/i);

    const postconditionOutsideTree = validCortexIntent("move-cortex-page");
    postconditionOutsideTree.cortex.expectedPostcondition.relativePath = "Notes/Outside.md";
    expect(() => parseJournalIntent(postconditionOutsideTree)).toThrow(/relativePath/i);
  });

  it("binds Cortex envelope and recovery paths to the page identity", () => {
    const envelopeOutsideTree = validCortexIntent("update-cortex-body");
    envelopeOutsideTree.relativePath = "Notes/Bridge.md";
    expect(() => parseJournalIntent(envelopeOutsideTree)).toThrow(/relativePath/i);

    const rootAtRoot = validCortexIntent("update-cortex-body");
    rootAtRoot.relativePath = "The Cortex.md";
    rootAtRoot.remoteId = CORTEX_ROOT_ID;
    rootAtRoot.cortex.pageId = CORTEX_ROOT_ID;
    rootAtRoot.cortex.sourcePath = "The Cortex.md";
    rootAtRoot.cortex.targetPath = "The Cortex.md";
    rootAtRoot.cortex.expectedPostcondition.pageId = CORTEX_ROOT_ID;
    rootAtRoot.cortex.expectedPostcondition.parentPageId = null;
    rootAtRoot.cortex.expectedPostcondition.relativePath = "The Cortex.md";
    expect(parseJournalIntent(rootAtRoot)).toEqual(rootAtRoot);

    const descendantAtRoot = validCortexIntent("update-cortex-body");
    descendantAtRoot.relativePath = "The Cortex.md";
    descendantAtRoot.cortex.sourcePath = "The Cortex.md";
    descendantAtRoot.cortex.targetPath = "The Cortex.md";
    descendantAtRoot.cortex.expectedPostcondition.relativePath = "The Cortex.md";
    expect(() => parseJournalIntent(descendantAtRoot)).toThrow(/sourcePath|targetPath|relativePath/i);

    const rootBelowTree = validCortexIntent("update-cortex-body");
    rootBelowTree.relativePath = CORTEX_SOURCE_PATH;
    rootBelowTree.remoteId = CORTEX_ROOT_ID;
    rootBelowTree.cortex.pageId = CORTEX_ROOT_ID;
    rootBelowTree.cortex.sourcePath = CORTEX_SOURCE_PATH;
    rootBelowTree.cortex.targetPath = CORTEX_SOURCE_PATH;
    rootBelowTree.cortex.expectedPostcondition.pageId = CORTEX_ROOT_ID;
    rootBelowTree.cortex.expectedPostcondition.parentPageId = null;
    rootBelowTree.cortex.expectedPostcondition.relativePath = CORTEX_SOURCE_PATH;
    expect(() => parseJournalIntent(rootBelowTree)).toThrow(/sourcePath|targetPath|relativePath/i);

    const createdAtRoot = validCortexIntent("create-cortex-page");
    createdAtRoot.relativePath = "The Cortex.md";
    createdAtRoot.cortex.sourcePath = "The Cortex.md";
    createdAtRoot.cortex.targetPath = "The Cortex.md";
    createdAtRoot.cortex.expectedPostcondition.relativePath = "The Cortex.md";
    expect(() => parseJournalIntent(createdAtRoot)).toThrow(/sourcePath|targetPath|relativePath/i);

    const stateWithPath = validCortexIntent("advance-cortex-state");
    stateWithPath.relativePath = "The Cortex.md";
    expect(() => parseJournalIntent(stateWithPath)).toThrow(/relativePath/i);
  });

  it("allows only the exact conflict artifact path when the conflicted Cortex page is the root", () => {
    const artifactPath = `The Cortex/.conflicts/${CORTEX_ROOT_ID}.conflict.md`;
    const rootConflict = validCortexIntent("create-cortex-conflict");
    rootConflict.relativePath = artifactPath;
    rootConflict.remoteId = CORTEX_ROOT_ID;
    rootConflict.cortex.pageId = CORTEX_ROOT_ID;
    rootConflict.cortex.sourcePath = null;
    rootConflict.cortex.targetPath = artifactPath;
    rootConflict.cortex.expectedPostcondition.pageId = CORTEX_ROOT_ID;
    rootConflict.cortex.expectedPostcondition.parentPageId = null;
    rootConflict.cortex.expectedPostcondition.title = "The Cortex";
    rootConflict.cortex.expectedPostcondition.relativePath = artifactPath;

    expect(parseJournalIntent(rootConflict)).toEqual(rootConflict);

    const wrongRootArtifact = structuredClone(rootConflict);
    const wrongPath = `The Cortex/.conflicts/${CORTEX_PAGE_ID}.conflict.md`;
    wrongRootArtifact.relativePath = wrongPath;
    wrongRootArtifact.cortex.targetPath = wrongPath;
    wrongRootArtifact.cortex.expectedPostcondition.relativePath = wrongPath;
    expect(() => parseJournalIntent(wrongRootArtifact)).toThrow(/conflict|targetPath|relativePath/i);
  });

  it("does not allow a Cortex payload on a legacy direct-pair effect", () => {
    const legacyWithCortex = { ...validIntent(), cortex: validCortexIntent("update-cortex-body").cortex };

    expect(() => parseJournalIntent(legacyWithCortex)).toThrow(/cortex/i);
  });
});
