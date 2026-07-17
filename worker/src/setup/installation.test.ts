import { describe, expect, it } from "vitest";
import { parseBridgeConfig, parseBridgeState } from "@grandbox-bridge/shared";
import { InstallationInitializer } from "./installation.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_PAGE_ID = "22222222-2222-4222-8222-222222222222";
const CORTEX_ROOT_PAGE_ID = "33333333-3333-4333-8333-333333333333";
const CORTEX_CHILD_PAGE_ID = "44444444-4444-4444-8444-444444444444";
const LEGACY_BRIDGE_ID = "55555555-5555-4555-8555-555555555555";
const NOTION_TOKEN = "ntn_test_token_that_must_never_be_persisted";

function configuredBridge(cortex: Readonly<{ rootPageId: string; rootFilePath: "The Cortex.md"; rootDirectoryPath: "The Cortex" }> | null = null) {
  return parseBridgeConfig({
    schemaVersion: 2,
    installationId: INSTALLATION_ID,
    vaultRoot: "/synthetic/vault",
    vaultFingerprint: "a".repeat(64),
    notion: {
      parentPageId: PARENT_PAGE_ID,
      dashboardPageId: PARENT_PAGE_ID,
      databaseId: "66666666-6666-4666-8666-666666666666",
      dataSourceId: "77777777-7777-4777-8777-777777777777",
    },
    relay: null,
    graph: null,
    cortex,
  });
}

function stateWithPairs(pairs: Record<string, unknown> = {}) {
  return parseBridgeState({
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    pairs,
    graph: null,
    lastFullReconciliationAt: null,
    lastRun: null,
  });
}

function legacyPair(input: Readonly<{ localPath: string; notionPageId: string }>) {
  return {
    bridgeId: LEGACY_BRIDGE_ID,
    localPath: input.localPath,
    notionPageId: input.notionPageId,
    status: "synced",
    lastLocalSemanticHash: "b".repeat(64),
    lastNotionSemanticHash: "b".repeat(64),
    lastCommonSemanticHash: "b".repeat(64),
    lastCommonLocalByteHash: "b".repeat(64),
    lastNotionEditedAt: "2026-07-17T12:00:00.000Z",
    lastSyncedAt: "2026-07-17T12:00:00.000Z",
  };
}

describe("InstallationInitializer", () => {
  it("persists one validated Cortex root with the fixed vault paths", async () => {
    const calls: string[] = [];
    let savedConfig: unknown = null;
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
          return configuredBridge();
        },
        save: async (config) => {
          calls.push("config-save");
          savedConfig = config;
        },
      },
      state: {
        ensureInitial: async () => { calls.push("state-initialize"); },
        load: async () => {
          calls.push("state-load");
          return stateWithPairs();
        },
      },
      credentials: {
        get: async (slot: string) => {
          calls.push(`credential:${slot}`);
          return NOTION_TOKEN;
        },
        set: async () => { calls.push("credential-set"); },
      },
      provisionNotion: async () => {
        calls.push("notion-provision");
        throw new Error("must not provision a Cortex root");
      },
      validateCortexRoot: async (input: { readonly token: string; readonly rootPageId: string }) => {
        calls.push(`notion-root:${input.rootPageId}`);
        expect(input.token).toBe(NOTION_TOKEN);
        return [CORTEX_ROOT_PAGE_ID, CORTEX_CHILD_PAGE_ID];
      },
    });
    const cortex = initializer as unknown as {
      configureCortex(input: Readonly<{ installationId: string; vaultRoot: string; rootPageId: string }>): Promise<unknown>;
    };

    await expect(cortex.configureCortex({
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
      rootPageId: CORTEX_ROOT_PAGE_ID,
    })).resolves.toEqual({ configuration: "ready", created: true });

    expect(calls).toEqual([
      "vault",
      "config-load",
      "state-load",
      "credential:notion-token",
      `notion-root:${CORTEX_ROOT_PAGE_ID}`,
      "config-save",
    ]);
    expect(savedConfig).toMatchObject({
      schemaVersion: 2,
      cortex: {
        rootPageId: CORTEX_ROOT_PAGE_ID,
        rootFilePath: "The Cortex.md",
        rootDirectoryPath: "The Cortex",
      },
    });
  });

  it.each(["The Cortex/Research.md", "the cortex/Research.md"])("rejects a legacy pair that occupies the reserved Cortex local namespace: %s", async (localPath) => {
    const calls: string[] = [];
    const initializer = new InstallationInitializer({
      canonicalizeVault: async () => ({
        canonicalRealPath: "/synthetic/vault",
        filesystemDeviceId: "42",
        vaultFingerprint: "a".repeat(64),
      }),
      config: {
        load: async () => configuredBridge(),
        save: async () => { calls.push("config-save"); },
      },
      state: {
        ensureInitial: async () => undefined,
        load: async () => stateWithPairs({
          [LEGACY_BRIDGE_ID]: legacyPair({ localPath, notionPageId: "88888888-8888-4888-8888-888888888888" }),
        }),
      },
      credentials: {
        get: async () => {
          calls.push("credential");
          return NOTION_TOKEN;
        },
        set: async () => undefined,
      },
      provisionNotion: async () => { throw new Error("must not provision"); },
      validateCortexRoot: async () => {
        calls.push("notion-root");
        return [CORTEX_ROOT_PAGE_ID];
      },
    });
    const cortex = initializer as unknown as {
      configureCortex(input: Readonly<{ installationId: string; vaultRoot: string; rootPageId: string }>): Promise<unknown>;
    };

    await expect(cortex.configureCortex({
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
      rootPageId: CORTEX_ROOT_PAGE_ID,
    })).rejects.toThrow("Installation setup failed");

    expect(calls).toEqual([]);
  });

  it("rejects a legacy pair that claims the fixed Cortex directory name", async () => {
    const calls: string[] = [];
    const initializer = new InstallationInitializer({
      canonicalizeVault: async () => ({
        canonicalRealPath: "/synthetic/vault",
        filesystemDeviceId: "42",
        vaultFingerprint: "a".repeat(64),
      }),
      config: {
        load: async () => configuredBridge(),
        save: async () => { calls.push("config-save"); },
      },
      state: {
        ensureInitial: async () => undefined,
        load: async () => stateWithPairs({
          [LEGACY_BRIDGE_ID]: legacyPair({ localPath: "The Cortex", notionPageId: "88888888-8888-4888-8888-888888888888" }),
        }),
      },
      credentials: {
        get: async () => {
          calls.push("credential");
          return NOTION_TOKEN;
        },
        set: async () => undefined,
      },
      provisionNotion: async () => { throw new Error("must not provision"); },
      validateCortexRoot: async () => {
        calls.push("notion-root");
        return [CORTEX_ROOT_PAGE_ID];
      },
    });
    const cortex = initializer as unknown as {
      configureCortex(input: Readonly<{ installationId: string; vaultRoot: string; rootPageId: string }>): Promise<unknown>;
    };

    await expect(cortex.configureCortex({
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
      rootPageId: CORTEX_ROOT_PAGE_ID,
    })).rejects.toThrow("Installation setup failed");

    expect(calls).toEqual([]);
  });

  it("rejects a legacy pair that targets a page in the validated Cortex tree", async () => {
    const calls: string[] = [];
    const initializer = new InstallationInitializer({
      canonicalizeVault: async () => ({
        canonicalRealPath: "/synthetic/vault",
        filesystemDeviceId: "42",
        vaultFingerprint: "a".repeat(64),
      }),
      config: {
        load: async () => configuredBridge(),
        save: async () => { calls.push("config-save"); },
      },
      state: {
        ensureInitial: async () => undefined,
        load: async () => stateWithPairs({
          [LEGACY_BRIDGE_ID]: legacyPair({ localPath: "Research.md", notionPageId: CORTEX_CHILD_PAGE_ID }),
        }),
      },
      credentials: {
        get: async () => {
          calls.push("credential");
          return NOTION_TOKEN;
        },
        set: async () => undefined,
      },
      provisionNotion: async () => { throw new Error("must not provision"); },
      validateCortexRoot: async () => {
        calls.push("notion-root");
        return [CORTEX_ROOT_PAGE_ID, CORTEX_CHILD_PAGE_ID];
      },
    });
    const cortex = initializer as unknown as {
      configureCortex(input: Readonly<{ installationId: string; vaultRoot: string; rootPageId: string }>): Promise<unknown>;
    };

    await expect(cortex.configureCortex({
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
      rootPageId: CORTEX_ROOT_PAGE_ID,
    })).rejects.toThrow("Installation setup failed");

    expect(calls).toEqual(["credential", "notion-root"]);
  });

  it("reports Cortex configuration status without reading a credential or remote content", async () => {
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
          return configuredBridge({
            rootPageId: CORTEX_ROOT_PAGE_ID,
            rootFilePath: "The Cortex.md",
            rootDirectoryPath: "The Cortex",
          });
        },
        save: async () => { calls.push("config-save"); },
      },
      state: {
        ensureInitial: async () => undefined,
        load: async () => {
          calls.push("state-load");
          return stateWithPairs();
        },
      },
      credentials: {
        get: async () => {
          calls.push("credential");
          return NOTION_TOKEN;
        },
        set: async () => undefined,
      },
      provisionNotion: async () => { throw new Error("must not provision"); },
      validateCortexRoot: async () => {
        calls.push("notion-root");
        return [CORTEX_ROOT_PAGE_ID];
      },
    });
    const cortex = initializer as unknown as {
      cortexStatus(input: Readonly<{ installationId: string; vaultRoot: string }>): Promise<unknown>;
    };

    await expect(cortex.cortexStatus({
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
    })).resolves.toEqual({ configuration: "ready", created: false });

    expect(calls).toEqual(["vault", "config-load", "state-load"]);
  });

  it("reports Cortex as unconfigured when the regular bridge has not been initialized", async () => {
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
        save: async () => { calls.push("config-save"); },
      },
      state: {
        ensureInitial: async () => undefined,
        load: async () => {
          calls.push("state-load");
          return stateWithPairs();
        },
      },
      credentials: {
        get: async () => {
          calls.push("credential");
          return NOTION_TOKEN;
        },
        set: async () => undefined,
      },
      provisionNotion: async () => { throw new Error("must not provision"); },
      validateCortexRoot: async () => {
        calls.push("notion-root");
        return [CORTEX_ROOT_PAGE_ID];
      },
    });
    const cortex = initializer as unknown as {
      cortexStatus(input: Readonly<{ installationId: string; vaultRoot: string }>): Promise<unknown>;
    };

    await expect(cortex.cortexStatus({
      installationId: INSTALLATION_ID,
      vaultRoot: "/synthetic/vault",
    })).resolves.toEqual({ configuration: "unconfigured", created: false });

    expect(calls).toEqual(["vault", "config-load"]);
  });

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
