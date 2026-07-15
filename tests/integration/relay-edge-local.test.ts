import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { signNotionBody } from "../../relay/src/auth/hmac.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const GRAPH_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const BRIDGE_ID = "44444444-4444-4444-8444-444444444444";
const CLAIMED_EVENT_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_INSTALLATION_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_GRAPH_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_EVENT_ID = "88888888-8888-4888-8888-888888888888";
const WEBHOOK_EVENT_ID = "99999999-9999-4999-8999-999999999999";
const RELAY_TOKEN = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const RELAY_TOKEN_PEPPER = "edge-local-fixture-pepper";
const WEBHOOK_TOKEN = "edge-local-fixture-webhook-token";

function requiredEnvironment(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}; run this suite with npm run test:integration`);
  return value;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function hmacBase64url(keyText: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
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

function edgeRoute(url: string, path: string): string {
  return `${url}/functions/v1/${path}`;
}

describe("local Supabase Edge relay routes", () => {
  it("reaches canonical scoped relay, HMAC webhook, and no-store graph handlers through functions/v1", async () => {
    const url = requiredEnvironment(process.env.SUPABASE_URL, "SUPABASE_URL");
    const serviceRoleKey = requiredEnvironment(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
    const service = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const now = new Date().toISOString();
    const relayTokenHash = await hmacBase64url(RELAY_TOKEN_PEPPER, RELAY_TOKEN);

    expect((await service.from("bridge_installation").insert([
      {
        id: INSTALLATION_ID,
        graph_id: GRAPH_ID,
        relay_token_hash: relayTokenHash,
        graph_key_id: "local-fixture-key",
      },
      {
        id: OTHER_INSTALLATION_ID,
        graph_id: OTHER_GRAPH_ID,
        relay_token_hash: "synthetic-other-installation-hash",
        graph_key_id: "other-key",
      },
    ])).error).toBeNull();
    expect((await service.from("synced_page_registry").insert({
      installation_id: INSTALLATION_ID,
      notion_page_id: PAGE_ID,
      bridge_id: BRIDGE_ID,
    })).error).toBeNull();
    expect((await service.from("webhook_event").insert([
      {
        installation_id: INSTALLATION_ID,
        event_id: CLAIMED_EVENT_ID,
        event_type: "page.updated",
        entity_id: PAGE_ID,
        event_at: now,
        received_at: now,
      },
      {
        installation_id: OTHER_INSTALLATION_ID,
        event_id: OTHER_EVENT_ID,
        event_type: "page.updated",
        entity_id: PAGE_ID,
        event_at: now,
        received_at: now,
      },
    ])).error).toBeNull();
    expect((await service.rpc("bridge_store_graph_snapshot_if_newer", {
      p_installation_id: INSTALLATION_ID,
      p_graph_id: GRAPH_ID,
      p_sequence: 1,
      p_key_id: "local-fixture-key",
      p_envelope: graphEnvelope(INSTALLATION_ID, 1, now),
      p_byte_length: 16,
      p_created_at: now,
    })).error).toBeNull();

    const claim = await fetch(edgeRoute(url, "bridge-api/v1/events/claim"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${RELAY_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workerId: "edge-worker", limit: 50 }),
    });
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toEqual({
      events: [{ id: CLAIMED_EVENT_ID, type: "page.updated", entityId: PAGE_ID, eventAt: now }],
      leaseSeconds: 60,
    });

    const ack = await fetch(edgeRoute(url, "bridge-api/v1/events/ack"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${RELAY_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workerId: "edge-worker", eventIds: [CLAIMED_EVENT_ID] }),
    });
    expect(ack.status).toBe(204);

    const clientControlledConfig = await fetch(`${edgeRoute(url, "bridge-api/v1/events/claim")}?RELAY_TOKEN_PEPPER=client-controlled`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${RELAY_TOKEN.slice(0, -1)}B`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workerId: "edge-worker", limit: 1 }),
    });
    expect(clientControlledConfig.status).toBe(401);
    await expect(clientControlledConfig.text()).resolves.not.toContain(RELAY_TOKEN_PEPPER);

    const rawWebhook = new TextEncoder().encode(JSON.stringify({
      id: WEBHOOK_EVENT_ID,
      type: "page.updated",
      eventAt: now,
      entity: { id: PAGE_ID, type: "page" },
    }));
    const webhook = await fetch(edgeRoute(url, "notion-webhook"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${RELAY_TOKEN}`,
        "content-type": "application/json",
        "x-notion-signature": await signNotionBody(rawWebhook, WEBHOOK_TOKEN, crypto),
      },
      body: rawWebhook,
    });
    expect(webhook.status).toBe(204);

    const webhookClaim = await fetch(edgeRoute(url, "bridge-api/v1/events/claim"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${RELAY_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workerId: "edge-webhook-worker", limit: 50 }),
    });
    expect(webhookClaim.status).toBe(200);
    await expect(webhookClaim.json()).resolves.toEqual({
      events: [expect.objectContaining({ id: WEBHOOK_EVENT_ID, entityId: PAGE_ID })],
      leaseSeconds: 60,
    });

    const graph = await fetch(edgeRoute(url, `bridge-api/v1/graph/${GRAPH_ID}`));
    expect(graph.status).toBe(200);
    expect(graph.headers.get("cache-control")).toBe("no-store");
    await expect(graph.json()).resolves.toEqual(graphEnvelope(INSTALLATION_ID, 1, now));
  });
});
