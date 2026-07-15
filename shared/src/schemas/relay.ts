import { z } from "zod";
import type { PairingPayloadV1 } from "../contracts/relay.js";
import { fromBase64url } from "../crypto/base64url.js";

const identifierSchema = z.string().min(1).max(256);
const pairingKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).superRefine((value, context) => {
  try {
    if (fromBase64url(value).byteLength !== 32) {
      context.addIssue({ code: "custom", message: "Expected a 32-byte graph key" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "Expected a canonical 32-byte graph key" });
  }
});

export const pairingPayloadV1Schema = z
  .object({
    version: z.literal(1),
    graphId: identifierSchema,
    keyId: identifierSchema,
    key: pairingKeySchema,
  })
  .strict();

export function parsePairingPayload(input: unknown): PairingPayloadV1 {
  return pairingPayloadV1Schema.parse(input);
}
