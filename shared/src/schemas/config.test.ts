import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "./config";

const ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";
const PAGE_ID = "59833787-2cf9-4fdf-8782-e53db20768a5";
const HASH = "727315411367e16793c5140eedbe2371b9619a47ce90e2b3e3b3704e2e725adc";

function validConfig() {
  return {
    schemaVersion: 1,
    installationId: ID,
    vaultRoot: "/Users/example/The Grandbox",
    vaultFingerprint: HASH,
    notion: {
      parentPageId: PAGE_ID,
      dashboardPageId: PAGE_ID,
      databaseId: PAGE_ID,
      dataSourceId: PAGE_ID,
    },
    relay: { baseUrl: "https://relay.example.test" },
    graph: {
      graphId: "primary-graph",
      webOrigin: "https://graph.example.test",
      domains: [{ pathPrefix: "Research/", domain: "research" }],
    },
  };
}

describe("parseBridgeConfig", () => {
  it("accepts the exact v1 shape including unconfigured nullable services", () => {
    const configured = validConfig();
    expect(parseBridgeConfig(configured)).toEqual(configured);

    const unconfigured = { ...configured, notion: null, relay: null, graph: null };
    expect(parseBridgeConfig(unconfigured)).toEqual(unconfigured);
  });

  it("rejects unknown root and nested keys", () => {
    expect(() => parseBridgeConfig({ ...validConfig(), extra: true })).toThrow(/unrecognized/i);

    const nested = validConfig();
    Object.assign(nested.graph.domains[0], { extra: true });
    expect(() => parseBridgeConfig(nested)).toThrow(/unrecognized/i);
  });

  it("rejects unsupported versions, malformed UUIDs, hashes, URLs, and domains", () => {
    expect(() => parseBridgeConfig({ ...validConfig(), schemaVersion: 2 })).toThrow(/schemaVersion/i);
    expect(() => parseBridgeConfig({ ...validConfig(), installationId: "not-a-uuid" })).toThrow(/installationId/i);
    expect(() => parseBridgeConfig({ ...validConfig(), vaultFingerprint: "not-a-hash" })).toThrow(/vaultFingerprint/i);

    const malformedPage = validConfig();
    malformedPage.notion.parentPageId = "not-a-uuid";
    expect(() => parseBridgeConfig(malformedPage)).toThrow(/parentPageId/i);

    const malformedUrl = validConfig();
    malformedUrl.relay.baseUrl = "not-a-url";
    expect(() => parseBridgeConfig(malformedUrl)).toThrow(/baseUrl/i);

    const malformedDomain = validConfig();
    malformedDomain.graph.domains[0].domain = "finance";
    expect(() => parseBridgeConfig(malformedDomain)).toThrow(/domain/i);
  });
});
