import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("./src/main.ts", import.meta.url))],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  legalComments: "none",
  outfile: fileURLToPath(new URL("./main.js", import.meta.url)),
  platform: "node",
  target: "es2022",
});
