import type {
  PairIdentityRef,
  PairStateAdvance,
  PairStateV1,
  PlannedEffect,
  PairStatus,
  SemanticNote,
} from "./core.js";
import type { SafeError } from "../errors.js";

export type LocalObservation =
  | {
      readonly kind: "missing";
      readonly path: string;
    }
  | {
      readonly kind: "malformed";
      readonly path: string;
      readonly reason: "invalid-frontmatter" | "conversion-failed";
    }
  | {
      readonly kind: "present";
      readonly path: string;
      readonly title: string;
      readonly bridgeId: string | null;
      readonly byteHash: string;
      readonly eligible: boolean;
      readonly semantic: Readonly<SemanticNote>;
      readonly semanticHash: string;
    };

export type NotionObservation =
  | {
      readonly kind: "missing";
      readonly pageId: string | null;
    }
  | {
      readonly kind: "present";
      readonly pageId: string;
      readonly bridgeId: string | null;
      readonly editedAt: string;
      readonly pageUrl: string;
      readonly sourceMarkdown: string;
      readonly complete: boolean;
      readonly unsupportedKinds: readonly string[];
      readonly semantic: Readonly<SemanticNote>;
      readonly semanticHash: string;
      readonly managed: Readonly<{
        title: string;
        obsidianPath: string;
        status: PairStatus;
      }>;
    };

export interface PairPreparation {
  readonly allocationId: string | null;
  readonly conflictDate: string | null;
  readonly push: null | {
    readonly notionMarkdown: string;
    readonly unsupportedKinds: readonly string[];
  };
  readonly pull: null | {
    readonly nextBytes: string;
    readonly nextByteHash: string;
  };
}

export interface PairPlanningInput {
  readonly local: LocalObservation;
  readonly notion: NotionObservation;
  readonly prior: Readonly<PairStateV1> | null;
  readonly prepared: Readonly<PairPreparation>;
}

export type PairAction =
  | "initialize"
  | "noop"
  | "push-local"
  | "pull-notion"
  | "conflict"
  | "detached"
  | "missing-local"
  | "missing-notion"
  | "error";

export type PairPlanReason =
  | "first-pair"
  | "unchanged"
  | "converged"
  | "local-changed"
  | "notion-changed"
  | "metadata-drift"
  | "concurrent-change"
  | "conflict-paused"
  | "not-eligible"
  | "local-missing"
  | "notion-missing"
  | "malformed-local"
  | "unsupported-local"
  | "unsupported-notion"
  | "identity-mismatch"
  | "invalid-input"
  | "conflict-artifact-too-large";

export interface PairPlan {
  readonly action: PairAction;
  readonly reason: PairPlanReason;
  readonly identity: PairIdentityRef | null;
  readonly effects: readonly PlannedEffect[];
  readonly error: SafeError | null;
  readonly stateAdvance: PairStateAdvance;
}

export type PlanningBatchValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "identity-collision";
      readonly error: Readonly<SafeError>;
    };
