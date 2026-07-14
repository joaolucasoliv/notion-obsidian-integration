import type { PairIdentityRef, PairStateV1, PlannedEffect, SemanticNote } from "./core.js";

export type LocalObservation =
  | {
      readonly kind: "missing";
      readonly path: string;
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
      readonly complete: boolean;
      readonly unsupportedKinds: readonly string[];
      readonly semantic: Readonly<SemanticNote>;
      readonly semanticHash: string;
    };

export interface PairPlanningInput {
  readonly local: LocalObservation;
  readonly notion: NotionObservation;
  readonly prior: Readonly<PairStateV1> | null;
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

export interface PairPlan {
  readonly action: PairAction;
  readonly identity: PairIdentityRef | null;
  readonly effects: readonly PlannedEffect[];
}
