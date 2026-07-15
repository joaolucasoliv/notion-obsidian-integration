import {
  handleNotionWebhook,
  type WebhookDependencies,
} from "../../../src/webhook/handler.ts";

/**
 * The Edge entry point remains an adapter only: dependencies are injected by
 * the local host, while validation and request handling stay framework-free.
 */
export function createNotionWebhookEdgeHandler(
  deps: WebhookDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => handleNotionWebhook(request, deps);
}

export function installNotionWebhookEdgeHandler(
  deps: WebhookDependencies,
  serve: (handler: (request: Request) => Promise<Response>) => unknown,
): unknown {
  return serve(createNotionWebhookEdgeHandler(deps));
}
