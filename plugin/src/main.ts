import { Notice, Plugin, TFile, type TAbstractFile } from "obsidian";
import type { BridgeRunSummary } from "@grandbox-bridge/shared";
import { changeNoteOptIn, isGeneratedGithubNote, isManageableMarkdownPath } from "./commands.js";
import {
  LocalWorkerController,
  supportsCortexSetup,
  supportsNotionSetup,
  NodeWorkerProcessRunner,
  supportsEventSync,
  type BridgeStatus,
  type CortexSetupInput,
  type CortexSetupResult,
  type NotionConnectionInput,
  type NotionConnectionResult,
  type WorkerController,
} from "./controller.js";
import { deriveExternalLocator, isCanonicalInstallationId, type ExternalLocator } from "./locator.js";
import { resolveNodeExecutable } from "./node-runtime.js";
import { NodeServiceCommandRunner, RuntimeServiceManager } from "./service-manager.js";
import { GrandboxBridgeSettingTab } from "./settings.js";
import { STATUS_NOTE_PATH, updateStatusNote } from "./status-note.js";

const EVENT_DEBOUNCE_MS = 750;

interface PluginData {
  readonly installationId: string;
}

interface DebounceScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

function pluginError(): Error {
  return new Error("Bridge plugin unavailable");
}

function parsePluginData(value: unknown): PluginData | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw pluginError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !isCanonicalInstallationId(record.installationId)) throw pluginError();
  return Object.freeze({ installationId: record.installationId });
}

function installationId(): string {
  const created = globalThis.crypto?.randomUUID?.();
  if (!isCanonicalInstallationId(created)) throw pluginError();
  return created;
}

function browserScheduler(): DebounceScheduler {
  return {
    set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  };
}

function safeStatusFallback(): BridgeStatus {
  return Object.freeze({ configuration: "attention", service: "unknown" });
}

function actionNotice(summary: BridgeRunSummary): string {
  if (summary.outcome === "noop") return "Grandbox Bridge: No changes.";
  if (summary.outcome === "failed" || summary.outcome === "recovery-required") {
    return "Grandbox Bridge: sync needs attention.";
  }
  return `Grandbox Bridge: ${summary.writes} writes, ${summary.conflicts} conflicts, ${summary.errors} errors.`;
}

function notionConnectionNotice(result: NotionConnectionResult): string {
  if (result.error === "not-found") {
    return "Grandbox Bridge: choose a parent page, not a workspace ID, then add The Grandbox Connection to that page.";
  }
  if (result.error === "authentication-failed") {
    return "Grandbox Bridge: Notion rejected the connection token. Create or copy a fresh token and try again.";
  }
  if (result.error === "authorization-failed") {
    return "Grandbox Bridge: share the parent page with The Grandbox Connection and enable Read, Insert, and Update content.";
  }
  if (result.error === "rate-limited") return "Grandbox Bridge: Notion is temporarily rate-limiting this connection. Try again shortly.";
  if (result.error === "network-failed" || result.error === "timeout") {
    return "Grandbox Bridge: Notion could not be reached. Check your connection and try again.";
  }
  if (result.error !== undefined) return "Grandbox Bridge: Notion connection unavailable.";
  return result.created ? "Grandbox Bridge: Notion connected." : "Grandbox Bridge: Notion connection restored.";
}

function cortexSetupNotice(result: CortexSetupResult): string {
  if (result.error === "not-found") {
    return "Grandbox Bridge: choose The Cortex root page and share it with The Grandbox Connection.";
  }
  if (result.error === "authorization-failed") {
    return "Grandbox Bridge: share The Cortex root page with The Grandbox Connection.";
  }
  if (result.error !== undefined) return "Grandbox Bridge: Cortex setup unavailable.";
  return result.created ? "Grandbox Bridge: The Cortex connected." : "Grandbox Bridge: The Cortex is ready.";
}

function cortexSyncNotice(summary: BridgeRunSummary): string {
  if (summary.outcome === "noop") return "Grandbox Bridge: The Cortex has no changes.";
  if (summary.outcome === "failed" || summary.outcome === "recovery-required") {
    return "Grandbox Bridge: The Cortex sync needs attention.";
  }
  return `Grandbox Bridge: The Cortex synced: ${summary.writes} writes, ${summary.conflicts} conflicts, ${summary.errors} errors.`;
}

export class GrandboxBridgePlugin extends Plugin {
  private controller: WorkerController | null = null;
  private scheduler: DebounceScheduler | null = null;
  private debounceHandle: unknown = null;
  private actionTail: Promise<void> = Promise.resolve();

  public override async onload(): Promise<void> {
    const stored = parsePluginData(await this.loadData());
    const id = stored?.installationId ?? installationId();
    if (stored === null) await this.saveData(Object.freeze({ installationId: id }));
    const locator = this.deriveLocator(id);
    this.controller = this.createWorkerController(locator);
    this.scheduler = this.createDebounceScheduler();
    this.addSettingTab(new GrandboxBridgeSettingTab(this.app, this, {
      preview: () => this.preview(),
      syncNow: () => this.syncNow(),
      connectNotion: (input) => this.connectNotion(input),
      configureCortex: (input) => this.configureCortex(input),
      syncCortex: () => this.syncCortex(),
      cortexStatus: () => this.showCortexStatus(),
      installService: () => this.installService(),
      disableService: () => this.disableService(),
      status: () => this.readStatus(),
    }));
    this.registerCommands();
    this.app.workspace.onLayoutReady(() => this.registerVaultListeners());
  }

  public override onunload(): void {
    if (this.scheduler !== null && this.debounceHandle !== null) this.scheduler.clear(this.debounceHandle);
    this.debounceHandle = null;
  }

  protected createWorkerController(locator: ExternalLocator): WorkerController {
    return new LocalWorkerController(
      locator,
      new NodeWorkerProcessRunner(),
      new RuntimeServiceManager(() => this.serviceUserId(), this.createServiceCommandRunner()),
    );
  }

  /** Construction is inert; the runner is invoked only by an explicit service control. */
  protected createServiceCommandRunner(): NodeServiceCommandRunner {
    return new NodeServiceCommandRunner();
  }

  protected serviceUserId(): number {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) throw pluginError();
    return uid;
  }

  protected createDebounceScheduler(): DebounceScheduler {
    return browserScheduler();
  }

  protected deriveLocator(id: string): ExternalLocator {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    const vaultRoot = adapter.getBasePath?.();
    const homeDirectory = process.env.HOME;
    if (typeof vaultRoot !== "string" || typeof homeDirectory !== "string" || typeof process.execPath !== "string") {
      throw pluginError();
    }
    return deriveExternalLocator({
      installationId: id,
      homeDirectory,
      vaultRoot,
      nodeExecutable: resolveNodeExecutable({ homeDirectory, path: process.env.PATH }),
      workerPath: `${vaultRoot}/${this.app.vault.configDir}/plugins/${this.manifest.id}/bridge-worker.cjs`,
    });
  }

  private registerCommands(): void {
    this.addCommand({ id: "preview-sync", name: "Preview sync", callback: () => this.preview() });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow() });
    this.addCommand({ id: "opt-in", name: "Opt active note into sync", callback: () => this.changeActiveNote(true) });
    this.addCommand({ id: "opt-out", name: "Opt active note out of sync", callback: () => this.changeActiveNote(false) });
    this.addCommand({ id: "install-service", name: "Install background service", callback: () => this.installService() });
    this.addCommand({ id: "disable-service", name: "Disable background service", callback: () => this.disableService() });
    this.addCommand({ id: "show-status", name: "Show bridge status", callback: () => this.showStatus() });
  }

  private registerVaultListeners(): void {
    this.registerEvent(this.app.vault.on("modify", (file) => this.scheduleVaultEvent(file)));
    this.registerEvent(this.app.vault.on("rename", (file) => this.scheduleVaultEvent(file)));
  }

  private async scheduleVaultEvent(file: TAbstractFile): Promise<void> {
    if (this.scheduler === null || !(file instanceof TFile) || !isManageableMarkdownPath(file.path)) return;
    let bytes: string;
    try {
      bytes = await this.app.vault.read(file);
    } catch {
      return;
    }
    if (isGeneratedGithubNote(bytes)) return;
    if (this.debounceHandle !== null) this.scheduler.clear(this.debounceHandle);
    this.debounceHandle = this.scheduler.set(() => {
      this.debounceHandle = null;
      void this.syncFromVaultEvent();
    }, EVENT_DEBOUNCE_MS);
  }

  private async preview(): Promise<void> {
    await this.runWorkerAction((controller) => controller.preview());
  }

  private async syncNow(): Promise<void> {
    await this.runWorkerAction((controller) => controller.syncNow());
  }

  private async connectNotion(input: NotionConnectionInput): Promise<void> {
    try {
      const result = await this.serialize(async () => {
        if (this.controller === null || !supportsNotionSetup(this.controller)) throw pluginError();
        return this.controller.connectNotion(input);
      });
      new Notice(notionConnectionNotice(result));
    } catch {
      new Notice("Grandbox Bridge: Notion connection unavailable.");
    }
  }

  private async configureCortex(input: CortexSetupInput): Promise<void> {
    try {
      const result = await this.serialize(async () => {
        if (this.controller === null || !supportsCortexSetup(this.controller)) throw pluginError();
        return this.controller.configureCortex(input);
      });
      new Notice(cortexSetupNotice(result));
    } catch {
      new Notice("Grandbox Bridge: Cortex setup unavailable.");
    }
  }

  private async syncCortex(): Promise<void> {
    try {
      const status = await this.readCortexStatus();
      if (status.error !== undefined) throw pluginError();
      if (status.configuration !== "ready") {
        new Notice("Grandbox Bridge: The Cortex is not configured.");
        return;
      }
    } catch {
      new Notice("Grandbox Bridge: Cortex status unavailable.");
      return;
    }
    await this.runWorkerAction((controller) => controller.syncNow(), true, cortexSyncNotice);
  }

  private async syncFromVaultEvent(): Promise<void> {
    await this.runWorkerAction((controller) => supportsEventSync(controller) ? controller.syncFromVaultEvent() : controller.syncNow(), false);
  }

  private async runWorkerAction(
    action: (controller: WorkerController) => Promise<BridgeRunSummary>,
    notify = true,
    successNotice: (summary: BridgeRunSummary) => string = actionNotice,
  ): Promise<void> {
    try {
      const summary = await this.serialize(async () => {
        if (this.controller === null) throw pluginError();
        return action(this.controller);
      });
      await this.writeStatusNote(summary);
      if (notify) new Notice(successNotice(summary));
    } catch {
      if (notify) new Notice("Grandbox Bridge: action unavailable.");
    }
  }

  private async installService(): Promise<void> {
    try {
      const result = await this.serialize(async () => {
        if (this.controller === null) throw pluginError();
        return this.controller.installService();
      });
      new Notice(result.enabled ? "Grandbox Bridge: background service enabled." : "Grandbox Bridge: service unavailable.");
    } catch {
      new Notice("Grandbox Bridge: service unavailable.");
    }
  }

  private async disableService(): Promise<void> {
    try {
      const result = await this.serialize(async () => {
        if (this.controller === null) throw pluginError();
        return this.controller.disableService();
      });
      new Notice(result.enabled ? "Grandbox Bridge: service unavailable." : "Grandbox Bridge: background service disabled.");
    } catch {
      new Notice("Grandbox Bridge: service unavailable.");
    }
  }

  private async showStatus(): Promise<void> {
    const status = await this.readStatus();
    if (status.configuration === "ready" && status.service === "enabled") {
      new Notice("Grandbox Bridge: ready; background service enabled.");
      return;
    }
    if (status.configuration === "ready" && status.service === "disabled") {
      new Notice("Grandbox Bridge: ready; background service disabled.");
      return;
    }
    new Notice("Grandbox Bridge: status unavailable.");
  }

  private async showCortexStatus(): Promise<void> {
    try {
      const result = await this.readCortexStatus();
      if (result.error !== undefined) {
        new Notice("Grandbox Bridge: Cortex status unavailable.");
        return;
      }
      new Notice(result.configuration === "ready"
        ? "Grandbox Bridge: The Cortex is ready."
        : "Grandbox Bridge: The Cortex is not configured.");
    } catch {
      new Notice("Grandbox Bridge: Cortex status unavailable.");
    }
  }

  private async readCortexStatus(): Promise<CortexSetupResult> {
    return this.serialize(async () => {
      if (this.controller === null || !supportsCortexSetup(this.controller)) throw pluginError();
      return this.controller.cortexStatus();
    });
  }

  private async readStatus(): Promise<BridgeStatus> {
    try {
      return await this.serialize(async () => {
        if (this.controller === null) throw pluginError();
        return this.controller.status();
      });
    } catch {
      return safeStatusFallback();
    }
  }

  private async changeActiveNote(optedIn: boolean): Promise<void> {
    try {
      const file = this.app.workspace.getActiveFile();
      if (!(file instanceof TFile) || !isManageableMarkdownPath(file.path)) throw pluginError();
      const bytes = await this.app.vault.read(file);
      const next = changeNoteOptIn({ path: file.path, bytes, optedIn });
      await this.app.vault.modify(file, next);
      new Notice(optedIn ? "Grandbox Bridge: note opted in." : "Grandbox Bridge: note opted out.");
    } catch {
      new Notice("Grandbox Bridge: note action unavailable.");
    }
  }

  private async writeStatusNote(summary: BridgeRunSummary): Promise<void> {
    const status = await this.readStatus();
    const existing = this.app.vault.getAbstractFileByPath(STATUS_NOTE_PATH);
    if (existing !== null && !(existing instanceof TFile)) throw pluginError();
    const bytes = existing === null ? null : await this.app.vault.read(existing);
    const next = updateStatusNote(bytes, { ...status, summary });
    if (existing === null) {
      await this.app.vault.create(STATUS_NOTE_PATH, next);
    } else {
      await this.app.vault.modify(existing, next);
    }
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.actionTail.then(action, action);
    this.actionTail = next.then(() => undefined, () => undefined);
    return next;
  }
}

export default GrandboxBridgePlugin;
