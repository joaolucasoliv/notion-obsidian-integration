import {
  hasGithubManagedTag,
  inspectGithubManagedBytes,
  type GithubManagedState,
} from "@grandbox-bridge/shared";
import type { ParsedLocalNote } from "../markdown/frontmatter.js";

export type Eligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | "not-opted-in"
        | "technical-path"
        | "generated-github"
        | "conflict-artifact"
        | "invalid-frontmatter"
        | "status-note";
    };

export { inspectGithubManagedBytes };
export type { GithubManagedState };

export function classifyPathExclusion(
  path: string,
): Extract<Eligibility, { eligible: false }> | null {
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
    hasGithubManagedTag(note.tags)
  ) {
    return { eligible: false, reason: "generated-github" };
  }
  if (!note.notionSync) {
    return { eligible: false, reason: "not-opted-in" };
  }
  return { eligible: true };
}
