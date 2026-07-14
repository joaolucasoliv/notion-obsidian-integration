import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sharedSourcePath = fileURLToPath(new URL("./shared/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@grandbox-bridge/shared": sharedSourcePath } },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["tests/acceptance/**", "web/playwright/**"],
  },
});
