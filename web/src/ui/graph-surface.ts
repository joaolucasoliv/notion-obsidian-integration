import type { GraphNodeAttributes } from "../graph/build-graph.ts";
import type { GithubVisibilityLevel } from "../graph/visibility.ts";
import { createGraphToolbar, type GraphToolbar } from "./graph-toolbar.ts";
import { createNodeInspector, type NodeInspector } from "./node-inspector.ts";
import { createStatusStrip, type StatusStrip } from "./status-strip.ts";
import type { Theme } from "./theme.ts";

export interface GraphSurfaceActions {
  readonly search: (value: string) => void;
  readonly selectNode: (nodeId: string) => void;
  readonly setGithubLevel: (level: GithubVisibilityLevel) => void;
  readonly setDomains: (domains: ReadonlySet<GraphNodeAttributes["domain"]>) => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly clearFocus: () => void;
  readonly openNotion: () => void;
  readonly openObsidian: () => void;
  readonly refresh: () => void;
  readonly forget: () => void;
  readonly toggleTheme: () => void;
}

export interface GraphSurface {
  readonly canvas: HTMLElement;
  readonly toolbar: GraphToolbar;
  readonly inspector: NodeInspector;
  readonly status: StatusStrip;
}

export function createGraphSurface(root: HTMLElement, actions: GraphSurfaceActions, theme: Theme): GraphSurface {
  const shell = document.createElement("main");
  shell.className = "graph-shell";
  const header = document.createElement("header");
  const title = document.createElement("h1");
  title.textContent = "The Grandbox";
  const subtitle = document.createElement("p");
  subtitle.textContent = "Private graph";
  header.append(title, subtitle);
  shell.append(header);

  const controls = document.createElement("div");
  controls.className = "graph-shell__controls";
  shell.append(controls);
  const canvas = document.createElement("div");
  canvas.className = "graph-canvas";
  canvas.dataset.testid = "graph-canvas";
  canvas.setAttribute("aria-label", "Private knowledge graph");
  shell.append(canvas);
  const inspectorRoot = document.createElement("div");
  inspectorRoot.className = "graph-shell__inspector";
  shell.append(inspectorRoot);
  const statusRoot = document.createElement("div");
  shell.append(statusRoot);
  root.replaceChildren(shell);

  return {
    canvas,
    toolbar: createGraphToolbar(controls, actions, theme),
    inspector: createNodeInspector(inspectorRoot, { openNotion: actions.openNotion, openObsidian: actions.openObsidian }),
    status: createStatusStrip(statusRoot),
  };
}
