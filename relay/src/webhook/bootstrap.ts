import { utf8 } from "../auth/hmac.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

function toWebArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isJsonWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r";
}

function skipWhitespace(value: string, index: number): number {
  let next = index;
  while (isJsonWhitespace(value[next])) {
    next += 1;
  }
  return next;
}

function readJsonString(value: string, start: number): { readonly value: string; readonly next: number } | null {
  if (value[start] !== '"') {
    return null;
  }
  let index = start + 1;
  while (index < value.length) {
    const character = value[index];
    if (character === '"') {
      try {
        const parsed = JSON.parse(value.slice(start, index + 1));
        return typeof parsed === "string" ? { value: parsed, next: index + 1 } : null;
      } catch {
        return null;
      }
    }
    if (character === "\\") {
      index += value[index + 1] === "u" ? 6 : 2;
      continue;
    }
    if (character === undefined || character.charCodeAt(0) <= 0x1f) {
      return null;
    }
    index += 1;
  }
  return null;
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
  if (rawBody[0] === 0xef && rawBody[1] === 0xbb && rawBody[2] === 0xbf) {
    return null;
  }
  let body: string;
  try {
    body = decoder.decode(rawBody);
  } catch {
    return null;
  }
  let index = skipWhitespace(body, 0);
  if (body[index] !== "{") {
    return null;
  }
  const key = readJsonString(body, skipWhitespace(body, index + 1));
  if (key === null || key.value !== "verification_token") {
    return null;
  }
  index = skipWhitespace(body, key.next);
  if (body[index] !== ":") {
    return null;
  }
  const verificationToken = readJsonString(body, skipWhitespace(body, index + 1));
  if (verificationToken === null) {
    return null;
  }
  index = skipWhitespace(body, verificationToken.next);
  if (body[index] !== "}") {
    return null;
  }
  return skipWhitespace(body, index + 1) === body.length && verificationToken.value.length > 0
    ? verificationToken.value
    : null;
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
