function serializeCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error("Canonical JSON does not support sparse arrays");
      entries.push(serializeCanonicalJson(value[index]));
    }
    return `[${entries.join(",")}]`;
  }

  if (typeof value !== "object") {
    throw new Error("Canonical JSON does not support this value type");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Canonical JSON requires plain objects");
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return serializeCanonicalJson(value);
}
