import { expect, it } from "vitest";
import type {
  ManagedPropertiesSnapshot,
  PairStateAdvance,
  PlannedEffect,
  RemoteRevisionRef,
} from "./core.js";
import type { PairPlan } from "./planning.js";

const HASH = "a".repeat(64);
const BRIDGE_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const EDITED_AT = "2026-07-14T12:34:56.000Z";

it("keeps every pair-specific mutation payload explicit in the shared planned-effect contract", () => {
  const revision: RemoteRevisionRef = { kind: "observed", editedAt: EDITED_AT };
  const expected: ManagedPropertiesSnapshot = {
    title: "Alpha",
    obsidianPath: "Notes/Alpha.md",
    tags: ["alpha"],
    status: "synced",
  };
  const effects: readonly PlannedEffect[] = [
    { kind: "initialize-pair", identity: { kind: "existing", bridgeId: BRIDGE_ID }, path: "Notes/Alpha.md", expectedByteHash: HASH },
    { kind: "create-notion-page", identity: { kind: "existing", bridgeId: BRIDGE_ID }, title: "Alpha", obsidianPath: "Notes/Alpha.md", tags: ["alpha"], markdown: "Body\n", status: "synced" },
    { kind: "update-notion-body-exact", pageId: PAGE_ID, oldMarkdown: "Old\n", newMarkdown: "New\n", expectedRevision: revision },
    { kind: "update-notion-properties", pageId: PAGE_ID, expected, next: expected, expectedRevision: revision },
    { kind: "write-local", path: "Notes/Alpha.md", expectedByteHash: HASH, nextBytes: "Bytes", expectedNextByteHash: HASH },
    { kind: "create-conflict", path: "Bridge Conflicts/2026-07-14/Alpha — 11111111-1111-4111-8111-111111111111.md", expectedAbsent: true, content: "Artifact" },
    { kind: "set-notion-status", pageId: PAGE_ID, expectedStatus: "synced", nextStatus: "conflict", expectedRevision: revision },
  ];
  const advance: PairStateAdvance = { kind: "none" };
  const plan: PairPlan = { action: "noop", reason: "unchanged", identity: null, effects, error: null, stateAdvance: advance };

  expect(plan.effects).toHaveLength(7);
});
