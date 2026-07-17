import { expect, test } from "@playwright/test";
import { GRAPH_ID } from "./support/encrypted-fixtures.ts";

test.describe("Notion embed visual baseline", () => {
  test.use({ colorScheme: "dark" });

  test("keeps the exact dark canvas, zero page margin, and a usable narrow locked view", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 480 });
    await page.goto(`/g/${GRAPH_ID}`);
    for (const selector of ["html", "body", "#app", ".locked-shell"] as const) {
      await expect(page.locator(selector)).toHaveCSS("background-color", "rgb(25, 25, 25)");
    }
    await expect(page.locator("body")).toHaveCSS("margin-top", "0px");
    await expect(page.getByLabel("Paste device pairing code")).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan QR" })).toBeVisible();
  });
});
