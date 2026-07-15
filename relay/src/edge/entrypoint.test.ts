import { describe, expect, it } from "vitest";
import { createBridgeApiRuntimeHandler, createNotionWebhookRuntimeHandler } from "./entrypoint.js";

describe("Edge runtime entrypoint factories", () => {
  it("fails bridge-api closed without exposing server configuration", async () => {
    const secret = "server-only-bridge-fixture-secret";
    const handler = createBridgeApiRuntimeHandler({ RELAY_TOKEN_PEPPER: secret });

    const response = await handler(new Request("http://edge.local/v1/events/claim", { method: "POST" }));

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain(secret);
  });

  it("fails notion-webhook closed without exposing server configuration", async () => {
    const secret = "server-only-webhook-fixture-secret";
    const handler = createNotionWebhookRuntimeHandler({ RELAY_TOKEN_PEPPER: secret });

    const response = await handler(new Request("http://edge.local", { method: "POST" }));

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain(secret);
  });
});
