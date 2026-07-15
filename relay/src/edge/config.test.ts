import { describe, expect, it } from "vitest";
import { EdgeRuntimeConfigurationError, parseEdgeRuntimeConfiguration } from "./config.js";

const INSTALLATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_ROLE_KEY = "server-only-service-role-fixture-value";
const RELAY_TOKEN_PEPPER = "server-only-relay-token-pepper";
const WEBHOOK_TOKEN = "server-only-webhook-token";

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    RELAY_TOKEN_PEPPER,
    RELAY_WEBHOOK_TOKENS_JSON: JSON.stringify({ [INSTALLATION_ID]: WEBHOOK_TOKEN }),
    ...overrides,
  };
}

describe("Edge runtime configuration", () => {
  it("parses only server-provided, installation-scoped configuration", () => {
    const parsed = parseEdgeRuntimeConfiguration(environment());

    expect(parsed.supabaseUrl).toBe("http://127.0.0.1:54321");
    expect(parsed.serviceRoleKey).toBe(SERVICE_ROLE_KEY);
    expect(parsed.relayTokenPepper).toBe(RELAY_TOKEN_PEPPER);
    expect(parsed.verificationToken(INSTALLATION_ID)).toBe(WEBHOOK_TOKEN);
    expect(parsed.verificationToken("22222222-2222-4222-8222-222222222222")).toBeNull();
  });

  it("accepts the explicit relay-only service-role alias when the runtime withholds SUPABASE_ secrets", () => {
    const parsed = parseEdgeRuntimeConfiguration(environment({
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      RELAY_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    }));

    expect(parsed.serviceRoleKey).toBe(SERVICE_ROLE_KEY);
  });

  it.each([
    ["missing relay pepper", { RELAY_TOKEN_PEPPER: undefined }],
    ["missing service role", { SUPABASE_SERVICE_ROLE_KEY: undefined }],
    ["credential-bearing service URL", { SUPABASE_URL: "https://user:password@example.test" }],
    ["non-http service URL", { SUPABASE_URL: "file:///private/server" }],
    ["malformed token map", { RELAY_WEBHOOK_TOKENS_JSON: "{" }],
    ["duplicate token-map key", { RELAY_WEBHOOK_TOKENS_JSON: `{"${INSTALLATION_ID}":"one","${INSTALLATION_ID}":"two"}` }],
    ["noncanonical installation key", { RELAY_WEBHOOK_TOKENS_JSON: JSON.stringify({ [INSTALLATION_ID.toUpperCase()]: WEBHOOK_TOKEN }) }],
    ["empty verification token", { RELAY_WEBHOOK_TOKENS_JSON: JSON.stringify({ [INSTALLATION_ID]: "" }) }],
  ] as const)("fails closed for %s without echoing a server secret", (_label, overrides) => {
    try {
      parseEdgeRuntimeConfiguration(environment(overrides));
      throw new Error("Expected configuration to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(EdgeRuntimeConfigurationError);
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(SERVICE_ROLE_KEY);
      expect(message).not.toContain(RELAY_TOKEN_PEPPER);
      expect(message).not.toContain(WEBHOOK_TOKEN);
    }
  });
});
