import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sharedSourcePath = fileURLToPath(new URL("./shared/src/index.ts", import.meta.url));
const workerServiceSourcePath = fileURLToPath(new URL("./worker/src/runtime/service.ts", import.meta.url));
const obsidianTestDoublePath = fileURLToPath(new URL("./tests/fakes/obsidian.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@grandbox-bridge/shared": sharedSourcePath,
      "@grandbox-bridge/worker/runtime/service": workerServiceSourcePath,
      obsidian: obsidianTestDoublePath,
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["tests/acceptance/**", "web/playwright/**"],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
