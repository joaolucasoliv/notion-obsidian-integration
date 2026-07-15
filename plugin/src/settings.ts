import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import type { BridgeStatus } from "./controller.js";

export interface SettingsActions {
  preview(): Promise<void>;
  syncNow(): Promise<void>;
  installService(): Promise<void>;
  disableService(): Promise<void>;
  status(): Promise<BridgeStatus>;
}

export function describeStatus(status: BridgeStatus): string {
  if (status.configuration === "unconfigured") return "Local worker is not configured.";
  if (status.configuration === "attention") return "Bridge needs attention before the next sync.";
  if (status.service === "enabled") return "Ready; the background service is enabled.";
  if (status.service === "disabled") return "Ready; the background service is disabled.";
  return "Ready; background service state is unavailable.";
}

/** Settings deliberately expose only local sync/service controls, never pairing or graph controls. */
export class GrandboxBridgeSettingTab extends PluginSettingTab {
  public constructor(
    app: App,
    plugin: Plugin,
    private readonly actions: SettingsActions,
  ) {
    super(app, plugin);
  }

  public override display(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    this.containerEl.empty();
    let status: BridgeStatus;
    try {
      status = await this.actions.status();
    } catch {
      status = { configuration: "attention", service: "unknown" };
    }
    new Setting(this.containerEl)
      .setName("Bridge status")
      .setDesc(describeStatus(status));
    new Setting(this.containerEl)
      .setName("Sync")
      .setDesc("Run a local preview or an explicit sync.")
      .addButton((button) => button.setButtonText("Preview").onClick(() => this.actions.preview()))
      .addButton((button) => button.setButtonText("Sync now").onClick(() => this.actions.syncNow()));
    new Setting(this.containerEl)
      .setName("Background service")
      .setDesc("Install or disable the local background service.")
      .addButton((button) => button.setButtonText("Install service").onClick(() => this.actions.installService()))
      .addButton((button) => button.setButtonText("Disable service").onClick(() => this.actions.disableService()));
  }
}
