import { describe, expect, it } from "vitest";
import type { PairPlanningInput } from "@grandbox-bridge/shared";
import { conflictArtifactPath, renderConflictArtifact } from "./conflicts.js";
import { planPair } from "./planner.js";

const BRIDGE_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const PAGE_URL = `https://www.notion.so/Alpha-${PAGE_ID.replaceAll("-", "")}`;
const APP_PAGE_URL = `https://app.notion.com/${PAGE_ID.replaceAll("-", "")}`;
const COMMON_HASH = "1".repeat(64);
const LOCAL_HASH = "2".repeat(64);
const NOTION_HASH = "3".repeat(64);
const BYTE_HASH = "4".repeat(64);
const NEXT_BYTE_HASH = "5".repeat(64);
const EDITED_AT = "2026-07-14T12:34:56.000Z";

function artifactFixture(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    bridgeId: BRIDGE_ID,
    conflictDate: "2026-07-14",
    localPath: "Notes/Alpha Note.md",
    localTitle: "Alpha Note",
    notionPageUrl: PAGE_URL,
    localSemantic: { bodyMarkdown: "# Local\n\nLocal body\n", tags: ["zeta", "alpha", "zeta"] },
    notionSemantic: { bodyMarkdown: "# Notion\n\nNotion body\n", tags: ["remote", "alpha"] },
    ...overrides,
  };
}

function conflictPlanningFixture(localBody: string, notionBody: string): PairPlanningInput {
  return {
    local: {
      kind: "present",
      path: "Notes/Alpha.md",
      title: "Alpha",
      bridgeId: BRIDGE_ID,
      byteHash: BYTE_HASH,
      eligible: true,
      semantic: { bodyMarkdown: localBody, tags: ["alpha"] },
      semanticHash: LOCAL_HASH,
    },
    notion: {
      kind: "present",
      pageId: PAGE_ID,
      bridgeId: BRIDGE_ID,
      editedAt: EDITED_AT,
      pageUrl: PAGE_URL,
      sourceMarkdown: notionBody,
      complete: true,
      unsupportedKinds: [],
      semantic: { bodyMarkdown: notionBody, tags: ["remote"] },
      semanticHash: NOTION_HASH,
      managed: { title: "Alpha", obsidianPath: "Notes/Alpha.md", status: "synced" },
    },
    prior: {
      bridgeId: BRIDGE_ID,
      localPath: "Notes/Alpha.md",
      notionPageId: PAGE_ID,
      status: "synced",
      lastLocalSemanticHash: COMMON_HASH,
      lastNotionSemanticHash: COMMON_HASH,
      lastCommonSemanticHash: COMMON_HASH,
      lastCommonLocalByteHash: BYTE_HASH,
      lastNotionEditedAt: EDITED_AT,
      lastSyncedAt: EDITED_AT,
    },
    prepared: {
      allocationId: null,
      conflictDate: "2026-07-14",
      push: { notionMarkdown: localBody, unsupportedKinds: [] },
      pull: { nextBytes: "next bytes", nextByteHash: NEXT_BYTE_HASH },
    },
  } as PairPlanningInput;
}

describe("conflict artifact rendering", () => {
  it("uses a safe normalized title stem in the fixed conflict directory", () => {
    const input = artifactFixture({ localTitle: "  Roadmap / phase...  " });

    expect(conflictArtifactPath(input)).toBe(
      `Bridge Conflicts/2026-07-14/Roadmap - phase — ${BRIDGE_ID}.md`,
    );
  });

  it("accepts canonical app.notion.com URLs when rendering a conflict artifact", () => {
    const artifact = renderConflictArtifact(artifactFixture({ notionPageUrl: APP_PAGE_URL }));

    expect(artifact).toContain(APP_PAGE_URL);
  });

  it("caps a Unicode-safe filename stem by UTF-8 bytes without splitting a code point", () => {
    const path = conflictArtifactPath(artifactFixture({ localTitle: "界".repeat(100) }));
    const safeName = path.split("/").at(-1)?.split(" — ")[0] ?? "";

    expect(new TextEncoder().encode(safeName).byteLength).toBeLessThanOrEqual(160);
    expect(safeName).toMatch(/^界+$/u);
    expect(conflictArtifactPath(artifactFixture({ localTitle: "...   " }))).toContain("/Note — ");
  });

  it("preserves both semantic bodies and sorted/deduplicated tag sets inside collision-safe fences", () => {
    const input = artifactFixture({
      localSemantic: { bodyMarkdown: "```\n---\n# injected heading\n```\n", tags: ["zeta", "alpha", "zeta"] },
      notionSemantic: { bodyMarkdown: "~~~~\nstatus: injected\n~~~~\n", tags: ["remote", "alpha", "remote"] },
    });
    const artifact = renderConflictArtifact(input);

    expect(artifact).toContain("```\n---\n# injected heading\n```\n");
    expect(artifact).toContain("~~~~\nstatus: injected\n~~~~\n");
    expect(artifact).toContain('["alpha","zeta"]');
    expect(artifact).toContain('["alpha","remote"]');
    expect(artifact.startsWith("---\n")).toBe(false);
    expect(artifact).not.toContain("notion_sync:");
  });

  it("escapes user-controlled link and title fields while segment-wise encoding the local path", () => {
    const artifact = renderConflictArtifact(artifactFixture({
      localPath: "Notes/Unsafe [title] & space.md",
      localTitle: "Title ](javascript:alert(1))",
    }));

    expect(artifact).toContain("obsidian://open?path=Notes/Unsafe%20%5Btitle%5D%20%26%20space.md");
    expect(artifact).toContain(PAGE_URL);
    expect(artifact).not.toContain("](javascript:");
    expect(artifact).not.toContain("Title ](javascript:alert(1))");
  });

  it("is byte-identical on deterministic replay", () => {
    const input = artifactFixture();
    expect(renderConflictArtifact(input)).toBe(renderConflictArtifact(structuredClone(input)));
  });

  it("records trailing-newline distinction without weakening a collision-safe body fence", () => {
    const withoutTrailingNewline = artifactFixture({
      localSemantic: { bodyMarkdown: "x\n~~~~", tags: [] },
      notionSemantic: { bodyMarkdown: "remote", tags: [] },
    });
    const withTrailingNewline = artifactFixture({
      localSemantic: { bodyMarkdown: "x\n~~~~\n", tags: [] },
      notionSemantic: { bodyMarkdown: "remote", tags: [] },
    });
    const withoutArtifact = renderConflictArtifact(withoutTrailingNewline);
    const withArtifact = renderConflictArtifact(withTrailingNewline);

    expect(withoutArtifact).not.toBe(withArtifact);
    expect(withoutArtifact).toContain("Body UTF-8 bytes: 6");
    expect(withArtifact).toContain("Body UTF-8 bytes: 7");
    expect(withoutArtifact).toContain("~~~~~~~text\nx\n~~~~\n~~~~~~~");
    expect(withArtifact).toContain("~~~~~~~text\nx\n~~~~\n~~~~~~~");
  });

  it("fails closed when either semantic body exceeds its exact cap", () => {
    expect(() => renderConflictArtifact(artifactFixture({
      localSemantic: { bodyMarkdown: "x".repeat(1_048_577), tags: [] },
    }))).toThrow();
  });

  it("fails closed when collision-safe delimiters make the final artifact exceed its cap", () => {
    expect(() => renderConflictArtifact(artifactFixture({
      localSemantic: { bodyMarkdown: "~".repeat(1_048_576), tags: [] },
      notionSemantic: { bodyMarkdown: "remote", tags: [] },
    }))).toThrow();
  });

  it("returns the fixed conflict-artifact-too-large safe plan instead of a partial artifact", () => {
    const plan = planPair(conflictPlanningFixture("~".repeat(1_048_576), "remote"));

    expect(plan).toEqual({
      action: "error",
      reason: "conflict-artifact-too-large",
      identity: null,
      effects: [],
      error: { code: "conversion-failed", retryable: false },
      stateAdvance: { kind: "none" },
    });
  });
});
