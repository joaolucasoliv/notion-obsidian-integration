import { handleBridgeApi, type BridgeApiDependencies } from "../../../src/queue/handler.ts";

/**
 * The Edge adapter owns no credentials or business logic. A local service-role
 * host injects scoped repositories, the relay-token pepper, and the webhook
 * verification-token accessor without exposing any of them to requests.
 */
export interface BridgeApiEdgeDependencies extends BridgeApiDependencies {}

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
