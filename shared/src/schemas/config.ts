import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 hash");
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function persistedWebUrlSchema(options: { bareOrigin: boolean }) {
  return z.string().superRefine((value, context) => {
    if (/[\u0000-\u0020\u007f\\]/.test(value)) {
      context.addIssue({ code: "custom", message: "Expected a canonical web URL without raw whitespace" });
      return;
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Expected a valid web URL" });
      return;
    }

    const schemeDelimiterIndex = value.indexOf("://");
    const afterScheme = schemeDelimiterIndex < 0 ? "" : value.slice(schemeDelimiterIndex + 3);
    const authorityEnd = afterScheme.search(/[/?#]/);
    const authority = (authorityEnd < 0 ? afterScheme : afterScheme.slice(0, authorityEnd)).toLowerCase();
    const remainder = authorityEnd < 0 ? "" : afterScheme.slice(authorityEnd);
    const rawHost = authority.startsWith("[")
      ? authority.slice(0, authority.indexOf("]") + 1)
      : authority.split(":", 1)[0] ?? "";
    const approvedProtocol =
      schemeDelimiterIndex > 0 &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(rawHost)));
    const hasForbiddenComponents =
      authority.includes("@") ||
      url.username !== "" ||
      url.password !== "" ||
      remainder.includes("?") ||
      remainder.includes("#");
    const isBareOrigin =
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === "";
    const matchesCanonicalUrl = value === url.href || (isBareOrigin && value === url.origin);
    const isCanonicalOrigin = isBareOrigin && (value === url.origin || value === `${url.origin}/`);
    const hasForbiddenPath = options.bareOrigin && !isCanonicalOrigin;

    if (!approvedProtocol || hasForbiddenComponents || !matchesCanonicalUrl || hasForbiddenPath) {
      context.addIssue({ code: "custom", message: "Expected an approved credential-free web URL" });
    }
  });
}

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
    baseUrl: persistedWebUrlSchema({ bareOrigin: false }),
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
    webOrigin: persistedWebUrlSchema({ bareOrigin: true }).nullable(),
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
