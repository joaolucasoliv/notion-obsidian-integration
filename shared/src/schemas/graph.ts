import { z } from "zod";
import type { GraphDocumentV1, GraphEnvelopeV1, GraphProjectionV1 } from "../contracts/graph.js";

export const MAX_GRAPH_NODES = 10_000;
export const MAX_GRAPH_EDGES = 50_000;

const maxSafeIntegerSchema = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.string().max(64).datetime({ offset: true });
const graphIdentifierSchema = z.string().min(1).max(256);
const graphUrlSchema = (protocol: "https:" | "obsidian:", label: string) =>
  z.string().min(1).max(2_048).superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: `Expected a valid ${label}` });
      return;
    }
    if (url.protocol !== protocol) {
      context.addIssue({ code: "custom", message: `Expected a ${protocol} ${label}` });
    }
  });

export const graphNodeV1Schema = z
  .object({
    id: graphIdentifierSchema,
    label: z.string().min(1).max(1_024),
    path: z.string().min(1).max(1_024).nullable(),
    kind: z.enum(["vault", "cluster", "note"]),
    domain: z.enum(["github", "academic", "research", "project", "personal", "other"]),
    tags: z.array(z.string().min(1).max(256)).max(128),
    notionUrl: graphUrlSchema("https:", "notionUrl").nullable(),
    obsidianUrl: graphUrlSchema("obsidian:", "obsidianUrl").nullable(),
    collapsed: z.boolean(),
  })
  .strict();

export const graphEdgeV1Schema = z
  .object({
    id: graphIdentifierSchema,
    source: graphIdentifierSchema,
    target: graphIdentifierSchema,
    kind: z.enum(["wikilink", "markdown-link", "cluster", "vault"]),
  })
  .strict();

const graphProjectionObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    installationId: z.uuid(),
    nodes: z.array(graphNodeV1Schema).max(MAX_GRAPH_NODES),
    edges: z.array(graphEdgeV1Schema).max(MAX_GRAPH_EDGES),
    conflicts: maxSafeIntegerSchema,
  })
  .strict();

function rejectDuplicateIds(
  value: { readonly nodes: readonly { readonly id: string }[]; readonly edges: readonly { readonly id: string }[] },
  context: z.RefinementCtx,
): void {
  const check = (entries: readonly { readonly id: string }[], path: "nodes" | "edges", label: string): void => {
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry.id)) {
        context.addIssue({
          code: "custom",
          path: [path, index, "id"],
          message: `Duplicate ${label} id`,
        });
      }
      seen.add(entry.id);
    }
  };

  check(value.nodes, "nodes", "node");
  check(value.edges, "edges", "edge");
}

export const graphProjectionV1Schema = graphProjectionObjectSchema.superRefine(rejectDuplicateIds);

export const graphDocumentV1Schema = graphProjectionObjectSchema
  .extend({
    sequence: maxSafeIntegerSchema,
    generatedAt: timestampSchema,
  })
  .strict()
  .superRefine(rejectDuplicateIds);

const base64urlSchema = z.string().min(1).max(8 * 1024 * 1024).regex(/^[A-Za-z0-9_-]+$/);
const aesGcmNonceSchema = z.string().length(16).regex(/^[A-Za-z0-9_-]+$/);

export const graphEnvelopeV1Schema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("A256GCM"),
    installationId: z.uuid(),
    keyId: graphIdentifierSchema,
    sequence: maxSafeIntegerSchema,
    createdAt: timestampSchema,
    nonce: aesGcmNonceSchema,
    ciphertext: base64urlSchema,
  })
  .strict();

export function parseGraphProjection(input: unknown): GraphProjectionV1 {
  return graphProjectionV1Schema.parse(input);
}

export function parseGraphDocument(input: unknown): GraphDocumentV1 {
  return graphDocumentV1Schema.parse(input);
}

export function parseGraphEnvelope(input: unknown): GraphEnvelopeV1 {
  return graphEnvelopeV1Schema.parse(input);
}
