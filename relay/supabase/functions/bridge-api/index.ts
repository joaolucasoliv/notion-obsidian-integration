import { handleBridgeApi, type BridgeApiDependencies } from "../../../src/queue/handler.ts";
import { createBridgeApiRuntimeHandler, type EdgeRuntimeHandler } from "../../../src/edge/entrypoint.ts";

export type BridgeApiEdgeDependencies = BridgeApiDependencies;

export function createBridgeApiEdgeHandler(
  deps: BridgeApiEdgeDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => handleBridgeApi(request, deps);
}

export function installBridgeApiEdgeHandler(
  deps: BridgeApiEdgeDependencies,
  serve: (handler: (request: Request) => Promise<Response>) => unknown,
): unknown {
  return serve(createBridgeApiEdgeHandler(deps));
}

function runtimeEnvironment(): Record<string, string | undefined> {
  return {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    RELAY_SERVICE_ROLE_KEY: Deno.env.get("RELAY_SERVICE_ROLE_KEY"),
    RELAY_TOKEN_PEPPER: Deno.env.get("RELAY_TOKEN_PEPPER"),
    RELAY_WEBHOOK_TOKENS_JSON: Deno.env.get("RELAY_WEBHOOK_TOKENS_JSON"),
  };
}

let runtimeHandler: EdgeRuntimeHandler | null = null;

function installedRuntimeHandler(): EdgeRuntimeHandler {
  runtimeHandler ??= createBridgeApiRuntimeHandler(runtimeEnvironment());
  return runtimeHandler;
}

/** Supabase Edge Runtime's default fetch entrypoint. */
export default {
  async fetch(request: Request): Promise<Response> {
    return installedRuntimeHandler()(request);
  },
};
