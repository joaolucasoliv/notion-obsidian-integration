import type { GraphDocumentV1 } from "@grandbox-bridge/shared";
import type { GraphRendererHandle } from "../app/controller.ts";
import { createBrowserForceLayout, type ForceLayoutHandle } from "./force-layout.ts";
import { buildGraphModel, type GraphEdgeAttributes, type GraphModel, type GraphNodeAttributes } from "./build-graph.ts";
import {
  defaultGraphVisibility,
  type GithubVisibilityLevel,
  type GraphVisibilityState,
  visibleGraph,
} from "./visibility.ts";

export interface GraphRendererSigma {
  onClickNode(listener: (nodeId: string) => void): void;
  refresh(): void;
  kill(): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
}

export interface GraphRendererSigmaFactory {
  create(
    graph: GraphModel["graph"],
    container: HTMLElement,
  ): GraphRendererSigma;
}

export interface GraphRendererInput {
  readonly container: HTMLElement;
  readonly createSigma: GraphRendererSigmaFactory;
  readonly createLayout?: (model: GraphModel) => ForceLayoutHandle;
  readonly reducedMotion?: boolean;
  readonly openExternal?: (url: string, target: string, features: string) => void;
  readonly onSelection?: (node: GraphNodeAttributes | null) => void;
  readonly onVisibility?: (model: GraphModel, state: GraphVisibilityState) => void;
}

function defaultOpenExternal(url: string, target: string, features: string): void {
  window.open(url, target, features);
}

/** Canvas renderer for an already accepted graph. Node activation never navigates. */
export class GraphRenderer implements GraphRendererHandle {
  readonly #container: HTMLElement;
  readonly #createSigma: GraphRendererSigmaFactory;
  readonly #createLayout: (model: GraphModel) => ForceLayoutHandle;
  readonly #openExternal: (url: string, target: string, features: string) => void;
  readonly #onSelection: ((node: GraphNodeAttributes | null) => void) | undefined;
  readonly #onVisibility: ((model: GraphModel, state: GraphVisibilityState) => void) | undefined;
  #model: GraphModel | null = null;
  #sigma: GraphRendererSigma | null = null;
  #layout: ForceLayoutHandle | null = null;
  #visibility: GraphVisibilityState = defaultGraphVisibility();
  #selectedNodeId: string | null = null;

  public constructor(input: GraphRendererInput) {
    this.#container = input.container;
    this.#createSigma = input.createSigma;
    this.#createLayout = input.createLayout ?? ((model) => createBrowserForceLayout(model.graph, input.reducedMotion ?? false));
    this.#openExternal = input.openExternal ?? defaultOpenExternal;
    this.#onSelection = input.onSelection;
    this.#onVisibility = input.onVisibility;
  }

  public replace(document: GraphDocumentV1): void {
    this.#disposeCurrent();
    this.#model = buildGraphModel(document);
    this.#visibility = defaultGraphVisibility();
    this.#selectedNodeId = null;
    this.#sigma = this.#createSigma.create(this.#model.graph, this.#container);
    this.#sigma.onClickNode((nodeId) => this.selectNode(nodeId));
    this.#layout = this.#createLayout(this.#model);
    this.#applyVisibility();
    this.#layout.startAfterFirstPaint();
  }

  public destroy(): void {
    this.#disposeCurrent();
    this.#model = null;
    this.#selectedNodeId = null;
    this.#onSelection?.(null);
  }

  public selectNode(nodeId: string): void {
    if (this.#model === null || !this.#model.graph.hasNode(nodeId)) return;
    this.#selectedNodeId = nodeId;
    this.#onSelection?.(this.#model.graph.getNodeAttributes(nodeId));
  }

  public openSelected(destination: "notion" | "obsidian"): void {
    if (this.#selectedNodeId === null || this.#model === null) return;
    const node = this.#model.graph.getNodeAttributes(this.#selectedNodeId);
    const url = destination === "notion" ? node.notionUrl : node.obsidianUrl;
    if (url === null) return;
    this.#openExternal(url, "_blank", "noopener,noreferrer");
  }

  public setGithubLevel(githubLevel: GithubVisibilityLevel): void {
    this.#visibility = { ...this.#visibility, githubLevel };
    this.#applyVisibility();
  }

  public setSearch(search: string): void {
    this.#visibility = { ...this.#visibility, search: search.trim() };
    this.#applyVisibility();
  }

  public setDomains(domains: ReadonlySet<GraphNodeAttributes["domain"]>): void {
    this.#visibility = { ...this.#visibility, domains: new Set(domains) };
    this.#applyVisibility();
  }

  public focus(nodeId: string | null): void {
    this.#visibility = { ...this.#visibility, focusNodeId: nodeId };
    this.#applyVisibility();
  }

  public clearFocus(): void {
    this.focus(null);
  }

  public zoomIn(): void {
    this.#sigma?.zoomIn();
  }

  public zoomOut(): void {
    this.#sigma?.zoomOut();
  }

  public resetZoom(): void {
    this.#sigma?.resetZoom();
  }

  public get document(): GraphDocumentV1 {
    if (this.#model === null) throw new Error("No graph is currently rendered");
    return this.#model.document;
  }

  public get visibleNodeIds(): ReadonlySet<string> {
    if (this.#model === null) return new Set();
    return visibleGraph(this.#model.document, this.#visibility).nodeIds;
  }

  public get visibleNodes(): readonly GraphNodeAttributes[] {
    if (this.#model === null) return [];
    const visible = visibleGraph(this.#model.document, this.#visibility).nodeIds;
    return [...visible]
      .sort()
      .map((nodeId) => this.#model?.graph.getNodeAttributes(nodeId))
      .filter((node): node is GraphNodeAttributes => node !== undefined);
  }

  #applyVisibility(): void {
    if (this.#model === null) return;
    const visible = visibleGraph(this.#model.document, this.#visibility);
    for (const nodeId of this.#model.graph.nodes()) {
      this.#model.graph.setNodeAttribute(nodeId, "hidden", !visible.nodeIds.has(nodeId));
    }
    for (const edgeId of this.#model.graph.edges()) {
      this.#model.graph.setEdgeAttribute(edgeId, "hidden", !visible.edgeIds.has(edgeId));
    }
    this.#sigma?.refresh();
    this.#onVisibility?.(this.#model, this.#visibility);
  }

  #disposeCurrent(): void {
    this.#layout?.stop();
    this.#layout?.kill();
    this.#layout = null;
    this.#sigma?.kill();
    this.#sigma = null;
  }
}
