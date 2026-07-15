import { utf8 } from "../auth/hmac.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

function toWebArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function isPublicRsaOaepJwk(value: JsonWebKey): boolean {
  const record = value as Record<string, unknown>;
  if (record.kty !== "RSA" || typeof record.n !== "string" || typeof record.e !== "string" || "d" in record) {
    return false;
  }
  return record.alg === undefined || record.alg === "RSA-OAEP-256";
}

/**
 * Accepts only the Notion bootstrap shape, excluding even harmless-looking
 * extras so no event data is accidentally interpreted as a verification token.
 */
export function parseBootstrapVerificationToken(rawBody: Uint8Array): string | null {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(rawBody));
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "verification_token" || typeof value.verification_token !== "string") {
    return null;
  }
  return value.verification_token.length > 0 ? value.verification_token : null;
}

/**
 * Produces base64url RSA-OAEP ciphertext only. The input token is never
 * returned, serialized with metadata, or handed to a storage adapter.
 */
export async function encryptBootstrapVerificationToken(
  verificationToken: string,
  publicJwk: JsonWebKey,
  crypto: Crypto,
): Promise<string> {
  if (typeof verificationToken !== "string" || verificationToken.length === 0 || !isPublicRsaOaepJwk(publicJwk)) {
    throw new Error("Invalid bootstrap encryption request");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    key,
    toWebArrayBuffer(utf8(verificationToken)),
  );
  return base64url(new Uint8Array(ciphertext));
}
