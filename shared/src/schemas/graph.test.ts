import { describe, expect, it } from "vitest";
import type { GraphProjectionV1 } from "../contracts/graph";
import { MAX_GRAPH_EDGES, MAX_GRAPH_NODES, parseGraphEnvelope, parseGraphProjection } from "./graph";

const INSTALLATION_ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";

function graphFixture(): GraphProjectionV1 {
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    nodes: [
      {
        id: "node-a",
        label: "A",
        path: "Notes/A.md",
        kind: "note",
        domain: "research",
        tags: ["research"],
        notionUrl: "https://www.notion.so/fixture-a",
        obsidianUrl: "obsidian://open?vault=Fixture&file=Notes%2FA.md",
        collapsed: false,
      },
      {
        id: "node-b",
        label: "B",
        path: null,
        kind: "cluster",
        domain: "project",
        tags: [],
        notionUrl: null,
        obsidianUrl: null,
        collapsed: true,
      },
    ],
    edges: [{ id: "edge-a-b", source: "node-a", target: "node-b", kind: "cluster" }],
    conflicts: 0,
  };
}

describe("graph projection schema", () => {
  it("accepts the exact v1 graph shape and rejects unknown fields", () => {
    const graph = graphFixture();

    expect(parseGraphProjection(graph)).toEqual(graph);
    expect(() => parseGraphProjection({ ...graph, extra: true })).toThrow(/unrecognized/i);
  });

  it("rejects malformed versions and graph URLs with disallowed schemes", () => {
    const graph = graphFixture();
    expect(() => parseGraphProjection({ ...graph, schemaVersion: 2 })).toThrow(/schemaVersion/i);

    const invalidNotionUrl = graphFixture();
    invalidNotionUrl.nodes[0]!.notionUrl = "http://www.notion.so/fixture-a";
    expect(() => parseGraphProjection(invalidNotionUrl)).toThrow(/notionUrl/i);

    const invalidObsidianUrl = graphFixture();
    invalidObsidianUrl.nodes[0]!.obsidianUrl = "https://graph.example.test/note-a";
    expect(() => parseGraphProjection(invalidObsidianUrl)).toThrow(/obsidianUrl/i);
  });

  it("caps graph node and edge collections before they become unbounded payloads", () => {
    const graph = graphFixture();
    const tooManyNodes = {
      ...graph,
      nodes: Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, index) => ({ ...graph.nodes[0]!, id: `node-${index}` })),
      edges: [],
    };
    expect(() => parseGraphProjection(tooManyNodes)).toThrow(/node|too big|max/i);

    const tooManyEdges = {
      ...graph,
      edges: Array.from({ length: MAX_GRAPH_EDGES + 1 }, (_, index) => ({
        id: `edge-${index}`,
        source: "node-a",
        target: "node-b",
        kind: "cluster" as const,
      })),
    };
    expect(() => parseGraphProjection(tooManyEdges)).toThrow(/edge|too big|max/i);
  });

  it("rejects duplicate node and edge identifiers", () => {
    const duplicateNode = graphFixture();
    duplicateNode.nodes.push({ ...duplicateNode.nodes[0]! });
    expect(() => parseGraphProjection(duplicateNode)).toThrow(/duplicate.*node|node.*duplicate/i);

    const duplicateEdge = graphFixture();
    duplicateEdge.edges.push({ ...duplicateEdge.edges[0]! });
    expect(() => parseGraphProjection(duplicateEdge)).toThrow(/duplicate.*edge|edge.*duplicate/i);
  });

  it("rejects an envelope nonce that cannot represent exactly 12 AES-GCM bytes", () => {
    expect(() =>
      parseGraphEnvelope({
        version: 1,
        algorithm: "A256GCM",
        installationId: INSTALLATION_ID,
        keyId: "key-2",
        sequence: 0,
        createdAt: "2026-07-14T12:00:00.000Z",
        nonce: "A".repeat(15),
        ciphertext: "AA",
      }),
    ).toThrow(/nonce/i);
  });
});
