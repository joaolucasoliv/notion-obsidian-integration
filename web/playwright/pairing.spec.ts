import { expect, test } from "@playwright/test";
import { attachFakeRelay } from "./support/fake-relay.ts";
import { encryptedBrowserFixture, GRAPH_ID } from "./support/encrypted-fixtures.ts";

test("a validated local pairing survives reload without persisting graph plaintext", async ({ page }) => {
  const fixture = await encryptedBrowserFixture();
  const relay = await attachFakeRelay(page, fixture.envelope);
  await page.goto(`/g/${GRAPH_ID}`);
  await page.getByLabel("Paste device pairing code").fill(fixture.pairingCode);
  await page.getByRole("button", { name: "Pair this device" }).click();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  expect(relay.requests()).toBe(1);

  await page.reload();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  expect(relay.requests()).toBe(2);
  const storage = await page.evaluate(async () => {
    const request = indexedDB.open("grandbox-bridge");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const names = [...database.objectStoreNames];
    database.close();
    return names;
  });
  expect(storage).toEqual(["pairings", "preferences"]);
});

test("forget clears the device pairing and returns to the locked surface", async ({ page }) => {
  const fixture = await encryptedBrowserFixture();
  const relay = await attachFakeRelay(page, fixture.envelope);
  await page.goto(`/g/${GRAPH_ID}`);
  await page.getByLabel("Paste device pairing code").fill(fixture.pairingCode);
  await page.getByRole("button", { name: "Pair this device" }).click();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();

  await page.getByRole("button", { name: "Forget this device" }).click();
  await expect(page.getByRole("heading", { name: "This graph is locked" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Paired note");
  await page.reload();
  await expect(page.getByRole("heading", { name: "This graph is locked" })).toBeVisible();
  expect(relay.requests()).toBe(1);
});
