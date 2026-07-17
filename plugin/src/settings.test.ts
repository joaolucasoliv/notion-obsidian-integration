import { describe, expect, it } from "vitest";
import { App, Notice, Plugin } from "../../tests/fakes/obsidian.js";
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
      connectNotion: async () => { calls.push("connect"); },
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

  it("passes a transient Notion page reference and token to the local connect action, then clears both fields", async () => {
    const received: unknown[] = [];
    const app = new App();
    const tab = new GrandboxBridgeSettingTab(app, new Plugin(app, { id: "grandbox-bridge" }), {
      preview: async () => undefined,
      syncNow: async () => undefined,
      installService: async () => undefined,
      disableService: async () => undefined,
      connectNotion: async (input) => { received.push(input); },
      status: async () => ({ configuration: "unconfigured", service: "unknown" }),
    });

    tab.display();
    await Promise.resolve();
    const texts = tab.containerEl.settings.flatMap((setting) => setting.texts);
    const page = texts.find((text) => text.placeholder === "Notion parent page URL (not workspace ID)");
    const token = texts.find((text) => text.placeholder === "Notion integration token");
    page?.setValue("https://www.notion.so/Grandbox-22222222222242228222222222222222");
    token?.setValue("ntn_transient_token");
    const button = tab.containerEl.settings.flatMap((setting) => setting.buttons).find((candidate) => candidate.label === "Connect Notion");

    await button?.click();

    expect(received).toEqual([{
      parentPageId: "22222222-2222-4222-8222-222222222222",
      token: "ntn_transient_token",
    }]);
    expect(page?.getValue()).toBe("");
    expect(token?.getValue()).toBe("");
    expect(tab.containerEl.settings.find((setting) => setting.name === "Connect Notion")?.description).toContain("not workspace ID");
  });

  it("explains missing Notion setup fields instead of failing silently", async () => {
    const received: unknown[] = [];
    Notice.clear();
    const app = new App();
    const tab = new GrandboxBridgeSettingTab(app, new Plugin(app, { id: "grandbox-bridge" }), {
      preview: async () => undefined,
      syncNow: async () => undefined,
      installService: async () => undefined,
      disableService: async () => undefined,
      connectNotion: async (input) => { received.push(input); },
      status: async () => ({ configuration: "unconfigured", service: "unknown" }),
    });

    tab.display();
    await Promise.resolve();
    const button = tab.containerEl.settings.flatMap((setting) => setting.buttons).find((candidate) => candidate.label === "Connect Notion");
    if (button === undefined) throw new Error("connect button missing");

    await expect(button.click()).resolves.toBeUndefined();

    expect(received).toEqual([]);
    expect(Notice.messages).toEqual([
      "Grandbox Bridge: enter a Notion parent-page URL (not a workspace ID) and integration token.",
    ]);
  });

  it("configures The Cortex from a root page reference without rendering a token field", async () => {
    const calls: string[] = [];
    const roots: string[] = [];
    const app = new App();
    const actions = {
      preview: async () => undefined,
      syncNow: async () => { calls.push("sync-notes"); },
      installService: async () => undefined,
      disableService: async () => undefined,
      connectNotion: async () => undefined,
      status: async () => ({ configuration: "ready" as const, service: "disabled" as const }),
      configureCortex: async (input: { readonly rootPageId: string }) => {
        roots.push(input.rootPageId);
        calls.push("configure-cortex");
      },
      syncCortex: async () => { calls.push("sync-cortex"); },
      cortexStatus: async () => { calls.push("cortex-status"); },
    };
    const tab = new GrandboxBridgeSettingTab(app, new Plugin(app, { id: "grandbox-bridge" }), actions);

    tab.display();
    await Promise.resolve();
    const cortex = tab.containerEl.settings.find((setting) => setting.name === "The Cortex");
    const root = cortex?.texts.find((text) => text.placeholder === "The Cortex root page URL or ID");
    const cortexButtons = tab.containerEl.settings.flatMap((setting) => setting.buttons);

    root?.setValue("https://app.notion.com/p/The-Cortex-22222222222242228222222222222222?source=copy_link");
    await cortexButtons.find((button) => button.label === "Connect The Cortex")?.click();
    await cortexButtons.find((button) => button.label === "Sync The Cortex")?.click();
    await cortexButtons.find((button) => button.label === "Cortex status")?.click();

    expect(roots).toEqual(["22222222-2222-4222-8222-222222222222"]);
    expect(calls).toEqual(["configure-cortex", "sync-cortex", "cortex-status"]);
    expect(cortex?.texts.map((text) => text.placeholder)).toEqual(["The Cortex root page URL or ID"]);
    expect(cortex?.texts.some((text) => /token/i.test(text.placeholder))).toBe(false);
    expect(root?.getValue()).toBe("");
  });
});
