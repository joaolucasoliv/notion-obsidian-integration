function empty(status: number, headers?: HeadersInit): Response {
  return headers === undefined ? new Response(null, { status }) : new Response(null, { status, headers });
}

export function noContent(): Response {
  return empty(204);
}

export function badRequest(): Response {
  return empty(400);
}

export function unauthorized(): Response {
  return empty(401);
}

export function methodNotAllowed(allow = "POST"): Response {
  return empty(405, { allow });
}

export function unsupportedMediaType(): Response {
  return empty(415);
}

export function payloadTooLarge(): Response {
  return empty(413);
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return empty(429, { "retry-after": String(retryAfterSeconds) });
}

export function forbidden(): Response {
  return empty(403);
}

export function notFound(): Response {
  return empty(404);
}

export function conflict(): Response {
  return empty(409);
}

export function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
}

export function internalServerError(): Response {
  return empty(500);
}
