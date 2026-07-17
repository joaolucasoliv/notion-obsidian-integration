import { expect, test } from "@playwright/test";
import { encryptedBrowserFixture, GRAPH_ID } from "./support/encrypted-fixtures.ts";

test("pairs a synthetic encrypted graph and exposes safe exploration controls", async ({ page }) => {
  const fixture = await encryptedBrowserFixture();
  let fixtureRequests = 0;
  await page.route(`**/api/graph/${GRAPH_ID}`, async (route) => {
    fixtureRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(fixture.envelope),
    });
  });

  await page.goto(`/g/${GRAPH_ID}`);
  await page.getByLabel("Paste device pairing code").fill(fixture.pairingCode);
  await page.getByRole("button", { name: "Pair this device" }).click();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  expect(fixtureRequests).toBe(1);
  await expect(page.getByText("End-to-end encrypted")).toBeVisible();
  await expect(page.getByLabel("Search graph")).toBeVisible();
  await expect(page.getByRole("button", { name: "GitHub activities" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Paired note/ })).toBeVisible();
  await page.getByLabel("Search graph").fill("paired");
  await expect(page.getByRole("button", { name: /Paired note/ })).toBeVisible();
});
