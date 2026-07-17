import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const sharedSourcePath = fileURLToPath(new URL("../shared/src/index.ts", import.meta.url));

export default defineConfig({
  base: "/",
  resolve: {
    alias: {
      "@grandbox-bridge/shared": sharedSourcePath,
    },
  },
});
