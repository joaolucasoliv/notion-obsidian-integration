import { describe, expect, it } from "vitest";
import { buildGraphModel, exportPositions } from "../src/graph/build-graph.ts";
import { GRAPH_FIXTURE } from "./fixtures.ts";

describe("buildGraphModel", () => {
  it("starts from deterministic nonzero positions with GitHub secondary nodes hidden", () => {
    const first = buildGraphModel(GRAPH_FIXTURE);
    const second = buildGraphModel(GRAPH_FIXTURE);

    expect(exportPositions(first.graph)).toEqual(exportPositions(second.graph));
    expect(first.graph.getNodeAttributes("vault:root").label).toBe("The Grandbox");
    expect(first.graph.getNodeAttributes("vault:root").x).toBe(0);
    expect(first.graph.getNodeAttributes("vault:root").y).toBe(0);
    expect(first.visibleNodeIds).toContain("cluster:github");
    expect(first.visibleNodeIds).not.toContain("github:repository:nodal");
    expect(first.visibleNodeIds).not.toContain("github:branch:main");
  });

  it("defends the renderer from duplicate IDs and dangling edges", () => {
    expect(() => buildGraphModel({ ...GRAPH_FIXTURE, nodes: [...GRAPH_FIXTURE.nodes, GRAPH_FIXTURE.nodes[0]!] })).toThrow(/duplicate/i);
    expect(() => buildGraphModel({ ...GRAPH_FIXTURE, edges: [{ ...GRAPH_FIXTURE.edges[0]!, target: "missing" }] })).toThrow(/edge|endpoint/i);
  });
});
