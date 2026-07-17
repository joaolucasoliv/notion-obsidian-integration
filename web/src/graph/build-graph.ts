import { MultiGraph } from "graphology";
import type { GraphDocumentV1, GraphEdgeV1, GraphNodeV1 } from "@grandbox-bridge/shared";
import { initialPosition } from "./initial-layout.ts";
import { defaultGraphVisibility, visibleGraph } from "./visibility.ts";

export interface GraphNodeAttributes extends GraphNodeV1 {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: string;
  readonly hidden: boolean;
}

export interface GraphEdgeAttributes extends GraphEdgeV1 {
  readonly color: string;
  readonly size: number;
  readonly hidden: boolean;
}

export interface GraphModel {
  readonly graph: MultiGraph<GraphNodeAttributes, GraphEdgeAttributes>;
  readonly document: GraphDocumentV1;
  readonly visibleNodeIds: ReadonlySet<string>;
  readonly visibleEdgeIds: ReadonlySet<string>;
}

function validFinitePosition(position: ReturnType<typeof initialPosition>): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.size) || position.size <= 0) {
    throw new Error("Invalid deterministic graph position");
  }
}

function assertNoDuplicate(entries: readonly { readonly id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`Duplicate graph ${label} id`);
    ids.add(entry.id);
  }
}

const domainColors: Readonly<Record<GraphNodeV1["domain"], string>> = Object.freeze({
  github: "#6fa8ff",
  academic: "#d7a540",
  research: "#a585e8",
  project: "#62b78c",
  personal: "#d9879f",
  other: "#94a0ae",
});

/** Builds a fresh Graphology model only from an already verified immutable graph document. */
export function buildGraphModel(document: GraphDocumentV1): GraphModel {
  assertNoDuplicate(document.nodes, "node");
  assertNoDuplicate(document.edges, "edge");
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const graph = new MultiGraph<GraphNodeAttributes, GraphEdgeAttributes>();

  for (const node of document.nodes) {
    const position = initialPosition(node);
    validFinitePosition(position);
    graph.addNode(node.id, { ...node, ...position, color: domainColors[node.domain], hidden: false });
  }
  for (const edge of document.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) throw new Error("Graph edge endpoint is missing");
    graph.addEdgeWithKey(edge.id, edge.source, edge.target, { ...edge, color: "#59616b", size: 1, hidden: false });
  }

  const visibility = visibleGraph(document, defaultGraphVisibility());
  return { graph, document, visibleNodeIds: visibility.nodeIds, visibleEdgeIds: visibility.edgeIds };
}

export function exportPositions(graph: MultiGraph<GraphNodeAttributes, GraphEdgeAttributes>): Record<string, { x: number; y: number }> {
  return Object.fromEntries(
    graph.nodes().sort().map((id) => {
      const { x, y } = graph.getNodeAttributes(id);
      return [id, { x, y }];
    }),
  );
}
