const HMAC_SHA256_BYTES = 32;
const encoder = new TextEncoder();

function toWebArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function assertSecret(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Invalid verification token");
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[\da-f]{64}$/i.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(HMAC_SHA256_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    const start = index * 2;
    bytes[index] = Number.parseInt(value.slice(start, start + 2), 16);
  }
  return bytes;
}

function suppliedSignature(value: string | null): Uint8Array {
  if (typeof value !== "string") {
    return new Uint8Array();
  }
  const hex = value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
  return fromHex(hex) ?? new Uint8Array();
}

async function hmacSha256(rawBody: Uint8Array, verificationToken: string, crypto: Crypto): Promise<Uint8Array> {
  assertSecret(verificationToken);
  const key = await crypto.subtle.importKey(
    "raw",
    toWebArrayBuffer(encoder.encode(verificationToken)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, toWebArrayBuffer(rawBody)));
}

/** Encodes text without parsing or normalizing a request body. */
export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

/**
 * Compares every candidate byte, including a length mismatch, before returning.
 * Callers should still bound untrusted candidates before reaching this helper.
 */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const longest = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < longest; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function signNotionBody(rawBody: Uint8Array, verificationToken: string, crypto: Crypto): Promise<string> {
  return "sha256=" + toHex(await hmacSha256(rawBody, verificationToken, crypto));
}

/**
 * Validates an HMAC over the original body bytes. It intentionally never parses
 * JSON, trims text, or otherwise transforms the signed payload.
 */
export async function verifyNotionBody(
  rawBody: Uint8Array,
  signature: string | null,
  verificationToken: string,
  crypto: Crypto,
): Promise<boolean> {
  const expected = await hmacSha256(rawBody, verificationToken, crypto);
  return constantTimeEqual(expected, suppliedSignature(signature));
}
