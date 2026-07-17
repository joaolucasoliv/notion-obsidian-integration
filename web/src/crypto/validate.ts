import type { GraphDocumentV1, GraphNodeV1 } from "@grandbox-bridge/shared";

export interface GraphLimits {
  readonly ciphertextBytes: number;
  readonly decompressedBytes: number;
  readonly nodes: number;
  readonly edges: number;
  readonly identifierBytes: number;
  readonly labelBytes: number;
  readonly pathBytes: number;
  readonly tagsPerNode: number;
}

export const GRAPH_LIMITS: Readonly<GraphLimits> = Object.freeze({
  ciphertextBytes: 8_388_608,
  decompressedBytes: 16_777_216,
  nodes: 20_000,
  edges: 80_000,
  identifierBytes: 160,
  labelBytes: 512,
  pathBytes: 1_024,
  tagsPerNode: 64,
});

export class InvalidGraphDocumentError extends Error {}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assert(condition: boolean): asserts condition {
  if (!condition) throw new InvalidGraphDocumentError();
}

function validNotionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "www.notion.so" || url.hostname === "notion.so") &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

function validObsidianUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const queryKeys = [...url.searchParams.keys()];
    return (
      url.protocol === "obsidian:" &&
      url.hostname === "open" &&
      url.pathname.length === 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0 &&
      queryKeys.length === 2 &&
      queryKeys.includes("vault") &&
      queryKeys.includes("file") &&
      url.searchParams.getAll("vault").length === 1 &&
      url.searchParams.get("vault") === "The Grandbox" &&
      url.searchParams.getAll("file").length === 1 &&
      (url.searchParams.get("file")?.length ?? 0) > 0
    );
  } catch {
    return false;
  }
}

function validateNode(node: GraphNodeV1, limits: GraphLimits): void {
  assert(byteLength(node.id) <= limits.identifierBytes);
  assert(byteLength(node.label) <= limits.labelBytes);
  assert(node.path === null || byteLength(node.path) <= limits.pathBytes);
  assert(node.tags.length <= limits.tagsPerNode);
  for (const tag of node.tags) assert(byteLength(tag) <= limits.identifierBytes);
  assert(node.notionUrl === null || validNotionUrl(node.notionUrl));
  assert(node.obsidianUrl === null || validObsidianUrl(node.obsidianUrl));
}

/** Runs after strict schema parsing and before any graph value reaches the renderer. */
export function validateGraphDocument(document: GraphDocumentV1, limits: GraphLimits): GraphDocumentV1 {
  assert(document.nodes.length <= limits.nodes);
  assert(document.edges.length <= limits.edges);

  const nodeIds = new Set<string>();
  for (const node of document.nodes) {
    assert(!nodeIds.has(node.id));
    nodeIds.add(node.id);
    validateNode(node, limits);
  }

  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    assert(!edgeIds.has(edge.id));
    edgeIds.add(edge.id);
    assert(byteLength(edge.id) <= limits.identifierBytes);
    assert(byteLength(edge.source) <= limits.identifierBytes);
    assert(byteLength(edge.target) <= limits.identifierBytes);
    assert(nodeIds.has(edge.source));
    assert(nodeIds.has(edge.target));
  }

  return document;
}
