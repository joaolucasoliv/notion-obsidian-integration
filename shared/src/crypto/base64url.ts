const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const BINARY_CHUNK_SIZE = 0x8000;

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += BINARY_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BINARY_CHUNK_SIZE));
  }

  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64url(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new Error("Expected canonical base64url input");
  }

  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = globalThis.atob(base64);
  } catch {
    throw new Error("Expected canonical base64url input");
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64url(bytes) !== value) {
    throw new Error("Expected canonical base64url input");
  }
  return bytes;
}

export const decodeBase64url = fromBase64url;
