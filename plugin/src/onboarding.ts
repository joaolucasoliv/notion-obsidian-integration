const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMPACT_UUID_PATTERN = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/giu;

function onboardingError(): Error {
  return new Error("Notion page unavailable");
}

function isNotionHost(hostname: string): boolean {
  return hostname === "notion.so" || hostname.endsWith(".notion.so") || hostname === "app.notion.com";
}

function compactUuid(value: string): string {
  const compact = value.toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

/** Extracts one opaque page ID from a direct ID or a normal Notion page URL. */
export function parseNotionParentPageId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\r\n\0]/u.test(value)) {
    throw onboardingError();
  }
  const direct = value.toLowerCase();
  if (UUID_PATTERN.test(direct)) return direct;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw onboardingError();
  }
  if (
    url.protocol !== "https:" ||
    !isNotionHost(url.hostname.toLowerCase()) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw onboardingError();
  }
  const matches = [...url.pathname.matchAll(COMPACT_UUID_PATTERN)].map((match) => match[0]);
  if (matches.length !== 1 || matches[0] === undefined) throw onboardingError();
  const parsed = compactUuid(matches[0]);
  if (!UUID_PATTERN.test(parsed)) throw onboardingError();
  return parsed;
}
