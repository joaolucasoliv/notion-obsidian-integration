import type { GraphNodeV1 } from "@grandbox-bridge/shared";

export interface InitialPosition {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

const domainCenters: Readonly<Record<GraphNodeV1["domain"], readonly [number, number]>> = Object.freeze({
  github: [12, -8],
  academic: [-12, -7],
  research: [-10, 10],
  project: [10, 9],
  personal: [0, 13],
  other: [0, -12],
});

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const codePoint of value) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function nodeSize(node: GraphNodeV1): number {
  if (node.kind === "vault") return 13;
  if (node.kind === "cluster") return 8;
  return 4;
}

export function initialPosition(node: GraphNodeV1): InitialPosition {
  if (node.kind === "vault") return { x: 0, y: 0, size: nodeSize(node) };

  const [centerX, centerY] = domainCenters[node.domain];
  const hash = stableHash(`${node.domain}\0${node.id}`);
  const angle = (hash % 360) * (Math.PI / 180);
  const radius = node.kind === "cluster" ? 4 + ((hash >>> 10) % 3) : 7 + ((hash >>> 10) % 7);
  const x = centerX + Math.cos(angle) * radius;
  const y = centerY + Math.sin(angle) * radius;
  return {
    x: x === 0 ? 0.001 : x,
    y: y === 0 ? 0.001 : y,
    size: nodeSize(node),
  };
}
