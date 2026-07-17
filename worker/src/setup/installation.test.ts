import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "@grandbox-bridge/shared";
import { InstallationInitializer } from "./installation.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_PAGE_ID = "22222222-2222-4222-8222-222222222222";
const NOTION_TOKEN = "ntn_test_token_that_must_never_be_persisted";

describe("InstallationInitializer", () => {
  it("reports a matching local setup without consulting Notion, state, or Keychain", async () => {
    const calls: string[] = [];
    const existing = parseBridgeConfig({
      schemaVersion: 1,
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
      vaultFingerprint: "a".repeat(64),
      notion: {
        parentPageId: PARENT_PAGE_ID,
        dashboardPageId: PARENT_PAGE_ID,
        databaseId: "33333333-3333-4333-8333-333333333333",
        dataSourceId: "44444444-4444-4444-8444-444444444444",
      },
      relay: null,
      graph: null,
    });
    const initializer = new InstallationInitializer({
      canonicalizeVault: async () => {
        calls.push("vault");
        return {
          canonicalRealPath: "/synthetic/vault",
          filesystemDeviceId: "42",
          vaultFingerprint: "a".repeat(64),
        };
      },
      config: {
        load: async () => {
          calls.push("config-load");
          return existing;
        },
        save: async () => {
          calls.push("config-save");
        },
      },
      state: { ensureInitial: async () => { calls.push("state"); } },
      credentials: { set: async () => { calls.push("credential"); } },
      provisionNotion: async () => {
        calls.push("notion");
        throw new Error("must not provision while reading status");
      },
    });

    await expect(initializer.status({
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
    })).resolves.toEqual({ configuration: "ready", created: false });

    expect(calls).toEqual(["vault", "config-load"]);
  });

  it("leaves the remote workspace, config, state, and credential store untouched in preview", async () => {
    const calls: string[] = [];
    const initializer = new InstallationInitializer({
      canonicalizeVault: async () => {
        calls.push("vault");
        return {
          canonicalRealPath: "/synthetic/vault",
          filesystemDeviceId: "42",
          vaultFingerprint: "a".repeat(64),
        };
      },
      config: {
        load: async () => {
          calls.push("config-load");
          return null;
        },
        save: async () => {
          calls.push("config-save");
        },
      },
      state: {
        ensureInitial: async () => {
          calls.push("state");
        },
      },
      credentials: {
        set: async () => {
          calls.push("credential");
        },
      },
      provisionNotion: async () => {
        calls.push("notion");
        return {
          databaseId: "33333333-3333-4333-8333-333333333333",
          dataSourceId: "44444444-4444-4444-8444-444444444444",
        };
      },
    });

    await expect(initializer.initialize({
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
      parentPageId: PARENT_PAGE_ID,
      token: NOTION_TOKEN,
      mode: "preview",
    })).resolves.toEqual({ configuration: "unconfigured", created: false });

    expect(calls).toEqual(["vault", "config-load"]);
  });

  it("provisions one Notion data source and persists the token only in the credential store", async () => {
    const calls: string[] = [];
    let savedConfig: unknown = null;
    const savedCredentials: Array<{ slot: string; value: string }> = [];
    const initializer = new InstallationInitializer({
      canonicalizeVault: async () => {
        calls.push("vault");
        return {
          canonicalRealPath: "/synthetic/vault",
          filesystemDeviceId: "42",
          vaultFingerprint: "a".repeat(64),
        };
      },
      config: {
        load: async () => {
          calls.push("config-load");
          return null;
        },
        save: async (config) => {
          calls.push("config-save");
          savedConfig = config;
        },
      },
      state: {
        ensureInitial: async (installationId) => {
          calls.push(`state:${installationId}`);
        },
      },
      credentials: {
        set: async (slot, value) => {
          calls.push(`credential:${slot}`);
          savedCredentials.push({ slot, value });
        },
      },
      provisionNotion: async (input) => {
        calls.push(`notion:${input.parentPageId}`);
        expect(input).toEqual({
          token: NOTION_TOKEN,
          parentPageId: PARENT_PAGE_ID,
          installationId: INSTALLATION_ID,
        });
        return {
          databaseId: "33333333-3333-4333-8333-333333333333",
          dataSourceId: "44444444-4444-4444-8444-444444444444",
        };
      },
    });

    const result = await initializer.initialize({
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
      parentPageId: PARENT_PAGE_ID,
      token: NOTION_TOKEN,
      mode: "apply",
    });

    expect(result).toEqual({ configuration: "ready", created: true });
    expect(calls).toEqual([
      "vault",
      "config-load",
      `notion:${PARENT_PAGE_ID}`,
      "config-save",
      `state:${INSTALLATION_ID}`,
      "credential:notion-token",
    ]);
    expect(savedConfig).toMatchObject({
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
      vaultFingerprint: "a".repeat(64),
      notion: {
        parentPageId: PARENT_PAGE_ID,
        dashboardPageId: PARENT_PAGE_ID,
        databaseId: "33333333-3333-4333-8333-333333333333",
        dataSourceId: "44444444-4444-4444-8444-444444444444",
      },
      relay: null,
      graph: null,
    });
    expect(savedCredentials).toEqual([{ slot: "notion-token", value: NOTION_TOKEN }]);
    expect(JSON.stringify({ result, savedConfig })).not.toContain(NOTION_TOKEN);
  });

  it("restores a missing local credential from a matching setup without creating a second Notion database", async () => {
    const calls: string[] = [];
    const existing = parseBridgeConfig({
      schemaVersion: 1,
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
      vaultFingerprint: "a".repeat(64),
      notion: {
        parentPageId: PARENT_PAGE_ID,
        dashboardPageId: PARENT_PAGE_ID,
        databaseId: "33333333-3333-4333-8333-333333333333",
        dataSourceId: "44444444-4444-4444-8444-444444444444",
      },
      relay: null,
      graph: null,
    });
    const initializer = new InstallationInitializer({
      canonicalizeVault: async () => {
        calls.push("vault");
        return {
          canonicalRealPath: "/synthetic/vault",
          filesystemDeviceId: "42",
          vaultFingerprint: "a".repeat(64),
        };
      },
      config: {
        load: async () => {
          calls.push("config-load");
          return existing;
        },
        save: async () => {
          calls.push("config-save");
        },
      },
      state: {
        ensureInitial: async () => {
          calls.push("state");
        },
      },
      credentials: {
        set: async (slot, value) => {
          calls.push(`credential:${slot}:${value === NOTION_TOKEN ? "stored" : "wrong"}`);
        },
      },
      provisionNotion: async () => {
        calls.push("notion");
        throw new Error("must not provision twice");
      },
    });

    await expect(initializer.initialize({
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
      parentPageId: PARENT_PAGE_ID,
      token: NOTION_TOKEN,
      mode: "apply",
    })).resolves.toEqual({ configuration: "ready", created: false });

    expect(calls).toEqual(["vault", "config-load", "state", "credential:notion-token:stored"]);
  });
});
