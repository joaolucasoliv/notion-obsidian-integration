const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SERVER_VALUE_LENGTH = 16 * 1024;
const MAX_WEBHOOK_TOKEN_ENTRIES = 1_024;

export class EdgeRuntimeConfigurationError extends Error {
  constructor() {
    super("Invalid Edge runtime configuration");
  }
}

export interface EdgeRuntimeConfiguration {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly relayTokenPepper: string;
  verificationToken(installationId: string): string | null;
}

function configurationError(): never {
  throw new EdgeRuntimeConfigurationError();
}

function nonEmptyServerValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SERVER_VALUE_LENGTH) {
    return configurationError();
  }
  return value;
}

function safeSupabaseUrl(value: unknown): string {
  const text = nonEmptyServerValue(value);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return configurationError();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || (url.pathname !== "" && url.pathname !== "/")
  ) {
    return configurationError();
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (value[index] === " " || value[index] === "\t" || value[index] === "\n" || value[index] === "\r") index += 1;
  return index;
}

function skipJsonString(value: string, start: number): number {
  if (value[start] !== '"') return -1;
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === '"') return index + 1;
    if (value[index] === "\\") {
      index += 1;
      if (index >= value.length) return -1;
    }
  }
  return -1;
}

function skipJsonValue(value: string, start: number): number {
  const first = value[start];
  if (first === '"') return skipJsonString(value, start);
  if (first !== "{" && first !== "[") {
    let index = start;
    while (index < value.length && value[index] !== "," && value[index] !== "}" && value[index] !== "]") index += 1;
    return index;
  }

  const stack: string[] = [first === "{" ? "}" : "]"];
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      const next = skipJsonString(value, index);
      if (next < 0) return -1;
      index = next - 1;
    } else if (character === "{") {
      stack.push("}");
    } else if (character === "[") {
      stack.push("]");
    } else if (character === "}" || character === "]") {
      if (stack.pop() !== character) return -1;
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

/** JSON.parse overwrites duplicate keys, so reject ambiguous top-level maps first. */
function hasUniqueTopLevelKeys(raw: string): boolean {
  let index = skipWhitespace(raw, 0);
  if (raw[index] !== "{") return false;
  index = skipWhitespace(raw, index + 1);
  if (raw[index] === "}") return skipWhitespace(raw, index + 1) === raw.length;

  const keys = new Set<string>();
  while (index < raw.length) {
    const keyStart = index;
    index = skipJsonString(raw, index);
    if (index < 0) return false;
    let key: unknown;
    try {
      key = JSON.parse(raw.slice(keyStart, index));
    } catch {
      return false;
    }
    if (typeof key !== "string" || keys.has(key)) return false;
    keys.add(key);
    index = skipWhitespace(raw, index);
    if (raw[index] !== ":") return false;
    index = skipWhitespace(raw, index + 1);
    index = skipJsonValue(raw, index);
    if (index < 0) return false;
    index = skipWhitespace(raw, index);
    if (raw[index] === "}") return skipWhitespace(raw, index + 1) === raw.length;
    if (raw[index] !== ",") return false;
    index = skipWhitespace(raw, index + 1);
  }
  return false;
}

function verificationTokenMap(value: unknown): ReadonlyMap<string, string> {
  const raw = nonEmptyServerValue(value);
  if (!hasUniqueTopLevelKeys(raw)) return configurationError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return configurationError();
  }
  if (!isRecord(parsed)) return configurationError();
  const entries = Object.entries(parsed);
  if (entries.length > MAX_WEBHOOK_TOKEN_ENTRIES) return configurationError();

  const tokens = new Map<string, string>();
  for (const [installationId, token] of entries) {
    if (!CANONICAL_UUID.test(installationId) || typeof token !== "string" || token.length === 0 || token.length > MAX_SERVER_VALUE_LENGTH) {
      return configurationError();
    }
    tokens.set(installationId, token);
  }
  return tokens;
}

/**
 * Parses only values supplied by the Edge runtime environment. Request data is
 * intentionally absent from this API so callers cannot override server secrets.
 */
export function parseEdgeRuntimeConfiguration(environment: Readonly<Record<string, string | undefined>>): EdgeRuntimeConfiguration {
  const supabaseUrl = safeSupabaseUrl(environment.SUPABASE_URL);
  const serviceRoleKey = environment.RELAY_SERVICE_ROLE_KEY === undefined
    ? nonEmptyServerValue(environment.SUPABASE_SERVICE_ROLE_KEY)
    : nonEmptyServerValue(environment.RELAY_SERVICE_ROLE_KEY);
  const relayTokenPepper = nonEmptyServerValue(environment.RELAY_TOKEN_PEPPER);
  const verificationTokens = verificationTokenMap(environment.RELAY_WEBHOOK_TOKENS_JSON);
  return {
    supabaseUrl,
    serviceRoleKey,
    relayTokenPepper,
    verificationToken(installationId: string): string | null {
      return typeof installationId === "string" ? verificationTokens.get(installationId) ?? null : null;
    },
  };
}
