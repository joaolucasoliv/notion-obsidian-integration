import type { SafeError } from "../errors.ts";

/** Fixed configuration for the root-scoped regular-page Cortex mirror. */
export interface CortexTreeConfigV1 {
  rootPageId: string;
  rootFilePath: "The Cortex.md";
  rootDirectoryPath: "The Cortex";
}

export type CortexPageStatus =
  | "synced"
  | "conflict"
  | "missing-local"
  | "missing-notion"
  | "attention"
  | "error";

/** Durable state for one Notion regular page in the configured Cortex tree. */
export interface CortexPageStateV1 {
  pageId: string;
  parentPageId: string | null;
  rootPageId: string;
  localPath: string;
  title: string;
  status: CortexPageStatus;
  lastLocalSemanticHash: string;
  lastNotionSemanticHash: string;
  lastCommonSemanticHash: string;
  lastCommonStructureHash: string;
  lastCommonLocalByteHash: string;
  lastNotionEditedAt: string;
  lastSyncedAt: string;
  lastSeenTraversalId: string;
}

/** Durable state for the independently reconciled Cortex tree. */
export interface CortexTreeStateV1 {
  rootPageId: string;
  rootFilePath: "The Cortex.md";
  rootDirectoryPath: "The Cortex";
  pages: Record<string, CortexPageStateV1>;
  lastSuccessfulTraversalId: string | null;
}

export interface CortexPageObservation {
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly rootPageId: string;
  readonly title: string;
  readonly sourceMarkdown: string;
  /** Ordered direct child-page IDs preserved as non-body tree structure. */
  readonly directChildPageIds: readonly string[];
  readonly semanticHash: string;
  readonly structureHash: string;
  readonly editedAt: string;
  readonly complete: boolean;
  /** True only for a configured root whose visual Notion body is intentionally not mirrored. */
  readonly opaqueRoot?: true;
}

export type CortexLocalObservation =
  | { readonly kind: "missing"; readonly path: string }
  | {
      readonly kind: "present";
      readonly path: string;
      readonly pageId: string | null;
      readonly parentPageId: string | null;
      readonly rootPageId: string | null;
      readonly title: string;
      readonly byteHash: string;
      readonly semanticHash: string;
      readonly structureHash: string;
    }
  | { readonly kind: "malformed"; readonly path: string; readonly reason: string };

export type CortexDiscoveryAttention =
  | { readonly kind: "inaccessible"; readonly pageId: string }
  | { readonly kind: "cycle"; readonly pageId: string }
  | { readonly kind: "depth-limit"; readonly pageId: string }
  | { readonly kind: "page-limit"; readonly pageId: string }
  | { readonly kind: "invalid-page"; readonly pageId: string | null }
  | { readonly kind: "truncated"; readonly pageId: string | null };

export interface CortexTreeDiscovery {
  readonly rootPageId: string;
  readonly traversalId: string;
  readonly pages: readonly CortexPageObservation[];
  readonly complete: boolean;
  readonly attention: readonly CortexDiscoveryAttention[];
}

export type CortexPlanAction =
  | "noop"
  | "create-remote"
  | "update-remote-body"
  | "update-remote-title"
  | "move-remote"
  | "create-local"
  | "write-local"
  | "move-local"
  | "conflict"
  | "advance-state"
  | "attention";

/**
 * One ephemeral local member of a coupled Cortex structural transaction.
 * Content is deliberately runtime-only: manifests, state, and journals carry
 * hashes and private preimage references instead of note bytes.
 */
export type CortexTreeTransactionMember =
  | {
      readonly memberId: string;
      readonly kind: "write";
      readonly relativePath: string;
      readonly expectedByteHash: string;
      readonly resultByteHash: string;
      readonly content: string;
    }
  | {
      readonly memberId: string;
      readonly kind: "create";
      readonly relativePath: string;
      readonly expectedAbsent: true;
      readonly resultByteHash: string;
      readonly content: string;
    }
  | {
      readonly memberId: string;
      readonly kind: "move";
      readonly sourcePath: string;
      readonly targetPath: string;
      readonly expectedSourceByteHash: string;
    };

/** Exact runtime input for one local-only Cortex tree transaction. */
export interface CortexTreeTransactionPlan {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly rootPageId: string;
  /** Canonically sorted, unique page IDs; always includes rootPageId. */
  readonly participantIds: readonly string[];
  readonly members: readonly CortexTreeTransactionMember[];
}

/** The durable outcome of one local Cortex tree transaction attempt. */
export interface CortexTreeTransactionResult {
  readonly transactionId: string;
  readonly rootPageId: string;
  readonly manifestDigest: string;
  readonly status: "committed" | "rolled-back" | "recovery-required";
  readonly completedMemberIds: readonly string[];
  readonly error: SafeError | null;
}

/** Result of scanning the private local transaction manifest directory. */
export interface CortexTreeTransactionRecovery {
  readonly transactions: readonly CortexTreeTransactionResult[];
}

export type CortexPlannedEffect =
  | {
      readonly kind: "create-cortex-page";
      readonly rootPageId: string;
      readonly parentPageId: string;
      readonly title: string;
      readonly semanticHash: string;
      readonly structureHash: string;
    }
  | {
      readonly kind: "update-cortex-body";
      readonly rootPageId: string;
      readonly pageId: string;
      readonly expectedEditedAt: string;
      readonly expectedSemanticHash: string;
      readonly nextSemanticHash: string;
      readonly expectedStructureHash: string;
    }
  | {
      readonly kind: "update-cortex-title";
      readonly rootPageId: string;
      readonly pageId: string;
      readonly expectedEditedAt: string;
      readonly title: string;
    }
  | {
      readonly kind: "move-cortex-page";
      readonly rootPageId: string;
      readonly pageId: string;
      readonly expectedEditedAt: string;
      readonly parentPageId: string;
    }
  | {
      readonly kind: "create-cortex-local";
      readonly rootPageId: string;
      readonly pageId: string;
      readonly path: string;
      readonly expectedAbsent: true;
      readonly resultByteHash: string;
    }
  | {
      readonly kind: "write-cortex-local";
      readonly rootPageId: string;
      readonly pageId: string;
      readonly path: string;
      readonly expectedByteHash: string;
      readonly resultByteHash: string;
    }
  | {
      readonly kind: "move-cortex-subtree";
      readonly rootPageId: string;
      readonly pageId: string;
      readonly sourcePath: string;
      readonly targetPath: string;
      readonly expectedSourceByteHash: string;
    }
  | {
      readonly kind: "create-cortex-conflict";
      readonly rootPageId: string;
      readonly pageId: string;
      readonly path: string;
      readonly expectedAbsent: true;
      readonly resultByteHash: string;
    }
  | {
      readonly kind: "advance-cortex-state";
      readonly rootPageId: string;
      readonly expectedTraversalId: string | null;
      readonly nextTraversalId: string | null;
    };

export interface CortexEffectResult {
  readonly effectIndex: number;
  readonly kind: CortexPlannedEffect["kind"];
  readonly page: CortexPageObservation | null;
  readonly byteHash: string | null;
  readonly semanticHash: string | null;
  readonly structureHash: string | null;
}

export interface CortexPagePlan {
  readonly pageId: string | null;
  readonly action: CortexPlanAction;
  readonly effects: readonly CortexPlannedEffect[];
  readonly error: SafeError | null;
}

export interface CortexTreePlan {
  readonly rootPageId: string;
  readonly traversalId: string | null;
  readonly complete: boolean;
  readonly pages: readonly CortexPagePlan[];
  readonly effects: readonly CortexPlannedEffect[];
  readonly error: SafeError | null;
}
