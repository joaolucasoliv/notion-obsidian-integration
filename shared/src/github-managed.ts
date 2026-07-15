export type GithubManagedState = "none" | "generated" | "invalid";

const GITHUB_MARKER_PREFIX = "<!-- dual-scribe-github:";
const GITHUB_MARKER_PATTERN =
  /<!-- dual-scribe-github:(start|end):([a-z0-9][a-z0-9-]{0,63}) -->/g;
const GITHUB_TAG_PREFIX = "dual-scribe/github/";

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const next = value.indexOf(needle, offset);
    if (next === -1) return count;
    count += 1;
    offset = next + needle.length;
  }
}

/** Recognizes only the exact paired marker form emitted for GitHub tracker notes. */
export function inspectGithubManagedBytes(bytes: string): GithubManagedState {
  const prefixCount = countOccurrences(bytes, GITHUB_MARKER_PREFIX);
  if (prefixCount === 0) return "none";

  const markers = [...bytes.matchAll(GITHUB_MARKER_PATTERN)].map((match) => ({
    index: match.index,
    kind: match[2],
    direction: match[1],
  }));
  if (
    prefixCount !== 2 ||
    markers.length !== 2 ||
    markers[0]?.direction !== "start" ||
    markers[1]?.direction !== "end" ||
    markers[0].kind !== markers[1].kind ||
    markers[0].index >= markers[1].index
  ) {
    return "invalid";
  }
  return "generated";
}

/** Detects the parsed YAML tag identity used by generated GitHub tracker notes. */
export function hasGithubManagedTag(tags: readonly string[]): boolean {
  return tags.some(
    (tag) => tag.startsWith(GITHUB_TAG_PREFIX) && tag.length > GITHUB_TAG_PREFIX.length,
  );
}
