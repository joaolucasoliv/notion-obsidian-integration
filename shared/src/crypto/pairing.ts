import type { PairingPayloadV1 } from "../contracts/relay.ts";
import { canonicalJson } from "./canonical-json.ts";
import { base64url, fromBase64url } from "./base64url.ts";
import { parsePairingPayload } from "../schemas/relay.ts";

const PAIRING_CODE_PREFIX = "gbp1.";
export const MAX_PAIRING_CODE_CHARACTERS = 4_096;

export function formatPairingCode(payload: PairingPayloadV1): string {
  const parsed = parsePairingPayload(payload);
  return `${PAIRING_CODE_PREFIX}${base64url(new TextEncoder().encode(canonicalJson(parsed)))}`;
}

export function parsePairingCode(code: string): PairingPayloadV1 {
  if (typeof code !== "string" || !code.startsWith(PAIRING_CODE_PREFIX)) {
    throw new Error("Expected a gbp1 pairing code");
  }
  if (code.length > MAX_PAIRING_CODE_CHARACTERS) {
    throw new Error("Pairing code exceeds the fixed length cap");
  }

  const encodedPayload = code.slice(PAIRING_CODE_PREFIX.length);
  try {
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64url(encodedPayload)));
    return parsePairingPayload(payload);
  } catch {
    throw new Error("Invalid gbp1 pairing code");
  }
}
