export interface GraphRoute {
  readonly graphId: string;
}

const graphRoutePattern = /^\/g\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

export function parseGraphRoute(pathname: string): GraphRoute {
  const match = graphRoutePattern.exec(pathname);
  if (match?.[1] === undefined) {
    throw new Error("Invalid graph route");
  }

  return { graphId: match[1] };
}
