import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeRunSummary } from "@grandbox-bridge/shared";
import { App, Notice, TFile } from "../../tests/fakes/obsidian.js";
import type { ExternalLocator } from "./locator.js";
import type { BridgeStatus, ServiceStatus, WorkerController } from "./controller.js";
import { NodeServiceCommandRunner, type ServiceProcessCommand } from "./service-manager.js";
import { deriveExternalLocator } from "./locator.js";

vi.mock("obsidian", async () => import("../../tests/fakes/obsidian.js"));

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

function summary(mode: "preview" | "apply" = "preview"): BridgeRunSummary {
  return {
    mode,
    outcome: "success",
    planned: 0,
    writes: 0,
    pushed: 0,
    pulled: 0,
    conflicts: 0,
    errors: 0,
    graphUploads: 0,
    startedAt: "2026-07-15T12:00:00.000Z",
    completedAt: "2026-07-15T12:00:01.000Z",
  };
}

async function runCommand(plugin: unknown, id: string): Promise<void> {
  const commands = (plugin as { commands: Map<string, { callback?: () => unknown }> }).commands;
  await commands.get(id)?.callback?.();
}

class ManualScheduler {
  public readonly pending: Array<() => void> = [];

  public set(callback: () => void): number {
    this.pending.splice(0, this.pending.length, callback);
    return 1;
  }

  public clear(_handle: number): void {
    this.pending.length = 0;
  }

  public flush(): void {
    this.pending.shift()?.();
  }
}

class RecordingController implements WorkerController {
  public readonly calls: Array<{ readonly mode: "preview" | "apply"; readonly reason: "manual" | "obsidian-event" }> = [];
  public statusValue: BridgeStatus = { configuration: "ready", service: "disabled" };

  public async preview(): Promise<BridgeRunSummary> {
    this.calls.push({ mode: "preview", reason: "manual" });
    return summary("preview");
  }

  public async syncNow(): Promise<BridgeRunSummary> {
    this.calls.push({ mode: "apply", reason: "manual" });
    return summary("apply");
  }

  public async syncFromVaultEvent(): Promise<BridgeRunSummary> {
    this.calls.push({ mode: "apply", reason: "obsidian-event" });
    return summary("apply");
  }

  public async installService(): Promise<ServiceStatus> { return { enabled: true }; }
  public async disableService(): Promise<ServiceStatus> { return { enabled: false }; }
  public async status(): Promise<BridgeStatus> { return this.statusValue; }
}

async function serviceLocator(): Promise<ExternalLocator> {
  const homeDirectory = await realpath(await mkdtemp(join(tmpdir(), "grandbox-plugin-main-service-")));
  const nodeExecutable = join(homeDirectory, "node");
  const workerPath = join(homeDirectory, "bridge-worker.cjs");
  const locator = deriveExternalLocator({ installationId: INSTALLATION_ID, homeDirectory, nodeExecutable, workerPath });
  await mkdir(dirname(locator.configPath), { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(nodeExecutable, "node", { mode: 0o700 }),
    writeFile(workerPath, "worker", { mode: 0o600 }),
    writeFile(locator.configPath, "{}", { mode: 0o600 }),
  ]);
  await Promise.all([chmod(nodeExecutable, 0o700), chmod(workerPath, 0o600), chmod(locator.configPath, 0o600)]);
  return locator;
}

describe("GrandboxBridgePlugin", () => {
  beforeEach(() => Notice.clear());

  it("constructs a concrete service manager without load-time process execution and reaches the hardened boundary on explicit controls", async () => {
    const { GrandboxBridgePlugin } = await import("./main.js");
    const locator = await serviceLocator();
    const commands: ServiceProcessCommand[] = [];
    let enabled = false;
    const runner = new NodeServiceCommandRunner({
      run: async (command: ServiceProcessCommand) => {
        commands.push(command);
        const action = command.args[0];
        if (action === "bootout") {
          const wasEnabled = enabled;
          enabled = false;
          return { code: wasEnabled ? 0 : 113 };
        }
        if (action === "bootstrap") {
          enabled = true;
          return { code: 0 };
        }
        if (action === "print") return { code: enabled ? 0 : 113 };
        throw new Error("unexpected service action");
      },
    });
    class TestPlugin extends GrandboxBridgePlugin {
      protected override deriveLocator(_id: string): ExternalLocator { return locator; }
      protected override createServiceCommandRunner(): NodeServiceCommandRunner { return runner; }
      protected override serviceUserId(): number { return 501; }
    }
    const plugin = new TestPlugin(new App(), { id: "grandbox-bridge" });

    await plugin.onload();
    expect(commands).toEqual([]);

    await runCommand(plugin, "show-status");
    await runCommand(plugin, "install-service");
    await runCommand(plugin, "disable-service");

    const label = `com.grandbox.bridge.${INSTALLATION_ID}`;
    const plistPath = join(locator.homeDirectory, "Library", "LaunchAgents", `${label}.plist`);
    expect(commands).toEqual([
      { executable: "/bin/launchctl", args: ["print", `gui/501/${label}`], shell: false },
      { executable: "/bin/launchctl", args: ["bootout", "gui/501", plistPath], shell: false },
      { executable: "/bin/launchctl", args: ["bootstrap", "gui/501", plistPath], shell: false },
      { executable: "/bin/launchctl", args: ["print", `gui/501/${label}`], shell: false },
      { executable: "/bin/launchctl", args: ["bootout", "gui/501", plistPath], shell: false },
      { executable: "/bin/launchctl", args: ["print", `gui/501/${label}`], shell: false },
    ]);
    expect(Notice.messages).toEqual([
      "Grandbox Bridge: ready; background service disabled.",
      "Grandbox Bridge: background service enabled.",
      "Grandbox Bridge: background service disabled.",
    ]);
  });

  it("waits for layout-ready before registering debounced vault listeners", async () => {
    const { GrandboxBridgePlugin } = await import("./main.js");
    const app = new App();
    const controller = new RecordingController();
    const scheduler = new ManualScheduler();
    class TestPlugin extends GrandboxBridgePlugin {
      protected override createWorkerController(_locator: ExternalLocator): WorkerController { return controller; }
      protected override createDebounceScheduler(): ManualScheduler { return scheduler; }
    }
    const plugin = new TestPlugin(app, { id: "grandbox-bridge" });
    const note = app.vault.addFile("Notes/Changed.md", "---\nnotion_sync: true\n---\nBody\n");

    await plugin.onload();
    expect(app.workspace.layoutReadyCallbackCount).toBe(1);
    expect(app.vault.listenerCount("modify")).toBe(0);
    app.workspace.triggerLayoutReady();
    expect(app.vault.listenerCount("modify")).toBe(1);
    expect(app.vault.listenerCount("rename")).toBe(1);
    await app.vault.emit("modify", note);
    await app.vault.emit("rename", note);
    expect(controller.calls).toEqual([]);
    scheduler.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.calls).toEqual([{ mode: "apply", reason: "obsidian-event" }]);
  });

  it("never queues generated GitHub fixture events while allowing a manual repository note", async () => {
    const { GrandboxBridgePlugin } = await import("./main.js");
    const app = new App();
    const controller = new RecordingController();
    const scheduler = new ManualScheduler();
    class TestPlugin extends GrandboxBridgePlugin {
      protected override createWorkerController(_locator: ExternalLocator): WorkerController { return controller; }
      protected override createDebounceScheduler(): ManualScheduler { return scheduler; }
    }
    const plugin = new TestPlugin(app, { id: "grandbox-bridge" });
    const generated = app.vault.addFile(
      "Repositories/generated.md",
      await readFile(new URL("../../tests/fixtures/vault/Repositories/generated.md", import.meta.url), "utf8"),
    );
    const manual = app.vault.addFile(
      "Repositories/manual.md",
      await readFile(new URL("../../tests/fixtures/vault/Repositories/manual.md", import.meta.url), "utf8"),
    );

    await plugin.onload();
    app.workspace.triggerLayoutReady();
    await app.vault.emit("modify", generated);
    await app.vault.emit("rename", generated);

    expect(scheduler.pending).toHaveLength(0);
    expect(controller.calls).toEqual([]);

    await app.vault.emit("modify", manual);
    expect(scheduler.pending).toHaveLength(1);
    scheduler.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.calls).toEqual([{ mode: "apply", reason: "obsidian-event" }]);
  });

  it("reuses one installation ID and never persists the injected controller state", async () => {
    const { GrandboxBridgePlugin } = await import("./main.js");
    const app = new App();
    const controller = new RecordingController();
    class TestPlugin extends GrandboxBridgePlugin {
      protected override createWorkerController(_locator: ExternalLocator): WorkerController { return controller; }
    }
    const first = new TestPlugin(app, { id: "grandbox-bridge" });
    await first.onload();
    const generated = first.savedPluginData;
    expect(generated).toEqual({ installationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u) });

    const second = new TestPlugin(app, { id: "grandbox-bridge" });
    second.initialData = generated;
    await second.onload();
    expect(second.savedPluginData).toBeNull();
    expect(JSON.stringify(first.savedPluginData)).not.toMatch(/token|pageId|graphKey|vaultPath/i);
  });

  it("uses safe notices instead of raw controller failure text", async () => {
    const { GrandboxBridgePlugin } = await import("./main.js");
    const app = new App();
    class FailingController extends RecordingController {
      public override async preview(): Promise<BridgeRunSummary> { throw new Error("synthetic-provider-token /Users/private/note.md"); }
    }
    const controller = new FailingController();
    class TestPlugin extends GrandboxBridgePlugin {
      protected override createWorkerController(_locator: ExternalLocator): WorkerController { return controller; }
    }
    const plugin = new TestPlugin(app, { id: "grandbox-bridge" });
    await plugin.onload();

    await runCommand(plugin, "preview-sync");

    expect(Notice.messages.join("\n")).toContain("unavailable");
    expect(Notice.messages.join("\n")).not.toMatch(/synthetic-provider-token|Users\/private|note\.md/i);
  });

  it("runs opt-in and opt-out commands only against the active Markdown note", async () => {
    const { GrandboxBridgePlugin } = await import("./main.js");
    const app = new App();
    const controller = new RecordingController();
    class TestPlugin extends GrandboxBridgePlugin {
      protected override createWorkerController(_locator: ExternalLocator): WorkerController { return controller; }
    }
    const plugin = new TestPlugin(app, { id: "grandbox-bridge" });
    const note = app.vault.addFile("Notes/Active.md", "---\ncustom: retained\nnotion_sync: false\n---\nBody\n");
    app.workspace.setActiveFile(note);
    await plugin.onload();

    await runCommand(plugin, "opt-in");
    expect(await app.vault.read(note)).toBe("---\ncustom: retained\nnotion_sync: true\n---\nBody\n");
    await runCommand(plugin, "opt-out");
    expect(await app.vault.read(note)).toBe("---\ncustom: retained\nnotion_sync: false\n---\nBody\n");
  });

  it("leaves a quoted tag-only GitHub generated note unchanged when changing opt-in", async () => {
    const { GrandboxBridgePlugin } = await import("./main.js");
    const app = new App();
    const controller = new RecordingController();
    class TestPlugin extends GrandboxBridgePlugin {
      protected override createWorkerController(_locator: ExternalLocator): WorkerController { return controller; }
    }
    const plugin = new TestPlugin(app, { id: "grandbox-bridge" });
    const before = "---\nnotion_sync: false\ntags: [\"dual-scribe/github/repository\"]\n---\nGenerated body\n";
    const note = app.vault.addFile("Repositories/tag-only.md", before);
    app.workspace.setActiveFile(note);
    await plugin.onload();

    await runCommand(plugin, "opt-in");
    await runCommand(plugin, "opt-out");

    expect(await app.vault.read(note)).toBe(before);
    expect(app.vault.modified).toEqual([]);
    expect(Notice.messages.every((message) => message.includes("note action unavailable"))).toBe(true);
  });
});
