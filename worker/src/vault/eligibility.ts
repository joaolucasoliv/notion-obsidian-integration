import type { ParsedLocalNote } from "../markdown/frontmatter.js";

export type Eligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason:
        | "not-opted-in"
        | "technical-path"
        | "generated-github"
        | "conflict-artifact"
        | "invalid-frontmatter"
        | "status-note";
    };

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
    if (next === -1) {
      return count;
    }
    count += 1;
    offset = next + needle.length;
  }
}

export function inspectGithubManagedBytes(bytes: string): GithubManagedState {
  const prefixCount = countOccurrences(bytes, GITHUB_MARKER_PREFIX);
  if (prefixCount === 0) {
    return "none";
  }

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

export function classifyPathExclusion(
  path: string,
): Extract<Eligibility, { readonly eligible: false }> | null {
  const segments = path.split("/");
  const baseName = segments.at(-1) ?? "";

  if (
    segments.some(
      (segment) => segment.startsWith(".") || segment.toLowerCase() === "templates",
    )
  ) {
    return { eligible: false, reason: "technical-path" };
  }
  if (
    segments.includes("Bridge Conflicts") ||
    baseName.toLowerCase().endsWith(".bridge-conflict.md")
  ) {
    return { eligible: false, reason: "conflict-artifact" };
  }
  if (path === "Grandbox Bridge.md") {
    return { eligible: false, reason: "status-note" };
  }
  return null;
}

export function classifyEligibility(note: ParsedLocalNote): Eligibility {
  const pathExclusion = classifyPathExclusion(note.path);
  if (pathExclusion !== null) {
    return pathExclusion;
  }

  const managedState = inspectGithubManagedBytes(note.bytes);
  if (managedState === "invalid") {
    return { eligible: false, reason: "invalid-frontmatter" };
  }
  if (
    managedState === "generated" ||
    note.tags.some(
      (tag) => tag.startsWith(GITHUB_TAG_PREFIX) && tag.length > GITHUB_TAG_PREFIX.length,
    )
  ) {
    return { eligible: false, reason: "generated-github" };
  }
  if (!note.notionSync) {
    return { eligible: false, reason: "not-opted-in" };
  }
  return { eligible: true };
}
