const BRIDGE_API_GATEWAY_PREFIXES = ["/functions/v1/bridge-api", "/bridge-api"] as const;

/** Adapts the Supabase gateway URL to the framework-free canonical router. */
export function normalizeBridgeApiRequest(request: Request): Request {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return request;
  }
  for (const prefix of BRIDGE_API_GATEWAY_PREFIXES) {
    if (url.pathname === prefix) {
      url.pathname = "/";
      return new Request(url, request);
    }
    if (url.pathname.startsWith(prefix + "/")) {
      url.pathname = url.pathname.slice(prefix.length);
      return new Request(url, request);
    }
  }
  return request;
}
