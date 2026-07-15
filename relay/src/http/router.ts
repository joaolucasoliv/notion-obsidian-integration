export type BridgeApiRoute =
  | "events-claim"
  | "events-ack"
  | "pages-register"
  | "pages-unregister"
  | "auth-rotate-prepare"
  | "auth-rotate-commit"
  | "auth-rotate-cancel"
  | "bootstrap-webhook-token"
  | "bootstrap-activate";

interface RouteDefinition {
  readonly route: BridgeApiRoute;
  readonly method: "GET" | "POST";
}

const ROUTES: Readonly<Record<string, RouteDefinition>> = {
  "/v1/events/claim": { route: "events-claim", method: "POST" },
  "/v1/events/ack": { route: "events-ack", method: "POST" },
  "/v1/pages/register": { route: "pages-register", method: "POST" },
  "/v1/pages/unregister": { route: "pages-unregister", method: "POST" },
  "/v1/auth/rotate/prepare": { route: "auth-rotate-prepare", method: "POST" },
  "/v1/auth/rotate/commit": { route: "auth-rotate-commit", method: "POST" },
  "/v1/auth/rotate/cancel": { route: "auth-rotate-cancel", method: "POST" },
  "/v1/bootstrap/webhook-token": { route: "bootstrap-webhook-token", method: "GET" },
  "/v1/bootstrap/activate": { route: "bootstrap-activate", method: "POST" },
};

export function bridgeApiRoute(request: Request): RouteDefinition | null {
  try {
    return ROUTES[new URL(request.url).pathname] ?? null;
  } catch {
    return null;
  }
}
