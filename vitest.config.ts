import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sharedSourcePath = fileURLToPath(new URL("./shared/src/index.ts", import.meta.url));
const obsidianTestDoublePath = fileURLToPath(new URL("./tests/fakes/obsidian.ts", import.meta.url));
const unitIncludes = [
  "shared/src/**/*.test.ts",
  "worker/src/**/*.test.ts",
  "plugin/src/**/*.test.ts",
  "relay/src/**/*.test.ts",
  "web/tests/**/*.test.ts",
  "scripts/**/*.test.ts",
  "tests/*.test.ts",
];

export default defineConfig({
  resolve: { alias: { "@grandbox-bridge/shared": sharedSourcePath, obsidian: obsidianTestDoublePath } },
  test: {
    include: unitIncludes,
    exclude: ["tests/integration/**", "tests/acceptance/**", "web/playwright/**"],
  },
});
