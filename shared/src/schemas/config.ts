import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 hash");

const notionConfigSchema = z
  .object({
    parentPageId: z.uuid(),
    dashboardPageId: z.uuid(),
    databaseId: z.uuid(),
    dataSourceId: z.uuid(),
  })
  .strict()
  .readonly();

const relayConfigSchema = z
  .object({
    baseUrl: z.url(),
  })
  .strict()
  .readonly();

const graphDomainSchema = z
  .object({
    pathPrefix: z.string().min(1),
    domain: z.enum(["academic", "research", "project", "personal", "other"]),
  })
  .strict()
  .readonly();

const graphConfigSchema = z
  .object({
    graphId: z.string().min(1),
    webOrigin: z.url().nullable(),
    domains: z.array(graphDomainSchema).readonly(),
  })
  .strict()
  .readonly();

export const bridgeConfigV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    installationId: z.uuid(),
    vaultRoot: z.string().min(1),
    vaultFingerprint: sha256Schema,
    notion: notionConfigSchema.nullable(),
    relay: relayConfigSchema.nullable(),
    graph: graphConfigSchema.nullable(),
  })
  .strict()
  .readonly();

export type ParsedBridgeConfigV1 = z.infer<typeof bridgeConfigV1Schema>;

export function parseBridgeConfig(input: unknown): ParsedBridgeConfigV1 {
  return bridgeConfigV1Schema.parse(input);
}
