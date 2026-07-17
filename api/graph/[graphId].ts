import type { VercelRequest, VercelResponse } from "@vercel/node";
import { RelayGraphProxy } from "../../web/src/api/graph-proxy.ts";

function setProxyHeaders(response: VercelResponse, source: Response): void {
  for (const name of ["content-type", "cache-control", "x-content-type-options", "retry-after"] as const) {
    const value = source.headers.get(name);
    if (value !== null) response.setHeader(name, value);
  }
}

/** Vercel boundary: only server-side configuration can choose the relay origin. */
export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  if (request.method !== "GET" || typeof request.url !== "string" || request.url.includes("?")) {
    response.status(404).end();
    return;
  }
  const graphId = request.query.graphId;
  if (typeof graphId !== "string") {
    response.status(404).end();
    return;
  }
  const relayGraphBaseUrl = process.env.RELAY_GRAPH_BASE_URL;
  if (relayGraphBaseUrl === undefined) {
    response.status(503).end();
    return;
  }

  let proxied: Response;
  try {
    proxied = await new RelayGraphProxy({ baseUrl: relayGraphBaseUrl }).get(graphId, AbortSignal.timeout(5_000));
  } catch {
    response.status(502).end();
    return;
  }
  setProxyHeaders(response, proxied);
  response.status(proxied.status);
  if (proxied.status !== 200) {
    response.end();
    return;
  }
  response.send(Buffer.from(await proxied.arrayBuffer()));
}
