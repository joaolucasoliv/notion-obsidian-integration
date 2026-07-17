import { expect, test } from "@playwright/test";

test.describe("@live deployed locked smoke", () => {
  test("renders only the deployed locked pairing surface without a pairing code", async ({ page }) => {
    const route = process.env.LIVE_GRAPH_ROUTE;
    test.skip(route === undefined || route.length === 0, "LIVE_GRAPH_ROUTE is supplied only by the private release runner");
    await page.goto(route as string);
    await expect(page.getByRole("heading", { name: "This graph is locked" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Paired note");
  });
});
