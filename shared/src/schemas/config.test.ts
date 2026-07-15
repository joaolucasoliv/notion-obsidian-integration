import { describe, expect, it } from "vitest";
import unsafeUrls from "../../../tests/fixtures/safe/unsafe-urls.json";
import { parseBridgeConfig } from "./config";

const ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";
const PAGE_ID = "59833787-2cf9-4fdf-8782-e53db20768a5";
const HASH = "727315411367e16793c5140eedbe2371b9619a47ce90e2b3e3b3704e2e725adc";
const ASCII_CONTROL_SPACE_CODES = [...Array.from({ length: 33 }, (_, codePoint) => codePoint), 0x7f];

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
      keyId: "key-2026-07",
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

    const missingKeyId = validConfig();
    delete (missingKeyId.graph as { keyId?: string }).keyId;
    expect(() => parseBridgeConfig(missingKeyId)).toThrow(/keyId/i);
  });

  it.each([
    ["https://relay.example.test/functions/v1/bridge", "https://graph.example.test"],
    ["http://localhost:54321/functions/v1/bridge", "http://localhost:5173"],
    ["http://127.0.0.1:54321/functions/v1/bridge", "http://127.0.0.1:5173/"],
    ["http://[::1]:54321/functions/v1/bridge", "http://[::1]:5173"],
  ])("accepts approved relay URL %s and graph origin %s", (baseUrl, webOrigin) => {
    const config = validConfig();
    config.relay.baseUrl = baseUrl;
    config.graph.webOrigin = webOrigin;

    expect(parseBridgeConfig(config)).toEqual(config);
  });

  it.each([
    "http://relay.example.test/functions/v1/bridge",
    "ftp://relay.example.test/functions/v1/bridge",
    unsafeUrls.credentialBearingHttps,
    "https://@relay.example.test/functions/v1/bridge",
    "https:relay.example.test/functions/v1/bridge",
    " https://relay.example.test/functions/v1/bridge ",
    "https://relay.example.test\\functions/v1/bridge",
    "https://relay.example.test/functions/v1/bridge?",
    "https://relay.example.test/functions/v1/bridge?cursor=value",
    "https://relay.example.test/functions/v1/bridge#",
    "https://relay.example.test/functions/v1/bridge#fragment",
  ])("rejects unsafe persisted relay URL %s", (baseUrl) => {
    const config = validConfig();
    config.relay.baseUrl = baseUrl;

    expect(() => parseBridgeConfig(config)).toThrow(/baseUrl/i);
  });

  it.each(ASCII_CONTROL_SPACE_CODES)("rejects raw ASCII control/space U+%i in relay URLs", (codePoint) => {
    const config = validConfig();
    const unsafeCharacter = String.fromCharCode(codePoint);
    config.relay.baseUrl = `https://relay.example.test/functions${unsafeCharacter}v1/bridge`;

    expect(() => parseBridgeConfig(config)).toThrow(/baseUrl/i);
  });

  it.each([
    "https://relay.example.test/a/../functions/v1/bridge",
    "https://relay.example.test/a/%2e%2e/functions/v1/bridge",
    "https://relay.example.test/functions/./v1/bridge",
    "HTTPS://RELAY.EXAMPLE.TEST/functions/v1/bridge",
    "https://relay.example.test:443/functions/v1/bridge",
    "http://LOCALHOST:54321/functions/v1/bridge",
  ])("rejects parser-normalized noncanonical relay URL %s", (baseUrl) => {
    const config = validConfig();
    config.relay.baseUrl = baseUrl;

    expect(() => parseBridgeConfig(config)).toThrow(/baseUrl/i);
  });

  it.each([
    "https://relay.example.test",
    "https://relay.example.test/",
    "https://relay.example.test:8443/functions/v1/bridge",
    "http://localhost:54321/functions/v1/bridge",
  ])("accepts canonical relay URL %s", (baseUrl) => {
    const config = validConfig();
    config.relay.baseUrl = baseUrl;

    expect(parseBridgeConfig(config).relay?.baseUrl).toBe(baseUrl);
  });

  it.each([
    "http://graph.example.test",
    "file:///tmp/graph",
    unsafeUrls.credentialBearingOrigin,
    " https://graph.example.test ",
    "https://graph.example.test\\path",
    "https://graph.example.test/.",
    "https://graph.example.test/path",
    "https://graph.example.test?",
    "https://graph.example.test?view=all",
    "https://graph.example.test#",
    "https://graph.example.test#fragment",
  ])("rejects unsafe or non-origin persisted graph URL %s", (webOrigin) => {
    const config = validConfig();
    config.graph.webOrigin = webOrigin;

    expect(() => parseBridgeConfig(config)).toThrow(/webOrigin/i);
  });
});
