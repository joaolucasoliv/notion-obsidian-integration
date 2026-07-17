import type { GraphDocumentV1 } from "@grandbox-bridge/shared";

export type SafeGraphErrorCode =
  | "invalid-route"
  | "invalid-pairing"
  | "unavailable"
  | "invalid-envelope"
  | "decryption-failed"
  | "invalid-graph"
  | "rollback-rejected"
  | "storage-unavailable";

export type AppState =
  | { readonly kind: "locked"; readonly reason: "unpaired" | "rotated" | "forgotten" }
  | { readonly kind: "pairing"; readonly source: "paste" | "camera"; readonly error: string | null }
  | { readonly kind: "loading"; readonly graphId: string; readonly retained: GraphDocumentV1 | null }
  | { readonly kind: "ready"; readonly graph: GraphDocumentV1; readonly sequence: number; readonly stale: boolean }
  | { readonly kind: "error"; readonly code: SafeGraphErrorCode; readonly retryable: boolean; readonly retained: GraphDocumentV1 | null };

export type AppEvent =
  | { readonly type: "pairing-requested"; readonly source: "paste" | "camera" }
  | { readonly type: "pairing-cancelled" }
  | { readonly type: "pairing-failed"; readonly code: "invalid-pairing" }
  | { readonly type: "snapshot-requested"; readonly graphId: string; readonly retained: GraphDocumentV1 | null }
  | { readonly type: "verified-graph-committed"; readonly graph: GraphDocumentV1; readonly sequence: number }
  | { readonly type: "snapshot-failed"; readonly code: SafeGraphErrorCode; readonly retryable: boolean }
  | { readonly type: "render-requested" }
  | { readonly type: "rotation-detected" }
  | { readonly type: "forgotten" };

export function initialAppState(): AppState {
  return { kind: "locked", reason: "unpaired" };
}

function retainedGraph(state: AppState): GraphDocumentV1 | null {
  if (state.kind === "ready") return state.graph;
  if (state.kind === "loading" || state.kind === "error") return state.retained;
  return null;
}

function transitionError(state: AppState, event: Extract<AppEvent, { type: "snapshot-failed" }>): AppState {
  return {
    kind: "error",
    code: event.code,
    retryable: event.retryable,
    retained: retainedGraph(state),
  };
}

export function reduceAppState(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "pairing-requested":
      if (state.kind !== "locked" && state.kind !== "pairing") {
        throw new Error("Pairing can only begin from a locked or pairing state");
      }
      return { kind: "pairing", source: event.source, error: null };
    case "pairing-cancelled":
      if (state.kind !== "pairing") throw new Error("Pairing is not active");
      return { kind: "locked", reason: "unpaired" };
    case "pairing-failed":
      if (state.kind !== "pairing") throw new Error("Pairing is not active");
      return { ...state, error: "This pairing code could not be verified." };
    case "snapshot-requested":
      return { kind: "loading", graphId: event.graphId, retained: event.retained };
    case "verified-graph-committed":
      if (state.kind !== "loading") {
        throw new Error("A graph can only be committed after verification begins");
      }
      if (event.graph.sequence !== event.sequence) {
        throw new Error("Verified graph sequence does not match the committed sequence");
      }
      return { kind: "ready", graph: event.graph, sequence: event.sequence, stale: false };
    case "snapshot-failed":
      return transitionError(state, event);
    case "render-requested":
      if (state.kind !== "ready") {
        throw new Error("A verified graph must be committed before rendering");
      }
      return state;
    case "rotation-detected":
      return { kind: "locked", reason: "rotated" };
    case "forgotten":
      return { kind: "locked", reason: "forgotten" };
  }
}
