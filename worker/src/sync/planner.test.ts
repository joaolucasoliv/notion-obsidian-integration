import { describe, expect, it } from "vitest";
import type { PairPlanningInput, PairStateV1 } from "@grandbox-bridge/shared";
import { deriveAllocationId, planPair, validatePlanningBatch } from "./planner.js";

const BRIDGE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BRIDGE_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PAGE_ID = "44444444-4444-4444-8444-444444444444";
const PAGE_URL = `https://www.notion.so/Alpha-${PAGE_ID.replaceAll("-", "")}`;
const COMMON_HASH = "1".repeat(64);
const LOCAL_HASH = "2".repeat(64);
const NOTION_HASH = "3".repeat(64);
const BYTE_HASH = "4".repeat(64);
const NEXT_BYTE_HASH = "5".repeat(64);
const ALLOCATION_ID = "6".repeat(64);
const DATE = "2026-07-14";
const EDITED_AT = "2026-07-14T12:34:56.000Z";

type FixtureOptions = {
  readonly localChanged?: boolean;
  readonly notionChanged?: boolean;
  readonly prior?: PairStateV1 | null;
  readonly local?: unknown;
  readonly notion?: unknown;
  readonly prepared?: Readonly<Record<string, unknown>>;
};

function priorState(overrides: Partial<PairStateV1> = {}): PairStateV1 {
  return {
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
    ...overrides,
  };
}

function planningFixture(options: FixtureOptions = {}): PairPlanningInput {
  const localChanged = options.localChanged ?? false;
  const notionChanged = options.notionChanged ?? false;
  const localBody = localChanged ? "Local body\n" : "Common body\n";
  const notionBody = notionChanged ? "Notion body\n" : "Common body\n";
  const local = {
    kind: "present",
    path: "Notes/Alpha.md",
    title: "Alpha",
    bridgeId: BRIDGE_ID,
    byteHash: BYTE_HASH,
    eligible: true,
    semantic: { bodyMarkdown: localBody, tags: ["alpha", "zeta"] },
    semanticHash: localChanged ? LOCAL_HASH : COMMON_HASH,
  };
  const notion = {
    kind: "present",
    pageId: PAGE_ID,
    bridgeId: BRIDGE_ID,
    editedAt: EDITED_AT,
    pageUrl: PAGE_URL,
    sourceMarkdown: notionBody,
    complete: true,
    unsupportedKinds: [],
    semantic: { bodyMarkdown: notionBody, tags: ["alpha", "zeta"] },
    semanticHash: notionChanged ? NOTION_HASH : COMMON_HASH,
    managed: { title: "Alpha", obsidianPath: "Notes/Alpha.md", status: "synced" },
  };
  const prepared: Record<string, unknown> = {
    allocationId: null,
    conflictDate: localChanged && notionChanged ? DATE : null,
    push: { notionMarkdown: localBody, unsupportedKinds: [] },
    pull: {
      nextBytes: "---\nnotion_sync: true\nbridge_id: 11111111-1111-4111-8111-111111111111\n---\nNotion body\n",
      nextByteHash: NEXT_BYTE_HASH,
    },
  };
  const input: Record<string, unknown> = {
    local,
    notion,
    prior: options.prior === undefined ? priorState() : options.prior,
    prepared,
  };

  if (options.local !== undefined) input.local = structuredClone(options.local);
  if (options.notion !== undefined) input.notion = structuredClone(options.notion);
  if (options.prepared !== undefined) Object.assign(prepared, structuredClone(options.prepared));
  return input as unknown as PairPlanningInput;
}

function mutable(input: PairPlanningInput): Record<string, any> {
  return input as unknown as Record<string, any>;
}

function firstPairFixture(options: { readonly bridgeId?: string | null; readonly allocationId?: string | null } = {}) {
  const input = mutable(planningFixture({ prior: null }));
  input.notion = { kind: "missing", pageId: null };
  input.local.bridgeId = options.bridgeId === undefined ? null : options.bridgeId;
  input.prepared.allocationId = options.allocationId === undefined ? ALLOCATION_ID : options.allocationId;
  input.prepared.conflictDate = null;
  input.prepared.pull = null;
  return input as PairPlanningInput;
}

function assertNoEffects(input: PairPlanningInput, action: string, reason: string, errorCode: string | null) {
  const plan = planPair(input);
  expect(plan.action).toBe(action);
  expect(plan.reason).toBe(reason);
  expect(plan.effects).toEqual([]);
  expect(plan.stateAdvance).toEqual({ kind: "none" });
  expect(plan.error?.code ?? null).toBe(errorCode);
}

function assertBackwardReferences(plan: ReturnType<typeof planPair>) {
  for (const [index, effect] of plan.effects.entries()) {
    const revision = (effect as { readonly expectedRevision?: { readonly kind: string; readonly effectIndex?: number } })
      .expectedRevision;
    if (revision?.kind === "effect-result") {
      expect(revision.effectIndex).toBeLessThan(index);
    }
  }

  const advance = plan.stateAdvance as Record<string, unknown>;
  for (const key of ["localEvidence", "notionEvidence", "notionRevision"] as const) {
    const evidence = advance[key] as { readonly kind?: string; readonly effectIndex?: number } | null | undefined;
    if (evidence?.kind === "effect-result") {
      expect(evidence.effectIndex).toBeGreaterThanOrEqual(0);
      expect(evidence.effectIndex).toBeLessThan(plan.effects.length);
    }
  }
}

describe("planPair", () => {
  it.each([
    [false, false, "noop"],
    [true, false, "push-local"],
    [false, true, "pull-notion"],
    [true, true, "conflict"],
  ] as const)("local changed=%s notion changed=%s => %s", (localChanged, notionChanged, action) => {
    const input = planningFixture({ localChanged, notionChanged });
    expect(planPair(input).action).toBe(action);
  });

  it("treats equal simultaneous semantic edits as convergence instead of a conflict", () => {
    const input = mutable(planningFixture({ localChanged: true, notionChanged: true }));
    input.notion.semantic = structuredClone(input.local.semantic);
    input.notion.semanticHash = LOCAL_HASH;
    input.notion.sourceMarkdown = input.prepared.push.notionMarkdown;
    input.prepared.conflictDate = null;

    const plan = planPair(input as PairPlanningInput);

    expect(plan.action).toBe("noop");
    expect(plan.reason).toBe("converged");
    expect(plan.effects).toEqual([]);
    expect(plan.stateAdvance).toMatchObject({
      kind: "establish-common",
      identity: { kind: "existing", bridgeId: BRIDGE_ID },
      semanticHash: LOCAL_HASH,
      localEvidence: { kind: "observation" },
      notionEvidence: { kind: "observation" },
    });
  });

  it("plans a deterministic allocation identity before a new pair is applied", () => {
    const input = firstPairFixture();
    const plan = planPair(input);

    expect(plan).toMatchObject({
      action: "initialize",
      reason: "first-pair",
      error: null,
      identity: { kind: "allocate-on-apply", allocationId: ALLOCATION_ID },
      effects: [
        {
          kind: "initialize-pair",
          identity: { kind: "allocate-on-apply", allocationId: ALLOCATION_ID },
          path: "Notes/Alpha.md",
          expectedByteHash: BYTE_HASH,
        },
        {
          kind: "create-notion-page",
          identity: { kind: "allocate-on-apply", allocationId: ALLOCATION_ID },
          title: "Alpha",
          obsidianPath: "Notes/Alpha.md",
          tags: ["alpha", "zeta"],
          markdown: "Common body\n",
          status: "synced",
        },
      ],
    });
    expect(plan.stateAdvance).toMatchObject({
      kind: "establish-common",
      identity: { kind: "allocate-on-apply", allocationId: ALLOCATION_ID },
      semanticHash: COMMON_HASH,
      localEvidence: { kind: "observation" },
      notionEvidence: { kind: "effect-result", effectIndex: 1 },
    });
    assertBackwardReferences(plan);
  });

  it("uses an existing local bridge ID for first pairing without allocating another", () => {
    const input = firstPairFixture({ bridgeId: BRIDGE_ID, allocationId: null });
    const plan = planPair(input);

    expect(plan.identity).toEqual({ kind: "existing", bridgeId: BRIDGE_ID });
    expect(plan.effects).toEqual([
      {
        kind: "create-notion-page",
        identity: { kind: "existing", bridgeId: BRIDGE_ID },
        title: "Alpha",
        obsidianPath: "Notes/Alpha.md",
        tags: ["alpha", "zeta"],
        markdown: "Common body\n",
        status: "synced",
      },
    ]);
    expect(plan.stateAdvance).toMatchObject({
      kind: "establish-common",
      notionEvidence: { kind: "effect-result", effectIndex: 0 },
    });
  });

  it("does not need or invoke a UUID source while making a preview-safe allocation plan", () => {
    const uuidSource = { randomUUID: () => { throw new Error("must not be called"); } };
    const plan = planPair(firstPairFixture());

    expect(uuidSource.randomUUID).toBeTypeOf("function");
    expect(plan.identity).toEqual({ kind: "allocate-on-apply", allocationId: ALLOCATION_ID });
  });

  it("returns a fixed conversion-safe error for malformed local content", () => {
    const input = planningFixture({
      local: { kind: "malformed", path: "Notes/Alpha.md", reason: "invalid-frontmatter" },
    });

    assertNoEffects(input, "error", "malformed-local", "conversion-failed");
  });

  it("rejects two missing sides rather than synthesizing a pair", () => {
    const input = mutable(planningFixture({ prior: null }));
    input.local = { kind: "missing", path: "Notes/Alpha.md" };
    input.notion = { kind: "missing", pageId: null };
    input.prepared = { allocationId: null, conflictDate: null, push: null, pull: null };

    assertNoEffects(input as PairPlanningInput, "error", "invalid-input", "invalid-response");
  });

  it("marks a trusted absent local note without copying either body", () => {
    const input = mutable(planningFixture());
    input.local = { kind: "missing", path: "Notes/Alpha.md" };
    input.prepared = { allocationId: null, conflictDate: null, push: null, pull: null };

    const plan = planPair(input as PairPlanningInput);

    expect(plan.action).toBe("missing-local");
    expect(plan.reason).toBe("local-missing");
    expect(plan.effects).toEqual([
      {
        kind: "set-notion-status",
        pageId: PAGE_ID,
        expectedStatus: "synced",
        nextStatus: "missing-local",
        expectedRevision: { kind: "observed", editedAt: EDITED_AT },
      },
    ]);
    expect(plan.stateAdvance).toMatchObject({
      kind: "preserve-common",
      status: "missing-local",
      localPath: "Notes/Alpha.md",
      notionRevision: { kind: "effect-result", effectIndex: 0 },
    });
    assertBackwardReferences(plan);
  });

  it("does not recreate a Notion page that disappeared from an existing pair", () => {
    const input = mutable(planningFixture());
    input.notion = { kind: "missing", pageId: PAGE_ID };
    input.prepared.pull = null;

    const plan = planPair(input as PairPlanningInput);

    expect(plan.action).toBe("missing-notion");
    expect(plan.reason).toBe("notion-missing");
    expect(plan.identity).toEqual({ kind: "existing", bridgeId: BRIDGE_ID });
    expect(plan.effects).toEqual([]);
    expect(plan.stateAdvance).toMatchObject({
      kind: "preserve-common",
      status: "missing-notion",
      localPath: "Notes/Alpha.md",
      notionRevision: null,
    });
  });

  it("detaches an ineligible note without reinitializing or copying content", () => {
    const input = mutable(planningFixture());
    input.local.eligible = false;
    input.prepared = { allocationId: null, conflictDate: null, push: null, pull: null };

    const plan = planPair(input as PairPlanningInput);

    expect(plan.action).toBe("detached");
    expect(plan.reason).toBe("not-eligible");
    expect(plan.effects).toEqual([
      {
        kind: "set-notion-status",
        pageId: PAGE_ID,
        expectedStatus: "synced",
        nextStatus: "detached",
        expectedRevision: { kind: "observed", editedAt: EDITED_AT },
      },
    ]);
    expect(plan.effects.some((effect) => effect.kind === "create-notion-page" || effect.kind === "write-local")).toBe(false);
  });

  it.each([
    [false, []],
    [true, ["raw-html"]],
  ] as const)("returns unsupported-notion for incomplete=%s or unsupported remote content", (complete, unsupportedKinds) => {
    const input = mutable(planningFixture());
    input.notion.complete = complete;
    input.notion.unsupportedKinds = unsupportedKinds;
    input.prepared.pull = null;

    assertNoEffects(input as PairPlanningInput, "error", "unsupported-notion", "unsupported-content");
  });

  it("returns unsupported-local for a prepared local mapping that cannot be represented", () => {
    const input = mutable(planningFixture());
    input.prepared.push.unsupportedKinds = ["raw-html"];

    assertNoEffects(input as PairPlanningInput, "error", "unsupported-local", "unsupported-content");
  });

  it.each([
    ["local bridge ID", (input: Record<string, any>) => { input.local.bridgeId = OTHER_BRIDGE_ID; }],
    ["Notion bridge ID", (input: Record<string, any>) => { input.notion.bridgeId = OTHER_BRIDGE_ID; }],
    ["Notion page ID", (input: Record<string, any>) => { input.notion.pageId = OTHER_PAGE_ID; }],
  ] as const)("fails closed on a per-pair %s mismatch", (_case, mutate) => {
    const input = mutable(planningFixture());
    mutate(input);

    assertNoEffects(input as PairPlanningInput, "error", "identity-mismatch", "identity-collision");
  });

  it("requires an existing pair before accepting a present Notion page", () => {
    const input = mutable(planningFixture({ prior: null }));
    input.prepared.conflictDate = null;

    assertNoEffects(input as PairPlanningInput, "error", "identity-mismatch", "identity-collision");
  });

  it("makes local title and path authoritative through a metadata-only properties update", () => {
    const input = mutable(planningFixture());
    input.notion.managed = { title: "Old title", obsidianPath: "Archive/Alpha.md", status: "synced" };

    const plan = planPair(input as PairPlanningInput);

    expect(plan.action).toBe("push-local");
    expect(plan.reason).toBe("metadata-drift");
    expect(plan.effects).toEqual([
      {
        kind: "update-notion-properties",
        pageId: PAGE_ID,
        expected: {
          title: "Old title",
          obsidianPath: "Archive/Alpha.md",
          tags: ["alpha", "zeta"],
          status: "synced",
        },
        next: {
          title: "Alpha",
          obsidianPath: "Notes/Alpha.md",
          tags: ["alpha", "zeta"],
          status: "synced",
        },
        expectedRevision: { kind: "observed", editedAt: EDITED_AT },
      },
    ]);
    expect(plan.stateAdvance).toMatchObject({
      kind: "preserve-common",
      status: "synced",
      notionRevision: { kind: "effect-result", effectIndex: 0 },
    });
    assertBackwardReferences(plan);
  });

  it("pushes tag-only local changes as properties without rewriting an equal body", () => {
    const input = mutable(planningFixture({ localChanged: true }));
    input.local.semantic = { bodyMarkdown: "Common body\n", tags: ["alpha", "local"] };
    input.notion.semantic = { bodyMarkdown: "Common body\n", tags: ["alpha"] };
    input.notion.sourceMarkdown = "Common body\n";
    input.prepared.push = { notionMarkdown: "Common body\n", unsupportedKinds: [] };

    const plan = planPair(input as PairPlanningInput);

    expect(plan.action).toBe("push-local");
    expect(plan.reason).toBe("local-changed");
    expect(plan.effects).toEqual([
      {
        kind: "update-notion-properties",
        pageId: PAGE_ID,
        expected: { title: "Alpha", obsidianPath: "Notes/Alpha.md", tags: ["alpha"], status: "synced" },
        next: { title: "Alpha", obsidianPath: "Notes/Alpha.md", tags: ["alpha", "local"], status: "synced" },
        expectedRevision: { kind: "observed", editedAt: EDITED_AT },
      },
    ]);
    expect(plan.effects.some((effect) => effect.kind === "update-notion-body-exact")).toBe(false);
    assertBackwardReferences(plan);
  });

  it("pulls tag-only Notion changes as an exact local write without a remote rewrite", () => {
    const input = mutable(planningFixture({ notionChanged: true }));
    input.local.semantic = { bodyMarkdown: "Common body\n", tags: ["alpha"] };
    input.notion.semantic = { bodyMarkdown: "Common body\n", tags: ["alpha", "remote"] };
    input.notion.sourceMarkdown = "Common body\n";

    const plan = planPair(input as PairPlanningInput);

    expect(plan.action).toBe("pull-notion");
    expect(plan.reason).toBe("notion-changed");
    expect(plan.effects).toEqual([
      {
        kind: "write-local",
        path: "Notes/Alpha.md",
        expectedByteHash: BYTE_HASH,
        nextBytes: input.prepared.pull.nextBytes,
        expectedNextByteHash: NEXT_BYTE_HASH,
      },
    ]);
    expect(plan.effects.some((effect) => effect.kind === "update-notion-properties")).toBe(false);
    expect(plan.stateAdvance).toMatchObject({
      kind: "establish-common",
      semanticHash: NOTION_HASH,
      localEvidence: { kind: "effect-result", effectIndex: 0 },
      notionEvidence: { kind: "observation" },
    });
    assertBackwardReferences(plan);
  });

  it("orders an exact body update before the accompanying managed properties update", () => {
    const input = mutable(planningFixture({ localChanged: true }));
    input.local.semantic = { bodyMarkdown: "Local body\n", tags: ["alpha", "local"] };
    input.notion.semantic = { bodyMarkdown: "Common body\n", tags: ["alpha"] };
    input.notion.sourceMarkdown = "Common body\n";
    input.prepared.push = { notionMarkdown: "Local mapped body\n", unsupportedKinds: [] };

    const plan = planPair(input as PairPlanningInput);

    expect(plan.effects).toEqual([
      {
        kind: "update-notion-body-exact",
        pageId: PAGE_ID,
        oldMarkdown: "Common body\n",
        newMarkdown: "Local mapped body\n",
        expectedRevision: { kind: "observed", editedAt: EDITED_AT },
      },
      {
        kind: "update-notion-properties",
        pageId: PAGE_ID,
        expected: { title: "Alpha", obsidianPath: "Notes/Alpha.md", tags: ["alpha"], status: "synced" },
        next: { title: "Alpha", obsidianPath: "Notes/Alpha.md", tags: ["alpha", "local"], status: "synced" },
        expectedRevision: { kind: "effect-result", effectIndex: 0 },
      },
    ]);
    expect(plan.stateAdvance).toMatchObject({
      kind: "establish-common",
      semanticHash: LOCAL_HASH,
      localEvidence: { kind: "observation" },
      notionEvidence: { kind: "effect-result", effectIndex: 1 },
    });
    assertBackwardReferences(plan);
  });

  it("returns an exactly empty effect list for a true noop", () => {
    const plan = planPair(planningFixture());

    expect(plan).toMatchObject({ action: "noop", reason: "unchanged", error: null, effects: [], stateAdvance: { kind: "none" } });
  });

  it("pauses an already-conflicted prior pair without creating another artifact", () => {
    const plan = planPair(planningFixture({ prior: priorState({ status: "conflict" }) }));

    expect(plan).toMatchObject({
      action: "conflict",
      reason: "conflict-paused",
      error: null,
      effects: [],
      stateAdvance: { kind: "none" },
    });
  });

  it("creates a deterministic conflict artifact before marking the remote pair conflicted", () => {
    const plan = planPair(planningFixture({ localChanged: true, notionChanged: true }));

    expect(plan.action).toBe("conflict");
    expect(plan.reason).toBe("concurrent-change");
    expect(plan.effects).toHaveLength(2);
    expect(plan.effects[0]).toMatchObject({
      kind: "create-conflict",
      path: `Bridge Conflicts/${DATE}/Alpha — ${BRIDGE_ID}.md`,
      expectedAbsent: true,
    });
    expect(plan.effects[1]).toEqual({
      kind: "set-notion-status",
      pageId: PAGE_ID,
      expectedStatus: "synced",
      nextStatus: "conflict",
      expectedRevision: { kind: "observed", editedAt: EDITED_AT },
    });
    expect(plan.stateAdvance).toMatchObject({
      kind: "preserve-common",
      status: "conflict",
      notionRevision: { kind: "effect-result", effectIndex: 1 },
    });
    assertBackwardReferences(plan);
  });

  it("routes a whitespace and punctuation title through the sanitized conflict artifact path", () => {
    const input = mutable(planningFixture({ localChanged: true, notionChanged: true }));
    input.local.title = "  Roadmap / phase...  ";

    const plan = planPair(input as PairPlanningInput);

    expect(plan.action).toBe("conflict");
    expect(plan.effects[0]).toMatchObject({
      kind: "create-conflict",
      path: `Bridge Conflicts/${DATE}/Roadmap - phase — ${BRIDGE_ID}.md`,
    });
  });

  it.each([
    ["uppercase semantic hash", (input: Record<string, any>) => { input.local.semanticHash = "A".repeat(64); }],
    ["non-calendar conflict date", (input: Record<string, any>) => { input.prepared.conflictDate = "2026-02-30"; input.local.semanticHash = LOCAL_HASH; input.notion.semanticHash = NOTION_HASH; }],
    ["untrusted page URL", (input: Record<string, any>) => { input.notion.pageUrl = "https://example.com/unsafe"; }],
    ["unsafe local path", (input: Record<string, any>) => { input.local.path = "../Alpha.md"; }],
    ["inconsistent preparation", (input: Record<string, any>) => { input.prepared.push = null; }],
  ] as const)("returns only a fixed safe error for %s", (_case, mutate) => {
    const input = mutable(planningFixture({ localChanged: true, notionChanged: true }));
    mutate(input);

    const plan = planPair(input as PairPlanningInput);

    expect(plan).toEqual({
      action: "error",
      reason: "invalid-input",
      identity: null,
      effects: [],
      error: { code: "invalid-response", retryable: false },
      stateAdvance: { kind: "none" },
    });
  });

  it("does not mutate input and detaches effect tag arrays from it", () => {
    const input = mutable(firstPairFixture({ bridgeId: BRIDGE_ID, allocationId: null }));
    const before = structuredClone(input);
    const plan = planPair(input as PairPlanningInput);
    const create = plan.effects[0] as { readonly tags: readonly string[] };

    expect(input).toEqual(before);
    expect(create.tags).toEqual(["alpha", "zeta"]);
    expect(create.tags).not.toBe(input.local.semantic.tags);
    input.local.semantic.tags.push("later");
    expect(create.tags).toEqual(["alpha", "zeta"]);
  });
});

describe("validatePlanningBatch", () => {
  it.each([
    ["Bridge ID", (first: Record<string, any>, second: Record<string, any>) => { second.local.bridgeId = first.local.bridgeId; second.notion.bridgeId = first.notion.bridgeId; second.prior.bridgeId = first.prior.bridgeId; }],
    ["local path", (first: Record<string, any>, second: Record<string, any>) => { second.local.path = first.local.path; }],
    ["Notion page ID", (first: Record<string, any>, second: Record<string, any>) => { second.notion.pageId = first.notion.pageId; second.prior.notionPageId = first.prior.notionPageId; }],
  ] as const)("rejects duplicate %s claims across pairs", (_kind, collide) => {
    const first = mutable(planningFixture());
    const second = mutable(planningFixture({ prior: priorState({ bridgeId: OTHER_BRIDGE_ID, notionPageId: OTHER_PAGE_ID, localPath: "Notes/Beta.md" }) }));
    second.local.bridgeId = OTHER_BRIDGE_ID;
    second.local.path = "Notes/Beta.md";
    second.notion.bridgeId = OTHER_BRIDGE_ID;
    second.notion.pageId = OTHER_PAGE_ID;
    second.notion.pageUrl = `https://www.notion.so/Beta-${OTHER_PAGE_ID.replaceAll("-", "")}`;
    collide(first, second);

    expect(validatePlanningBatch([first as PairPlanningInput, second as PairPlanningInput])).toEqual({
      ok: false,
      reason: "identity-collision",
      error: { code: "identity-collision", retryable: false },
    });
  });

  it("rejects duplicate first-pair allocation identities", () => {
    const first = firstPairFixture({ allocationId: ALLOCATION_ID });
    const second = mutable(firstPairFixture({ allocationId: ALLOCATION_ID }));
    second.local.path = "Notes/Beta.md";
    second.local.title = "Beta";

    expect(validatePlanningBatch([first, second as PairPlanningInput])).toMatchObject({
      ok: false,
      reason: "identity-collision",
      error: { code: "identity-collision", retryable: false },
    });
  });

  it("rejects duplicate remote managed paths across otherwise distinct pairs", () => {
    const first = mutable(planningFixture());
    const second = mutable(planningFixture({
      prior: priorState({ bridgeId: OTHER_BRIDGE_ID, notionPageId: OTHER_PAGE_ID, localPath: "Notes/Beta.md" }),
    }));
    second.local.bridgeId = OTHER_BRIDGE_ID;
    second.local.path = "Notes/Beta.md";
    second.notion.bridgeId = OTHER_BRIDGE_ID;
    second.notion.pageId = OTHER_PAGE_ID;
    second.notion.pageUrl = `https://www.notion.so/Beta-${OTHER_PAGE_ID.replaceAll("-", "")}`;
    second.notion.managed = { title: "Beta", obsidianPath: first.notion.managed.obsidianPath, status: "synced" };

    expect(validatePlanningBatch([first as PairPlanningInput, second as PairPlanningInput])).toEqual({
      ok: false,
      reason: "identity-collision",
      error: { code: "identity-collision", retryable: false },
    });
  });

  it("permits repeated matching identity claims within a single consistent pair", () => {
    expect(validatePlanningBatch([planningFixture()])).toEqual({ ok: true });
  });
});

describe("deriveAllocationId", () => {
  it("uses the exact deterministic allocation-domain separator golden vector", async () => {
    await expect(deriveAllocationId("Notes/Alpha.md", BYTE_HASH)).resolves.toBe(
      "ae1a4c3ccd15e8264c1e3d8b2e09ad6e685c162c08da3a947860ac4b2a2c0eb9",
    );
  });
});
