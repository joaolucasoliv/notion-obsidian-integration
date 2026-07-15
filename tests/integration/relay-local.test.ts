import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

const relayUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const jwtSecret = process.env.SUPABASE_JWT_SECRET;
const tableNames = ["bridge_installation", "synced_page_registry", "webhook_event", "graph_snapshot"] as const;

function requiredEnvironment(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}; run this suite with npm run test:integration`);
  }
  return value;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function authenticatedToken(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const encodedHeader = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const encodedPayload = base64url(encoder.encode(JSON.stringify({
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1_000) + 60,
    role: "authenticated",
    sub: crypto.randomUUID(),
  })));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

describe("local relay database", () => {
  it("applies the ciphertext-only schema and denies direct anon/authenticated table reads", async () => {
    const url = requiredEnvironment(relayUrl, "SUPABASE_URL");
    const anon = requiredEnvironment(anonKey, "SUPABASE_ANON_KEY");
    const serviceRole = requiredEnvironment(serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY");
    const jwt = await authenticatedToken(requiredEnvironment(jwtSecret, "SUPABASE_JWT_SECRET"));
    const service = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
    const installationId = crypto.randomUUID();

    const seeded = await service.from("bridge_installation").insert({
      id: installationId,
      graph_id: crypto.randomUUID(),
      relay_token_hash: "synthetic-hash-only",
      graph_key_id: "synthetic-key-id",
    });
    expect(seeded.error).toBeNull();

    for (const token of [anon, jwt]) {
      for (const table of tableNames) {
        const response = await fetch(`${url}/rest/v1/${table}?select=*`, {
          headers: { apikey: anon, authorization: `Bearer ${token}` },
        });
        const text = await response.text();
        expect(response.ok, `${table} must deny direct reads`).toBe(false);
        expect(text).toMatch(/permission denied|not authorized|insufficient privilege/i);
      }
    }
  });
});
