import type { GraphDocumentV1 } from "@grandbox-bridge/shared";
import { SnapshotSourceError, type SnapshotSource } from "../api/snapshot-client.ts";
import { decryptAndValidateGraph, GraphAcceptanceError, GRAPH_LIMITS } from "../crypto/decrypt.ts";
import type { PairingCandidate } from "../pairing/controller.ts";
import type { PairingStore, StoredPairing } from "../storage/pairing-store.ts";
import { parseGraphRoute, type GraphRoute } from "../route.ts";
import { initialAppState, reduceAppState, type AppEvent, type AppState, type SafeGraphErrorCode } from "./state.ts";

export interface AppView {
  render(state: AppState, route: GraphRoute | null): void;
}

export interface GraphRendererHandle {
  replace(graph: GraphDocumentV1): void;
  destroy(): void;
}

export interface GraphRendererFactory {
  create(): GraphRendererHandle;
}

export interface GraphAppDependencies {
  readonly snapshotSource: SnapshotSource;
  readonly pairingStore: PairingStore;
  readonly rendererFactory: GraphRendererFactory;
}

function retryable(code: SafeGraphErrorCode): boolean {
  return code === "unavailable" || code === "storage-unavailable";
}

function safeFailure(error: unknown): { readonly code: SafeGraphErrorCode; readonly rotated: boolean } {
  if (error instanceof GraphAcceptanceError) return { code: error.safeCode, rotated: error.rotated };
  if (error instanceof SnapshotSourceError) return { code: error.safeCode, rotated: false };
  return { code: "unavailable", rotated: false };
}

export class GraphAppController {
  readonly #view: AppView;
  readonly #dependencies: GraphAppDependencies | null;
  #route: GraphRoute | null = null;
  #state: AppState = initialAppState();
  #pairing: PairingCandidate | StoredPairing | null = null;
  #verifiedGraph: GraphDocumentV1 | null = null;
  #renderer: GraphRendererHandle | null = null;
  #request: AbortController | null = null;

  public constructor(view: AppView, dependencies?: GraphAppDependencies) {
    this.#view = view;
    this.#dependencies = dependencies ?? null;
  }

  public start(pathname: string): void {
    this.#abortRequest();
    this.#destroyRenderer();
    this.#pairing = null;
    this.#verifiedGraph = null;
    try {
      this.#route = parseGraphRoute(pathname);
      this.#state = initialAppState();
    } catch {
      this.#route = null;
      this.#state = { kind: "error", code: "invalid-route", retryable: false, retained: null };
    }

    this.#render();
  }

  public dispatch(event: AppEvent): void {
    this.#state = reduceAppState(this.#state, event);
    this.#render();
  }

  public async acceptPairing(candidate: PairingCandidate): Promise<void> {
    if (this.#route === null || candidate.graphId !== this.#route.graphId) {
      this.#state = { kind: "error", code: "invalid-pairing", retryable: false, retained: this.#verifiedGraph };
      this.#render();
      return;
    }
    this.#pairing = candidate;
    await this.refresh();
  }

  public async refresh(): Promise<void> {
    const dependencies = this.#dependencies;
    const route = this.#route;
    if (dependencies === null || route === null) return;

    let pairing = this.#pairing;
    if (pairing === null) {
      try {
        pairing = await dependencies.pairingStore.get(route.graphId);
      } catch {
        this.#setFailure("storage-unavailable");
        return;
      }
      if (pairing === null) return;
      this.#pairing = pairing;
    }

    this.#abortRequest();
    const request = new AbortController();
    this.#request = request;
    this.#state = reduceAppState(this.#state, {
      type: "snapshot-requested",
      graphId: route.graphId,
      retained: this.#verifiedGraph,
    });
    this.#render();

    try {
      const envelope = await dependencies.snapshotSource.getLatest(route.graphId, request.signal);
      if (this.#request !== request || request.signal.aborted) return;
      const accepted = await decryptAndValidateGraph({
        envelopeInput: envelope,
        pairing,
        expectedGraphId: route.graphId,
        limits: GRAPH_LIMITS,
        store: dependencies.pairingStore,
      });
      if (this.#request !== request || request.signal.aborted) return;

      this.#verifiedGraph = accepted.graph;
      this.#renderer ??= dependencies.rendererFactory.create();
      this.#renderer.replace(accepted.graph);
      this.#state = reduceAppState(this.#state, {
        type: "verified-graph-committed",
        graph: accepted.graph,
        sequence: accepted.sequence,
      });
      this.#render();
    } catch (error) {
      if (this.#request !== request || request.signal.aborted) return;
      const failure = safeFailure(error);
      if (failure.rotated) {
        this.#destroyRenderer();
        this.#verifiedGraph = null;
        this.#pairing = null;
        this.#state = reduceAppState(this.#state, { type: "rotation-detected" });
        this.#render();
        return;
      }
      this.#setFailure(failure.code);
    } finally {
      if (this.#request === request) this.#request = null;
    }
  }

  public async forget(): Promise<void> {
    this.#abortRequest();
    this.#destroyRenderer();
    this.#verifiedGraph = null;
    const dependencies = this.#dependencies;
    const route = this.#route;
    this.#pairing = null;
    if (dependencies !== null && route !== null) {
      try {
        await dependencies.pairingStore.forget(route.graphId);
      } catch {
        this.#setFailure("storage-unavailable");
        return;
      }
    }
    this.#state = reduceAppState(this.#state, { type: "forgotten" });
    this.#render();
  }

  public dispose(): void {
    this.#abortRequest();
    this.#destroyRenderer();
    this.#verifiedGraph = null;
    this.#pairing = null;
    this.#state = { kind: "locked", reason: "unpaired" };
    this.#render();
  }

  public get state(): AppState {
    return this.#state;
  }

  public get route(): GraphRoute | null {
    return this.#route;
  }

  #setFailure(code: SafeGraphErrorCode): void {
    this.#state = reduceAppState(this.#state, { type: "snapshot-failed", code, retryable: retryable(code) });
    this.#render();
  }

  #abortRequest(): void {
    this.#request?.abort();
    this.#request = null;
  }

  #destroyRenderer(): void {
    this.#renderer?.destroy();
    this.#renderer = null;
  }

  #render(): void {
    this.#view.render(this.#state, this.#route);
  }
}
