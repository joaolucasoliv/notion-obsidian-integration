import { expect, test } from "@playwright/test";
import { attachFakeRelay } from "./support/fake-relay.ts";
import { encryptedBrowserFixture, GRAPH_ID } from "./support/encrypted-fixtures.ts";

test("a lower valid sequence is rejected while the accepted graph remains visible", async ({ page }) => {
  const accepted = await encryptedBrowserFixture({ sequence: 42 });
  const rollback = await encryptedBrowserFixture({ sequence: 41 });
  const relay = await attachFakeRelay(page, accepted.envelope);
  await page.goto(`/g/${GRAPH_ID}`);
  await page.getByLabel("Paste device pairing code").fill(accepted.pairingCode);
  await page.getByRole("button", { name: "Pair this device" }).click();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();

  relay.setEnvelope(rollback.envelope);
  await page.getByRole("button", { name: "Refresh graph" }).click();
  await expect(page.getByText("refresh needs attention")).toBeVisible();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  expect(relay.requests()).toBe(2);
});
