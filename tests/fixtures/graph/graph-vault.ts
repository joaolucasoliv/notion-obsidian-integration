import { createHash } from "node:crypto";

export interface SyntheticGraphSourceNote {
  path: string;
  basename: string;
  markdown: string;
  tags: string[];
}

export const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

export const DOMAIN_RULES = [
  { pathPrefix: "Academics", domain: "academic" as const },
  { pathPrefix: "Research", domain: "research" as const },
  { pathPrefix: "Projects", domain: "project" as const },
] as const;

export const PAIR_MAP = new Map<string, { notionUrl: string }>([
  ["Research/Index.md", { notionUrl: "https://www.notion.so/research-index" }],
  ["Repositories/generated.md", { notionUrl: "https://www.notion.so/github-tracker" }],
]);

function basenameFor(path: string): string {
  const filename = path.split("/").at(-1) ?? path;
  return filename.replace(/\.md$/iu, "");
}

function note(path: string, tags: readonly string[], markdown: string): SyntheticGraphSourceNote {
  return { path, basename: basenameFor(path), markdown, tags: [...tags] };
}

/** Synthetic whole-vault input; it must never be replaced with a live vault read. */
export function graphVaultFixture(): SyntheticGraphSourceNote[] {
  return [
    note(
      "Home.md",
      ["home", "alpha"],
      `---
tags: [frontmatter-only]
related: "[[A/Plan]]"
---
# Home

[[Research/Index#Overview|Research landing]]
[[Plan]]
[Research local](Research/Index.md#Overview)
[External](https://example.test/research)
[Attachment](assets/summary.pdf)

\`[[A/Plan]] [ignored](Research/Index.md)\`

\`\`\`md
[[A/Plan]]
[ignored](Research/Index.md)
\`\`\`

PRIVATE BODY SENTINEL
`,
    ),
    note("Research/Index.md", ["research", "alpha"], "# Research Index\n"),
    note("Research/Deep/Study.md", ["study"], "[[../Index]]\n"),
    note("Academics/Thesis.md", ["thesis"], "[[Home]]\n"),
    note("Projects/Bridge.md", ["project"], "[[Research/Index]]\n"),
    note("Personal/Journal.md", ["personal"], "[[../Research/./Index.md|Normalized relative]]\n"),
    note("Elsewhere/Loose.md", ["misc"], "# Loose\n"),
    note("A/Plan.md", ["plan"], "# A Plan\n"),
    note("B/Plan.md", ["plan"], "# B Plan\n"),
    note(
      "Bridge Conflicts/Decision.bridge-conflict.md",
      ["conflict"],
      "# Synthetic conflict\n[[Research/Index]]\n",
    ),
    note(
      "Repositories/generated.md",
      ["dual-scribe/github/repository", "github"],
      "<!-- dual-scribe-github:start:repository -->\n# Generated tracker\n<!-- dual-scribe-github:end:repository -->\n",
    ),
    note("Repositories/branch.md", ["dual-scribe/github/branch"], "# Branch tracker\n"),
    note("Repositories/activity.md", ["dual-scribe/github/activity"], "# Activity tracker\n"),
    note(".obsidian/plugins/private.md", ["technical"], "# Hidden technical note\n"),
    note("Templates/template.md", ["template"], "# Hidden template\n"),
  ];
}

export function repositoryOnlyFixture(): SyntheticGraphSourceNote[] {
  return [note("Repositories/only.md", ["dual-scribe/github/repository"], "# Repository-only fixture\n")];
}

export function technicalBasenameAmbiguityFixture(): SyntheticGraphSourceNote[] {
  return [
    note("Implicit.md", [], "[[Plan]]\n"),
    note("Explicit.md", [], "[[A/Plan]]\n"),
    note("A/Plan.md", [], "# Projected plan\n"),
    note("Templates/Plan.md", [], "# Technical plan\n"),
  ];
}

export function percentEncodedLinkFixture(): SyntheticGraphSourceNote[] {
  return [
    note(
      "Nested/Home.md",
      [],
      "[[javascript%3Aevil]]\n[[Research%2FIndex]]\n[[%2e%2e/Secret]]\n[[Safe%20Note]]\n",
    ),
    note("javascript:evil.md", [], "# Not a graph link target\n"),
    note("Research/Index.md", [], "# Research\n"),
    note("Secret.md", [], "# Secret\n"),
    note("Safe Note.md", [], "# Safe\n"),
  ];
}

export function obsidianCommentFixtureMarkdown(): string {
  return "%% [[Secret]] %%\n[[Visible]]\n";
}

export function markdownContextCommentFixtureMarkdown(): string {
  return "`%%`\n[[InlineVisible]]\n\n```md\n%%\n```\n[[FenceVisible]]\n\n%% [[Hidden]] %%\n[[CommentVisible]]\n";
}

export function rawDelimiterFixture(): SyntheticGraphSourceNote[] {
  return [
    note("Encoded.md", [], "[[Secret%23hidden]]\n[[Secret%3Fquery]]\n"),
    note("Raw.md", [], "[[Secret#heading]]\n[[Secret?query]]\n"),
    note("Secret.md", [], "# Base secret\n"),
    note("Secret#hidden.md", [], "# Literal hash secret\n"),
    note("Secret?query.md", [], "# Literal query secret\n"),
  ];
}

export function idFor(path: string): string {
  return createHash("sha256").update(`note\0${path}`, "utf8").digest("hex");
}
