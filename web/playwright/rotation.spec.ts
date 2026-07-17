import { expect, test } from "@playwright/test";
import { attachFakeRelay } from "./support/fake-relay.ts";
import { encryptedBrowserFixture, GRAPH_ID } from "./support/encrypted-fixtures.ts";

test("a key rotation locks the old pairing and accepts an explicit replacement pairing", async ({ page }) => {
  const initial = await encryptedBrowserFixture();
  const nextKey = Uint8Array.from({ length: 32 }, (_, index) => index + 61);
  const rotated = await encryptedBrowserFixture({ key: nextKey, keyId: "fixture-key-rotated" });
  const relay = await attachFakeRelay(page, initial.envelope);
  await page.goto(`/g/${GRAPH_ID}`);
  await page.getByLabel("Paste device pairing code").fill(initial.pairingCode);
  await page.getByRole("button", { name: "Pair this device" }).click();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();

  relay.setEnvelope(rotated.envelope);
  await page.getByRole("button", { name: "Refresh graph" }).click();
  await expect(page.getByRole("heading", { name: "This graph is locked" })).toBeVisible();
  await page.getByLabel("Paste device pairing code").fill(rotated.pairingCode);
  await page.getByRole("button", { name: "Pair this device" }).click();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  expect(relay.requests()).toBe(3);
});
