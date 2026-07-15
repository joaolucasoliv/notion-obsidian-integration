import { describe, expect, it } from "vitest";
import { authenticateRequestBearer, createLocalBearerAuthenticator } from "./bearer.js";

const FIXTURE_BEARER = "fixture-local-bearer-value";
const FIXTURE_IDENTITY = { installationId: "11111111-1111-4111-8111-111111111111" };

describe("local bearer authentication", () => {
  it("accepts only the exact synthetic bearer credential", async () => {
    const authenticator = createLocalBearerAuthenticator(FIXTURE_BEARER, FIXTURE_IDENTITY, globalThis.crypto);

    await expect(
      authenticateRequestBearer(
        new Request("https://fixture.invalid/webhook", { headers: { authorization: "Bearer " + FIXTURE_BEARER } }),
        authenticator,
      ),
    ).resolves.toEqual(FIXTURE_IDENTITY);
    await expect(
      authenticateRequestBearer(
        new Request("https://fixture.invalid/webhook", { headers: { authorization: "Bearer fixture-wrong-value" } }),
        authenticator,
      ),
    ).resolves.toBeNull();
    await expect(
      authenticateRequestBearer(
        new Request("https://fixture.invalid/webhook", { headers: { authorization: "Basic " + FIXTURE_BEARER } }),
        authenticator,
      ),
    ).resolves.toBeNull();
  });
});
