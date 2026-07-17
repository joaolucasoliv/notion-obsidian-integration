import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:4175";

export default defineConfig({
  testDir: "web/playwright",
  timeout: 15_000,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: devices["Desktop Chrome"],
    },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: "npm run preview -w @grandbox-bridge/web",
        url: baseURL,
        reuseExistingServer: false,
      },
});
