import type { GraphDocumentV1, GraphNodeV1 } from "@grandbox-bridge/shared";

export type GithubVisibilityLevel = "collapsed" | "repositories" | "activities";

export interface GraphVisibilityState {
  readonly githubLevel: GithubVisibilityLevel;
  readonly domains: ReadonlySet<GraphNodeV1["domain"]>;
  readonly search: string;
  readonly focusNodeId: string | null;
}

export interface VisibleGraph {
  readonly nodeIds: ReadonlySet<string>;
  readonly edgeIds: ReadonlySet<string>;
}

const allDomains: readonly GraphNodeV1["domain"][] = ["github", "academic", "research", "project", "personal", "other"];

export function defaultGraphVisibility(): GraphVisibilityState {
  return {
    githubLevel: "collapsed",
    domains: new Set(allDomains),
    search: "",
    focusNodeId: null,
  };
}

function matchesSearch(node: GraphNodeV1, search: string): boolean {
  if (search.length === 0) return true;
  const needle = search.toLocaleLowerCase();
  return [node.label, node.path ?? "", ...node.tags].some((value) => value.toLocaleLowerCase().includes(needle));
}

function githubVisible(node: GraphNodeV1, level: GithubVisibilityLevel): boolean {
  if (node.domain !== "github" || node.kind !== "note") return true;
  if (level === "collapsed") return false;
  if (level === "repositories") return !node.collapsed;
  return true;
}

function addAncestors(document: GraphDocumentV1, nodeIds: Set<string>, focusNodeId: string): void {
  const pending = [focusNodeId];
  const inspected = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || inspected.has(current)) continue;
    inspected.add(current);
    for (const edge of document.edges) {
      if (edge.target !== current) continue;
      nodeIds.add(edge.source);
      pending.push(edge.source);
    }
  }
}

/** Computes a pure visibility projection; it never deletes graph nodes or edges. */
export function visibleGraph(document: GraphDocumentV1, state: GraphVisibilityState): VisibleGraph {
  const nodeIds = new Set<string>();
  for (const node of document.nodes) {
    const isVault = node.kind === "vault";
    if (!isVault && !state.domains.has(node.domain)) continue;
    if (!isVault && !githubVisible(node, state.githubLevel)) continue;
    if (!isVault && !matchesSearch(node, state.search)) continue;
    nodeIds.add(node.id);
  }

  if (state.focusNodeId !== null && nodeIds.has(state.focusNodeId)) {
    addAncestors(document, nodeIds, state.focusNodeId);
  }

  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) edgeIds.add(edge.id);
  }
  return { nodeIds, edgeIds };
}
