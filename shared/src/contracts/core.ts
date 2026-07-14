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

export type PlannedEffect =
  | { kind: "initialize-pair"; identity: PairIdentityRef; path: string; expectedByteHash: string }
  | { kind: "create-notion-page"; identity: PairIdentityRef; path: string }
  | {
      kind: "update-notion-body-exact";
      pageId: string;
      oldMarkdown: string;
      newMarkdown: string;
      observedEditedAt: string;
    }
  | {
      kind: "update-notion-properties";
      pageId: string;
      title: string;
      obsidianPath: string;
      tags: string[];
      status: PairStatus;
    }
  | { kind: "write-local"; path: string; expectedByteHash: string; nextBytes: string }
  | { kind: "create-conflict"; path: string; content: string }
  | { kind: "set-notion-status"; pageId: string; status: PairStatus };
