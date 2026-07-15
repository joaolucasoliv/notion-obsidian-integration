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

function graphEnvelope(installationId: string, sequence: number, createdAt: string) {
  return {
    version: 1,
    algorithm: "A256GCM",
    installationId,
    keyId: "local-fixture-key",
    sequence,
    createdAt,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AQIDBAUGBwgJCgsMDQ4PEA",
  };
}

async function storeGraphSnapshot(
  service: ReturnType<typeof createClient>,
  input: {
    readonly installationId: string;
    readonly graphId: string;
    readonly sequence: number;
    readonly envelope: Record<string, unknown>;
    readonly createdAt: string;
    readonly byteLength?: number;
  },
): Promise<boolean> {
  const response = await service.rpc("bridge_store_graph_snapshot_if_newer", {
    p_installation_id: input.installationId,
    p_graph_id: input.graphId,
    p_sequence: input.sequence,
    p_key_id: "local-fixture-key",
    p_envelope: input.envelope,
    p_byte_length: input.byteLength ?? 16,
    p_created_at: input.createdAt,
  });
  expect(response.error).toBeNull();
  return response.data as boolean;
}

async function readGraphSnapshot(service: ReturnType<typeof createClient>, graphId: string): Promise<Record<string, unknown>> {
  const response = await service.rpc("bridge_read_graph_snapshot", { p_graph_id: graphId });
  expect(response.error).toBeNull();
  expect(Array.isArray(response.data)).toBe(true);
  return (response.data as Record<string, unknown>[])[0] ?? {};
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

  it("atomically binds strictly-newer snapshots and throttles graph ciphertext reads through service-role RPC only", async () => {
    const url = requiredEnvironment(relayUrl, "SUPABASE_URL");
    const anon = requiredEnvironment(anonKey, "SUPABASE_ANON_KEY");
    const serviceRole = requiredEnvironment(serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY");
    const service = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
    const installationId = crypto.randomUUID();
    const graphId = crypto.randomUUID();
    const wrongGraphId = crypto.randomUUID();
    const createdAt = "2026-07-15T16:00:00.000Z";
    const envelope7 = graphEnvelope(installationId, 7, createdAt);

    expect((await service.from("bridge_installation").insert({
      id: installationId,
      graph_id: graphId,
      relay_token_hash: "synthetic-hash-only",
      graph_key_id: "initial-key",
    })).error).toBeNull();

    await expect(storeGraphSnapshot(service, {
      installationId,
      graphId,
      sequence: 7,
      envelope: envelope7,
      createdAt,
    })).resolves.toBe(true);
    await expect(storeGraphSnapshot(service, {
      installationId,
      graphId,
      sequence: 7,
      envelope: envelope7,
      createdAt,
    })).resolves.toBe(false);
    await expect(storeGraphSnapshot(service, {
      installationId,
      graphId,
      sequence: 6,
      envelope: graphEnvelope(installationId, 6, createdAt),
      createdAt,
    })).resolves.toBe(false);
    await expect(storeGraphSnapshot(service, {
      installationId,
      graphId: wrongGraphId,
      sequence: 8,
      envelope: graphEnvelope(installationId, 8, createdAt),
      createdAt,
    })).resolves.toBe(false);

    const stored = await service.from("bridge_installation").select("graph_id, graph_key_id, snapshot_sequence").eq("id", installationId).single();
    expect(stored.error).toBeNull();
    expect(stored.data).toEqual({ graph_id: graphId, graph_key_id: "local-fixture-key", snapshot_sequence: 7 });

    const firstRead = await readGraphSnapshot(service, graphId);
    expect(firstRead.allowed).toBe(true);
    expect(firstRead.envelope).toEqual(envelope7);
    const allowedReads = await Promise.all(Array.from({ length: 59 }, () => readGraphSnapshot(service, graphId)));
    for (const read of allowedReads) {
      expect(read).toMatchObject({ allowed: true, envelope: envelope7 });
    }
    const limited = await readGraphSnapshot(service, graphId);
    expect(limited).toMatchObject({ allowed: false, envelope: null });

    expect((await service.from("bridge_installation")
      .update({ graph_rate_window_started_at: "2000-01-01T00:00:00.000Z" })
      .eq("id", installationId)).error).toBeNull();
    expect(await readGraphSnapshot(service, graphId)).toMatchObject({ allowed: true, envelope: envelope7 });

    for (const functionName of ["bridge_store_graph_snapshot_if_newer", "bridge_read_graph_snapshot"]) {
      const response = await fetch(`${url}/rest/v1/rpc/${functionName}`, {
        method: "POST",
        headers: { apikey: anon, authorization: `Bearer ${anon}`, "content-type": "application/json" },
        body: JSON.stringify(functionName === "bridge_read_graph_snapshot" ? { p_graph_id: graphId } : {}),
      });
      expect(response.ok, `${functionName} must not be callable without the service role`).toBe(false);
    }
  });

  it("rejects malformed direct-RPC envelopes without changing the stored graph snapshot", async () => {
    const url = requiredEnvironment(relayUrl, "SUPABASE_URL");
    const serviceRole = requiredEnvironment(serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY");
    const service = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
    const installationId = crypto.randomUUID();
    const graphId = crypto.randomUUID();
    const createdAt = "2026-07-15T16:00:00.000Z";
    const envelope7 = graphEnvelope(installationId, 7, createdAt);

    expect((await service.from("bridge_installation").insert({
      id: installationId,
      graph_id: graphId,
      relay_token_hash: "synthetic-hash-only",
      graph_key_id: "initial-key",
    })).error).toBeNull();
    await expect(storeGraphSnapshot(service, {
      installationId,
      graphId,
      sequence: 7,
      envelope: envelope7,
      createdAt,
    })).resolves.toBe(true);

    const malformedWrites = [
      {
        sequence: 8,
        envelope: { installationId, keyId: "local-fixture-key", sequence: 8 },
        createdAt,
      },
      {
        sequence: 8,
        envelope: graphEnvelope(installationId, 8, "2026-07-15T16:00:01.000Z"),
        createdAt,
      },
      {
        sequence: 8,
        envelope: graphEnvelope(installationId, 8, "2026-02-30T16:00:00Z"),
        createdAt,
      },
      {
        sequence: 8,
        envelope: graphEnvelope(installationId, 8, createdAt),
        createdAt,
        byteLength: 15,
      },
      {
        sequence: Number.MAX_SAFE_INTEGER + 1,
        envelope: graphEnvelope(installationId, Number.MAX_SAFE_INTEGER + 1, createdAt),
        createdAt,
      },
    ] as const;

    for (const malformed of malformedWrites) {
      await expect(storeGraphSnapshot(service, {
        installationId,
        graphId,
        sequence: malformed.sequence,
        envelope: malformed.envelope,
        createdAt: malformed.createdAt,
        byteLength: malformed.byteLength,
      })).resolves.toBe(false);

      const installation = await service.from("bridge_installation")
        .select("graph_key_id, snapshot_sequence, graph_rate_count")
        .eq("id", installationId)
        .single();
      expect(installation.error).toBeNull();
      expect(installation.data).toEqual({ graph_key_id: "local-fixture-key", snapshot_sequence: 7, graph_rate_count: 0 });

      const snapshot = await service.rpc("bridge_read_installation_snapshot", { p_installation_id: installationId });
      expect(snapshot.error).toBeNull();
      expect(snapshot.data).toEqual([expect.objectContaining({
        installation_id: installationId,
        graph_id: graphId,
        sequence: 7,
        key_id: "local-fixture-key",
        envelope: envelope7,
        byte_length: 16,
      })]);
    }

    expect(await readGraphSnapshot(service, graphId)).toMatchObject({ allowed: true, envelope: envelope7 });
  });

  it("accepts a valid GraphEnvelopeV1 timestamp with an ISO offset at the RPC boundary", async () => {
    const url = requiredEnvironment(relayUrl, "SUPABASE_URL");
    const serviceRole = requiredEnvironment(serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY");
    const service = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
    const installationId = crypto.randomUUID();
    const graphId = crypto.randomUUID();
    const createdAt = "2026-07-15T13:00:00.000-03:00";

    expect((await service.from("bridge_installation").insert({
      id: installationId,
      graph_id: graphId,
      relay_token_hash: "synthetic-hash-only",
      graph_key_id: "initial-key",
    })).error).toBeNull();
    await expect(storeGraphSnapshot(service, {
      installationId,
      graphId,
      sequence: 1,
      envelope: graphEnvelope(installationId, 1, createdAt),
      createdAt,
    })).resolves.toBe(true);
  });
});
