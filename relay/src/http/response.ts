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

export function methodNotAllowed(): Response {
  return empty(405, { allow: "POST" });
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

export function internalServerError(): Response {
  return empty(500);
}
