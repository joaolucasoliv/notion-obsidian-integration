export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
export const WEBHOOK_RATE_LIMIT = 120;
export const WEBHOOK_RATE_WINDOW_SECONDS = 60;

export function isJsonContentType(value: string | null): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function declaredLengthExceeds(value: string | null, limit: number): boolean {
  if (typeof value !== "string" || value.length === 0 || !/^\d+$/.test(value)) {
    return false;
  }
  const declared = Number(value);
  return !Number.isSafeInteger(declared) || declared > limit;
}

/**
 * Reads a Request stream only up to the supplied cap. A null result means the
 * declared or observed size crossed the cap; callers never receive oversized
 * bytes to parse, sign, or log.
 */
export async function readBodyAtMost(request: Request, limit = MAX_WEBHOOK_BODY_BYTES): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(limit) || limit < 1 || declaredLengthExceeds(request.headers.get("content-length"), limit)) {
    return null;
  }
  if (request.body === null) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function boundedRetryAfterSeconds(windowStartedAt: string, now: Date, windowSeconds = WEBHOOK_RATE_WINDOW_SECONDS): number {
  const windowStart = new Date(windowStartedAt).getTime();
  if (!Number.isFinite(windowStart) || !Number.isFinite(now.getTime())) {
    return 1;
  }
  const remaining = windowStart + windowSeconds * 1_000 - now.getTime();
  return Math.min(windowSeconds, Math.max(1, Math.ceil(remaining / 1_000)));
}
