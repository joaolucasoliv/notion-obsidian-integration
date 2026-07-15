import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("./src/cli.ts", import.meta.url))],
  bundle: true,
  format: "cjs",
  legalComments: "none",
  outfile: fileURLToPath(new URL("./dist/bridge-worker.cjs", import.meta.url)),
  platform: "node",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
});
