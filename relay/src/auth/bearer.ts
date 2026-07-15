import { constantTimeEqual, utf8 } from "./hmac.ts";

export interface BearerAuthenticator<T> {
  authenticate(bearer: string): Promise<T | null>;
}

function bearerFromHeader(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
}

/**
 * Performs only local, injected bearer authentication. It does not make a
 * network call or consult a host credential store.
 */
export async function authenticateRequestBearer<T>(request: Request, authenticator: BearerAuthenticator<T>): Promise<T | null> {
  const bearer = bearerFromHeader(request.headers.get("authorization"));
  return bearer === null ? null : authenticator.authenticate(bearer);
}

/**
 * Fixture-friendly authenticator for an explicitly injected local identity.
 * This is deliberately not a hosted identity provider or a credential store.
 */
export function createLocalBearerAuthenticator<T>(
  expectedBearer: string,
  identity: T,
  crypto: Crypto,
): BearerAuthenticator<T> {
  if (typeof expectedBearer !== "string" || expectedBearer.length === 0 || !crypto.subtle) {
    throw new Error("Invalid local bearer configuration");
  }
  const expected = utf8(expectedBearer);
  return {
    async authenticate(candidate: string): Promise<T | null> {
      return constantTimeEqual(expected, utf8(candidate)) ? identity : null;
    },
  };
}
