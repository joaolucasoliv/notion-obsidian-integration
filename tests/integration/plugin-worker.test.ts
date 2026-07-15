import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { BridgeRunSummary } from "@grandbox-bridge/shared";
import { App, Notice } from "../fakes/obsidian.js";
import type { BridgeStatus, ServiceStatus, WorkerController } from "../../plugin/src/controller.js";
import type { ExternalLocator } from "../../plugin/src/locator.js";

vi.mock("obsidian", async () => import("../fakes/obsidian.js"));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function summary(mode: "preview" | "apply", writes = 0): BridgeRunSummary {
  return {
    mode,
    outcome: writes === 0 ? "noop" : "success",
    planned: writes,
    writes,
    pushed: writes,
    pulled: 0,
    conflicts: 0,
    errors: 0,
    graphUploads: 0,
    startedAt: "2026-07-15T12:00:00.000Z",
    completedAt: "2026-07-15T12:00:01.000Z",
  };
}

class PluginHarness {
  public readonly app = new App();
  public readonly workerCalls: Array<{ readonly mode: "preview" | "apply"; readonly reason: "manual" | "obsidian-event" }> = [];
  public savedPluginData: unknown = null;
  public plugin: any;
  private applyRuns = 0;

  public static async create(): Promise<PluginHarness> {
    const harness = new PluginHarness();
    const { GrandboxBridgePlugin } = await importPlugin();
    const controller: WorkerController = {
      preview: async () => {
        harness.workerCalls.push({ mode: "preview", reason: "manual" });
        return summary("preview");
      },
      syncNow: async () => {
        harness.applyRuns += 1;
        harness.workerCalls.push({ mode: "apply", reason: "manual" });
        return summary("apply", harness.applyRuns === 1 ? 1 : 0);
      },
      syncFromVaultEvent: async () => {
        harness.workerCalls.push({ mode: "apply", reason: "obsidian-event" });
        return summary("apply");
      },
      installService: async (): Promise<ServiceStatus> => ({ enabled: true }),
      disableService: async (): Promise<ServiceStatus> => ({ enabled: false }),
      status: async (): Promise<BridgeStatus> => ({ configuration: "ready", service: "disabled" }),
    };
    class TestPlugin extends GrandboxBridgePlugin {
      protected override createWorkerController(_locator: ExternalLocator): WorkerController { return controller; }
    }
    harness.plugin = new TestPlugin(harness.app, { id: "grandbox-bridge" });
    return harness;
  }

  public get savedPluginDataValue(): unknown {
    return this.plugin.savedPluginData;
  }

  public async runCommand(id: string): Promise<void> {
    const localId = id.replace("grandbox-bridge:", "");
    await this.plugin.commands.get(localId)?.callback?.();
    this.savedPluginData = this.plugin.savedPluginData;
  }
}

async function importPlugin() {
  return import("../../plugin/src/main.js");
}

describe("plugin to worker boundary", () => {
  it("stores only installationId and delegates sync to the worker", async () => {
    const h = await PluginHarness.create();
    await h.plugin.onload();
    await h.runCommand("grandbox-bridge:preview-sync");
    expect(h.savedPluginData).toEqual({ installationId: expect.stringMatching(UUID_RE) });
    expect(h.workerCalls).toEqual([{ mode: "preview", reason: "manual" }]);
    expect(JSON.stringify(h.savedPluginData)).not.toMatch(/token|pageId|graphKey|vaultPath/i);
  });

  it("leaves a GitHub-managed fixture byte-identical and reports zero writes on a second sync", async () => {
    const fixturePath = new URL("../fixtures/vault/Repositories/generated.md", import.meta.url);
    const before = await readFile(fixturePath, "utf8");
    const beforeHash = createHash("sha256").update(before).digest("hex");
    const h = await PluginHarness.create();
    await h.plugin.onload();
    await h.runCommand("grandbox-bridge:sync-now");
    await h.runCommand("grandbox-bridge:sync-now");
    const after = await readFile(fixturePath, "utf8");

    expect(createHash("sha256").update(after).digest("hex")).toBe(beforeHash);
    expect(h.workerCalls).toEqual([
      { mode: "apply", reason: "manual" },
      { mode: "apply", reason: "manual" },
    ]);
    expect(Notice.messages.join("\n")).toContain("No changes");
  });
});
