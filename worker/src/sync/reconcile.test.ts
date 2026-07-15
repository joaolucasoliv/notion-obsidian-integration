import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalVaultRoot } from "../vault/safety.js";
import { localRecoveryObservation, persistedLinkMapping, ReconciliationError, safeErrorFrom } from "./reconcile.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

describe("local recovery observation", () => {
  it("distinguishes a safe absent target from an unsafe path so recovery can fail closed", async () => {
    const vault = await mkdtemp(join(tmpdir(), "grandbox-reconcile-"));
    const root = await canonicalVaultRoot(vault, INSTALLATION_ID, { mode: "bootstrap" });

    await expect(localRecoveryObservation(root, "Missing.md")).resolves.toEqual({ kind: "missing" });
    await expect(localRecoveryObservation(root, "../outside.md")).rejects.toThrow();
  });
});

describe("persisted link mapping", () => {
  it("rejects duplicate stored local or Notion identities before a mapper can overwrite one claim", () => {
    const shared = {
      localPath: "Notes/Same.md",
      notionPageId: "22222222-2222-4222-8222-222222222222",
      status: "synced" as const,
      lastLocalSemanticHash: "a".repeat(64),
      lastNotionSemanticHash: "a".repeat(64),
      lastCommonSemanticHash: "a".repeat(64),
      lastCommonLocalByteHash: "a".repeat(64),
      lastNotionEditedAt: "2026-07-14T12:34:56.000Z",
      lastSyncedAt: "2026-07-14T12:34:56.000Z",
    };
    const state = {
      pairs: {
        "11111111-1111-4111-8111-111111111111": {
          bridgeId: "11111111-1111-4111-8111-111111111111",
          ...shared,
        },
        "33333333-3333-4333-8333-333333333333": {
          bridgeId: "33333333-3333-4333-8333-333333333333",
          ...shared,
        },
      },
    };

    expect(() => persistedLinkMapping(state)).toThrow("Reconciliation failed");
  });
});

describe("safe reconciliation errors", () => {
  it("preserves a validated fixed code through the worker-facing error mapper", () => {
    expect(safeErrorFrom(new ReconciliationError({ code: "identity-collision", retryable: false }))).toEqual({
      code: "identity-collision",
      retryable: false,
    });
  });
});
