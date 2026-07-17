import type { GraphDocumentV1 } from "@grandbox-bridge/shared";

export const GRAPH_FIXTURE: GraphDocumentV1 = {
  schemaVersion: 1,
  installationId: "5c343dbe-23b1-4e13-af1e-ffed61ecb290",
  sequence: 42,
  generatedAt: "2026-07-15T12:00:00.000Z",
  conflicts: 1,
  nodes: [
    { id: "vault:root", label: "The Grandbox", path: null, kind: "vault", domain: "other", tags: [], notionUrl: null, obsidianUrl: null, collapsed: false },
    { id: "cluster:github", label: "GitHub", path: null, kind: "cluster", domain: "github", tags: [], notionUrl: null, obsidianUrl: null, collapsed: true },
    { id: "github:repository:nodal", label: "nodal", path: "Repositories/nodal.md", kind: "note", domain: "github", tags: ["github"], notionUrl: null, obsidianUrl: "obsidian://open?vault=The%20Grandbox&file=Repositories%2Fnodal.md", collapsed: false },
    { id: "github:branch:main", label: "main", path: "Repositories/nodal/main.md", kind: "note", domain: "github", tags: ["github", "branch"], notionUrl: null, obsidianUrl: "obsidian://open?vault=The%20Grandbox&file=Repositories%2Fnodal%2Fmain.md", collapsed: true },
    { id: "cluster:research", label: "Research", path: null, kind: "cluster", domain: "research", tags: [], notionUrl: null, obsidianUrl: null, collapsed: false },
    { id: "note:paired", label: "Paired note", path: "Research/Paired.md", kind: "note", domain: "research", tags: ["research"], notionUrl: "https://www.notion.so/2fba54e969b84ab28bca9487f960834b", obsidianUrl: "obsidian://open?vault=The%20Grandbox&file=Research%2FPaired.md", collapsed: false },
  ],
  edges: [
    { id: "edge:vault:github", source: "vault:root", target: "cluster:github", kind: "vault" },
    { id: "edge:github:repository", source: "cluster:github", target: "github:repository:nodal", kind: "cluster" },
    { id: "edge:repository:branch", source: "github:repository:nodal", target: "github:branch:main", kind: "cluster" },
    { id: "edge:vault:research", source: "vault:root", target: "cluster:research", kind: "vault" },
    { id: "edge:research:note", source: "cluster:research", target: "note:paired", kind: "cluster" },
  ],
};
