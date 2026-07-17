import { Notice, PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import type { BridgeStatus, CortexSetupInput, NotionConnectionInput } from "./controller.js";
import { parseNotionParentPageId } from "./onboarding.js";

export interface SettingsActions {
  preview(): Promise<void>;
  syncNow(): Promise<void>;
  installService(): Promise<void>;
  disableService(): Promise<void>;
  connectNotion(input: NotionConnectionInput): Promise<void>;
  configureCortex(input: CortexSetupInput): Promise<void>;
  syncCortex(): Promise<void>;
  cortexStatus(): Promise<void>;
  status(): Promise<BridgeStatus>;
}

export function describeStatus(status: BridgeStatus): string {
  if (status.configuration === "unconfigured") return "Local worker is not configured.";
  if (status.configuration === "attention") return "Bridge needs attention before the next sync.";
  if (status.service === "enabled") return "Ready; the background service is enabled.";
  if (status.service === "disabled") return "Ready; the background service is disabled.";
  return "Ready; background service state is unavailable.";
}

/** Settings expose local bridge controls and the bounded The Cortex tree workflow. */
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
    let parentReference: { getValue(): string; setValue(value: string): unknown } | null = null;
    let token: { getValue(): string; setValue(value: string): unknown; inputEl: { type: string } } | null = null;
    new Setting(this.containerEl)
      .setName("Connect Notion")
      .setDesc("Create or choose a Notion parent page, share it with The Grandbox Connection via ••• → Connections, then paste that page URL here — not workspace ID. The token is sent to the macOS Keychain only.")
      .addText((text) => {
        parentReference = text;
        text.setPlaceholder("Notion parent page URL (not workspace ID)");
      })
      .addText((text) => {
        token = text;
        text.setPlaceholder("Notion integration token");
        text.inputEl.type = "password";
      })
      .addButton((button) => button.setButtonText("Connect Notion").onClick(async () => {
        try {
          const tokenValue = token?.getValue() ?? "";
          if (tokenValue.length === 0) throw new Error("Notion token unavailable");
          await this.actions.connectNotion({
            parentPageId: parseNotionParentPageId(parentReference?.getValue() ?? ""),
            token: tokenValue,
          });
        } catch {
          new Notice("Grandbox Bridge: enter a Notion parent-page URL (not a workspace ID) and integration token.");
        } finally {
          parentReference?.setValue("");
          token?.setValue("");
        }
      }));
    let cortexRoot: { getValue(): string; setValue(value: string): unknown } | null = null;
    new Setting(this.containerEl)
      .setName("The Cortex")
      .setDesc("Connect the Notion root page for The Cortex. It uses the existing local Notion connection and never asks for a token.")
      .addText((text) => {
        cortexRoot = text;
        text.setPlaceholder("The Cortex root page URL or ID");
      })
      .addButton((button) => button.setButtonText("Connect The Cortex").onClick(async () => {
        try {
          await this.actions.configureCortex({
            rootPageId: parseNotionParentPageId(cortexRoot?.getValue() ?? ""),
          });
        } catch {
          new Notice("Grandbox Bridge: enter a valid The Cortex root page URL or ID.");
        } finally {
          cortexRoot?.setValue("");
        }
      }));
    new Setting(this.containerEl)
      .setName("Cortex sync")
      .setDesc("Sync The Cortex tree or check its local setup status.")
      .addButton((button) => button.setButtonText("Sync The Cortex").onClick(() => this.actions.syncCortex()))
      .addButton((button) => button.setButtonText("Cortex status").onClick(() => this.actions.cortexStatus()));
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
