export type BridgeApiRoute =
  | "events-claim"
  | "events-ack"
  | "pages-register"
  | "pages-unregister"
  | "auth-rotate-prepare"
  | "auth-rotate-commit"
  | "auth-rotate-cancel"
  | "bootstrap-webhook-token"
  | "bootstrap-activate"
  | "snapshot-upload"
  | "graph-read";

export interface BridgeApiRouteDefinition {
  readonly route: BridgeApiRoute;
  readonly method: "GET" | "POST" | "PUT";
  readonly graphId?: string;
}

const CANONICAL_GRAPH_PATH = /^\/v1\/graph\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

const ROUTES: Readonly<Record<string, BridgeApiRouteDefinition>> = {
  "/v1/events/claim": { route: "events-claim", method: "POST" },
  "/v1/events/ack": { route: "events-ack", method: "POST" },
  "/v1/pages/register": { route: "pages-register", method: "POST" },
  "/v1/pages/unregister": { route: "pages-unregister", method: "POST" },
  "/v1/auth/rotate/prepare": { route: "auth-rotate-prepare", method: "POST" },
  "/v1/auth/rotate/commit": { route: "auth-rotate-commit", method: "POST" },
  "/v1/auth/rotate/cancel": { route: "auth-rotate-cancel", method: "POST" },
  "/v1/bootstrap/webhook-token": { route: "bootstrap-webhook-token", method: "GET" },
  "/v1/bootstrap/activate": { route: "bootstrap-activate", method: "POST" },
  "/v1/snapshot": { route: "snapshot-upload", method: "PUT" },
};

export function bridgeApiRoute(request: Request): BridgeApiRouteDefinition | null {
  try {
    const pathname = new URL(request.url).pathname;
    const graph = CANONICAL_GRAPH_PATH.exec(pathname);
    const graphId = graph?.[1];
    if (graphId !== undefined) return { route: "graph-read", method: "GET", graphId };
    return ROUTES[pathname] ?? null;
  } catch {
    return null;
  }
}
