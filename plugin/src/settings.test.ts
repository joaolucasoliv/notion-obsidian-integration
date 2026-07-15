import { describe, expect, it } from "vitest";
import { App, Plugin } from "../../tests/fakes/obsidian.js";
import { describeStatus, GrandboxBridgeSettingTab } from "./settings.js";

describe("Grandbox Bridge settings", () => {
  it("distinguishes read-only status without exposing runtime details", () => {
    expect(describeStatus({ configuration: "unconfigured", service: "unknown" })).toBe("Local worker is not configured.");
    expect(describeStatus({ configuration: "ready", service: "enabled" })).toBe("Ready; the background service is enabled.");
    expect(describeStatus({ configuration: "ready", service: "disabled" })).toBe("Ready; the background service is disabled.");
    expect(describeStatus({ configuration: "attention", service: "unknown" })).toBe("Bridge needs attention before the next sync.");
  });

  it("exposes bounded local service buttons", async () => {
    const calls: string[] = [];
    const app = new App();
    const tab = new GrandboxBridgeSettingTab(app, new Plugin(app, { id: "grandbox-bridge" }), {
      preview: async () => { calls.push("preview"); },
      syncNow: async () => { calls.push("sync"); },
      installService: async () => { calls.push("install"); },
      disableService: async () => { calls.push("disable"); },
      status: async () => ({ configuration: "ready", service: "disabled" }),
    });

    tab.display();
    await Promise.resolve();
    const buttons = tab.containerEl.settings.flatMap((setting) => setting.buttons);
    await buttons.find((button) => button.label === "Install service")?.click();
    await buttons.find((button) => button.label === "Disable service")?.click();

    expect(calls).toEqual(["install", "disable"]);
    expect(buttons.map((button) => button.label)).not.toContain("Graph");
    expect(buttons.map((button) => button.label)).not.toContain("Pair");
  });
});
