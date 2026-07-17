import { expect, test } from "@playwright/test";

const GRAPH_ID = "844d93be-86f1-47ea-a98c-9c56ee81e027";
const PRIVATE_GRAPH_CANARY = "PRIVATE_GRAPH_CANARY_MUST_NEVER_RENDER";

test("a new device sees only the locked pairing surface", async ({ page }) => {
  await page.goto(`/g/${GRAPH_ID}`);

  await expect(page.getByRole("heading", { name: "This graph is locked" })).toBeVisible();
  await expect(page.getByLabel("Paste device pairing code")).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan QR" })).toBeVisible();
  await expect(page.getByText(PRIVATE_GRAPH_CANARY)).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
});
