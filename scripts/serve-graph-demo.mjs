import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { base64url, encryptGraph, formatPairingCode } from "../shared/dist/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(root, "web/dist");
const host = "127.0.0.1";
const port = Number.parseInt(process.env.GRANDBOX_DEMO_PORT ?? "4176", 10);
const graphId = "844d93be-86f1-47ea-a98c-9c56ee81e027";
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const projection = {
  schemaVersion: 1,
  installationId: "5c343dbe-23b1-4e13-af1e-ffed61ecb290",
  nodes: [
    { id: "vault:root", label: "The Grandbox", path: null, kind: "vault", domain: "other", tags: [], notionUrl: null, obsidianUrl: null, collapsed: false },
    { id: "cluster:github", label: "GitHub Vault", path: null, kind: "cluster", domain: "github", tags: [], notionUrl: null, obsidianUrl: null, collapsed: true },
    { id: "github:repository:nodal", label: "nodal", path: "Repositories/nodal.md", kind: "note", domain: "github", tags: ["github", "repository"], notionUrl: null, obsidianUrl: null, collapsed: false },
    { id: "github:repository:angico-core", label: "angico-core", path: "Repositories/angico-core.md", kind: "note", domain: "github", tags: ["github", "repository"], notionUrl: null, obsidianUrl: null, collapsed: false },
    { id: "github:branch:nodal-main", label: "main", path: "Repositories/nodal/main.md", kind: "note", domain: "github", tags: ["github", "branch"], notionUrl: null, obsidianUrl: null, collapsed: true },
    { id: "github:deployment:nodal", label: "production deploy", path: "Repositories/nodal/deployments.md", kind: "note", domain: "github", tags: ["github", "deployment"], notionUrl: null, obsidianUrl: null, collapsed: true },
    { id: "cluster:research", label: "Research", path: null, kind: "cluster", domain: "research", tags: [], notionUrl: null, obsidianUrl: null, collapsed: false },
    { id: "note:bridge", label: "Grandbox Bridge", path: "Projects/Grandbox Bridge.md", kind: "note", domain: "project", tags: ["project", "integration"], notionUrl: null, obsidianUrl: null, collapsed: false },
    { id: "note:research", label: "Graph research", path: "Research/Graph.md", kind: "note", domain: "research", tags: ["research", "graph"], notionUrl: null, obsidianUrl: null, collapsed: false }
  ],
  edges: [
    { id: "edge:vault:github", source: "vault:root", target: "cluster:github", kind: "vault" },
    { id: "edge:github:nodal", source: "cluster:github", target: "github:repository:nodal", kind: "cluster" },
    { id: "edge:github:angico", source: "cluster:github", target: "github:repository:angico-core", kind: "cluster" },
    { id: "edge:nodal:main", source: "github:repository:nodal", target: "github:branch:nodal-main", kind: "cluster" },
    { id: "edge:nodal:deploy", source: "github:repository:nodal", target: "github:deployment:nodal", kind: "cluster" },
    { id: "edge:vault:research", source: "vault:root", target: "cluster:research", kind: "vault" },
    { id: "edge:research:note", source: "cluster:research", target: "note:research", kind: "cluster" },
    { id: "edge:vault:bridge", source: "vault:root", target: "note:bridge", kind: "vault" }
  ],
  conflicts: 0
};

const envelope = await encryptGraph({
  projection,
  key,
  installationId: projection.installationId,
  keyId: "synthetic-demo-key",
  sequence: 42,
  createdAt: "2026-07-15T12:00:00.000Z",
  nonce: Uint8Array.from({ length: 12 }, (_, index) => index + 9)
});
const pairingCode = formatPairingCode({
  version: 1,
  graphId,
  keyId: "synthetic-demo-key",
  key: base64url(key)
});

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"]
]);

function send(response, status, headers, body = undefined) {
  response.writeHead(status, headers);
  response.end(body);
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" || pathname.startsWith("/g/") ? "/index.html" : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    send(response, 400, { "Cache-Control": "no-store" });
    return;
  }
  const file = resolve(dist, `.${decoded}`);
  if (relative(dist, file).startsWith("..")) {
    send(response, 404, { "Cache-Control": "no-store" });
    return;
  }
  try {
    const body = await readFile(file);
    send(response, 200, {
      "Content-Type": mimeTypes.get(extname(file)) ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }, body);
  } catch {
    send(response, 404, { "Cache-Control": "no-store" });
  }
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" || request.url === undefined) {
    send(response, 405, { Allow: "GET", "Cache-Control": "no-store" });
    return;
  }
  const url = new URL(request.url, `http://${host}:${port}`);
  if (url.search !== "") {
    send(response, 404, { "Cache-Control": "no-store" });
    return;
  }
  if (url.pathname === `/api/graph/${graphId}`) {
    send(response, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff"
    }, JSON.stringify(envelope));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    send(response, 404, { "Cache-Control": "no-store" });
    return;
  }
  await serveStatic(url.pathname, response);
});

server.listen(port, host, () => {
  process.stdout.write(`\nGrandbox Bridge synthetic demo (no vault or provider data)\n\nOpen: http://${host}:${port}/g/${graphId}\n\nPaste this synthetic pairing code:\n${pairingCode}\n\nUse Ctrl+C to stop.\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
