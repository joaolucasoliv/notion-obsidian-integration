import {
  handleNotionWebhook,
  type WebhookDependencies,
} from "../../../src/webhook/handler.ts";

/** The adapter cannot supply a relay-wide token: lookup is installation-scoped. */
export interface NotionWebhookEdgeDependencies extends WebhookDependencies {
  verificationToken(installationId: string): Promise<string | null>;
}

/**
 * The Edge entry point remains an adapter only: dependencies are injected by
 * the local host, while validation and request handling stay framework-free.
 */
export function createNotionWebhookEdgeHandler(
  deps: NotionWebhookEdgeDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => handleNotionWebhook(request, deps);
}

export function installNotionWebhookEdgeHandler(
  deps: NotionWebhookEdgeDependencies,
  serve: (handler: (request: Request) => Promise<Response>) => unknown,
): unknown {
  return serve(createNotionWebhookEdgeHandler(deps));
}
