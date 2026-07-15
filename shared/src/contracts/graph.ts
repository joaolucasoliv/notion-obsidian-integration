export interface GraphNodeV1 {
  id: string;
  label: string;
  path: string | null;
  kind: "vault" | "cluster" | "note";
  domain: "github" | "academic" | "research" | "project" | "personal" | "other";
  tags: string[];
  notionUrl: string | null;
  obsidianUrl: string | null;
  collapsed: boolean;
}

export interface GraphEdgeV1 {
  id: string;
  source: string;
  target: string;
  kind: "wikilink" | "markdown-link" | "cluster" | "vault";
}

export interface GraphProjectionV1 {
  schemaVersion: 1;
  installationId: string;
  nodes: GraphNodeV1[];
  edges: GraphEdgeV1[];
  conflicts: number;
}

export interface GraphDocumentV1 extends GraphProjectionV1 {
  sequence: number;
  generatedAt: string;
}

export interface GraphEnvelopeV1 {
  version: 1;
  algorithm: "A256GCM";
  installationId: string;
  keyId: string;
  sequence: number;
  createdAt: string;
  nonce: string;
  ciphertext: string;
}
