import { createClient } from "@supabase/supabase-js";
import { handleBridgeApi } from "../queue/handler.ts";
import { handleNotionWebhook } from "../webhook/handler.ts";
import { parseEdgeRuntimeConfiguration } from "./config.ts";
import { normalizeBridgeApiRequest } from "./request.ts";
import { createEdgeRuntimeDependencies } from "./runtime.ts";

export type EdgeRuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type EdgeRuntimeHandler = (request: Request) => Promise<Response>;

function unavailable(): Response {
  return new Response(null, { status: 500 });
}

function runtimeDependencies(environment: EdgeRuntimeEnvironment) {
  const configuration = parseEdgeRuntimeConfiguration(environment);
  const client = createClient(configuration.supabaseUrl, configuration.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  return createEdgeRuntimeDependencies(client, configuration);
}

/** Creates a fixed, fail-closed handler from server-only Edge configuration. */
export function createBridgeApiRuntimeHandler(environment: EdgeRuntimeEnvironment): EdgeRuntimeHandler {
  try {
    const dependencies = runtimeDependencies(environment).bridgeApi;
    return async (request: Request): Promise<Response> => {
      try {
        return await handleBridgeApi(normalizeBridgeApiRequest(request), dependencies);
      } catch {
        return unavailable();
      }
    };
  } catch {
    return async (): Promise<Response> => unavailable();
  }
}

/** Creates a fixed, fail-closed handler from server-only Edge configuration. */
export function createNotionWebhookRuntimeHandler(environment: EdgeRuntimeEnvironment): EdgeRuntimeHandler {
  try {
    const dependencies = runtimeDependencies(environment).webhook;
    return async (request: Request): Promise<Response> => {
      try {
        return await handleNotionWebhook(request, dependencies);
      } catch {
        return unavailable();
      }
    };
  } catch {
    return async (): Promise<Response> => unavailable();
  }
}
