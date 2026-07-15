export type PairStatus =
  | "synced"
  | "conflict"
  | "detached"
  | "missing-local"
  | "missing-notion"
  | "error";

export interface SemanticNote {
  bodyMarkdown: string;
  tags: string[];
}

export interface PairStateV1 {
  bridgeId: string;
  localPath: string;
  notionPageId: string;
  status: PairStatus;
  lastLocalSemanticHash: string;
  lastNotionSemanticHash: string;
  lastCommonSemanticHash: string;
  lastCommonLocalByteHash: string;
  lastNotionEditedAt: string;
  lastSyncedAt: string;
}

export interface BridgeStateV1 {
  schemaVersion: 1;
  installationId: string;
  pairs: Record<string, PairStateV1>;
  graph: GraphPublishStateV1 | null;
  lastFullReconciliationAt: string | null;
  lastRun: BridgeRunSummary | null;
}

export interface GraphPublishStateV1 {
  projectionHash: string | null;
  graphId: string;
  keyId: string;
  sequence: number;
  lastPublishedAt: string | null;
}

export interface BridgeConfigV1 {
  schemaVersion: 1;
  installationId: string;
  vaultRoot: string;
  vaultFingerprint: string;
  notion: null | {
    parentPageId: string;
    dashboardPageId: string;
    databaseId: string;
    dataSourceId: string;
  };
  relay: null | { baseUrl: string };
  graph: null | {
    graphId: string;
    keyId: string;
    webOrigin: string | null;
    domains: Array<{
      pathPrefix: string;
      domain: "academic" | "research" | "project" | "personal" | "other";
    }>;
  };
}

export interface BridgeRunSummary {
  mode: "preview" | "apply";
  outcome: "success" | "noop" | "partial" | "conflict" | "failed" | "recovery-required";
  planned: number;
  writes: number;
  pushed: number;
  pulled: number;
  conflicts: number;
  errors: number;
  graphUploads: number;
  startedAt: string;
  completedAt: string;
}

export type PairIdentityRef =
  | { kind: "existing"; bridgeId: string }
  | { kind: "allocate-on-apply"; allocationId: string };

export type RemoteRevisionRef =
  | { readonly kind: "observed"; readonly editedAt: string }
  | { readonly kind: "effect-result"; readonly effectIndex: number };

export interface ManagedPropertiesSnapshot {
  readonly title: string;
  readonly obsidianPath: string;
  readonly tags: readonly string[];
  readonly status: PairStatus;
}

export type EvidenceSource =
  | { readonly kind: "observation" }
  | { readonly kind: "effect-result"; readonly effectIndex: number };

export type PairStateAdvance =
  | { readonly kind: "none" }
  | {
      readonly kind: "preserve-common";
      readonly base: Readonly<PairStateV1>;
      readonly status: PairStatus;
      readonly localPath: string;
      readonly notionRevision: EvidenceSource | null;
    }
  | {
      readonly kind: "establish-common";
      readonly identity: PairIdentityRef;
      readonly localPath: string;
      readonly semanticHash: string;
      readonly localEvidence: EvidenceSource;
      readonly notionEvidence: EvidenceSource;
    };

export type PlannedEffect =
  | {
      readonly kind: "initialize-pair";
      readonly identity: PairIdentityRef;
      readonly path: string;
      readonly expectedByteHash: string;
    }
  | {
      readonly kind: "create-notion-page";
      readonly identity: PairIdentityRef;
      readonly title: string;
      readonly obsidianPath: string;
      readonly tags: readonly string[];
      readonly markdown: string;
      readonly status: "synced";
    }
  | {
      readonly kind: "update-notion-body-exact";
      readonly pageId: string;
      readonly oldMarkdown: string;
      readonly newMarkdown: string;
      readonly expectedRevision: RemoteRevisionRef;
    }
  | {
      readonly kind: "update-notion-properties";
      readonly pageId: string;
      readonly expected: ManagedPropertiesSnapshot;
      readonly next: ManagedPropertiesSnapshot;
      readonly expectedRevision: RemoteRevisionRef;
    }
  | {
      readonly kind: "write-local";
      readonly path: string;
      readonly expectedByteHash: string;
      readonly nextBytes: string;
      readonly expectedNextByteHash: string;
    }
  | {
      readonly kind: "create-conflict";
      readonly path: string;
      readonly expectedAbsent: true;
      readonly content: string;
    }
  | {
      readonly kind: "set-notion-status";
      readonly pageId: string;
      readonly expectedStatus: PairStatus;
      readonly nextStatus: PairStatus;
      readonly expectedRevision: RemoteRevisionRef;
    };
