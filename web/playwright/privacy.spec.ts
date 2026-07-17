import { expect, test } from "@playwright/test";
import { GRAPH_ID } from "./support/encrypted-fixtures.ts";

test("locked initial state exposes no graph plaintext and makes no snapshot request", async ({ page }) => {
  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  await page.goto(`/g/${GRAPH_ID}`);

  await expect(page.getByRole("heading", { name: "This graph is locked" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Paired note");
  await expect(page.locator("body")).not.toContainText("Research/Paired.md");
  expect(requestUrls.some((url) => url.includes("/api/graph/"))).toBe(false);
  const browserStorage = await page.evaluate(() => ({
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
    cookies: document.cookie,
  }));
  expect(JSON.stringify(browserStorage)).not.toContain("Paired note");
  expect(JSON.stringify(browserStorage)).not.toContain("Research/Paired.md");
});
