import { parseBridgeConfig, type ParsedBridgeConfigV1 } from "@grandbox-bridge/shared";
import type { CanonicalVaultRoot } from "../vault/safety.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface InstallationSetupInput {
  readonly installationId: string;
  readonly vaultRoot: string;
  readonly parentPageId: string;
  readonly token: string | null;
  readonly mode: "preview" | "apply";
}

export interface InstallationSetupResult {
  readonly configuration: "unconfigured" | "ready";
  readonly created: boolean;
}

export interface InstallationStatusInput {
  readonly installationId: string;
  readonly vaultRoot: string;
}

export interface InstallationConfigStore {
  load(): Promise<Readonly<ParsedBridgeConfigV1> | null>;
  save(config: ParsedBridgeConfigV1): Promise<void>;
}

export interface InstallationStateStore {
  ensureInitial(installationId: string): Promise<void>;
}

export interface InstallationCredentialStore {
  set(slot: "notion-token", value: string): Promise<void>;
}

export interface NotionWorkspaceProvisioner {
  (input: Readonly<{
    token: string;
    parentPageId: string;
    installationId: string;
  }>): Promise<Readonly<{
    databaseId: string;
    dataSourceId: string;
  }>>;
}

export interface InstallationInitializerDependencies {
  readonly canonicalizeVault: (vaultRoot: string, installationId: string) => Promise<CanonicalVaultRoot>;
  readonly config: InstallationConfigStore;
  readonly state: InstallationStateStore;
  readonly credentials: InstallationCredentialStore;
  readonly provisionNotion: NotionWorkspaceProvisioner;
}

function setupError(): Error {
  return new Error("Installation setup failed");
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8_192 && !/[\r\n\0]/u.test(value);
}

function validProvisionedWorkspace(value: unknown): value is { readonly databaseId: string; readonly dataSourceId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    validUuid((value as { readonly databaseId?: unknown }).databaseId) &&
    validUuid((value as { readonly dataSourceId?: unknown }).dataSourceId)
  );
}

function matchingExistingConfig(
  config: Readonly<ParsedBridgeConfigV1>,
  installationId: string,
  root: CanonicalVaultRoot,
): boolean {
  return (
    config.installationId === installationId &&
    config.vaultRoot === root.canonicalRealPath &&
    config.vaultFingerprint === root.vaultFingerprint &&
    config.notion !== null
  );
}

/**
 * Owns the safe local boundary for first-time Notion setup.  It is deliberately
 * unaware of UI details and returns only status, never page IDs or credentials.
 */
export class InstallationInitializer {
  public constructor(private readonly dependencies: InstallationInitializerDependencies) {}

  /** Reads only the local configuration associated with this canonical vault. */
  public async status(input: InstallationStatusInput): Promise<InstallationSetupResult> {
    if (
      !validUuid(input.installationId) ||
      typeof input.vaultRoot !== "string" ||
      input.vaultRoot.length === 0
    ) {
      throw setupError();
    }
    const root = await this.dependencies.canonicalizeVault(input.vaultRoot, input.installationId);
    const existing = await this.dependencies.config.load();
    if (existing === null) return Object.freeze({ configuration: "unconfigured" as const, created: false });
    if (!matchingExistingConfig(existing, input.installationId, root)) throw setupError();
    return Object.freeze({ configuration: "ready" as const, created: false });
  }

  public async initialize(input: InstallationSetupInput): Promise<InstallationSetupResult> {
    if (
      !validUuid(input.installationId) ||
      typeof input.vaultRoot !== "string" ||
      input.vaultRoot.length === 0 ||
      !validUuid(input.parentPageId) ||
      (input.mode !== "preview" && input.mode !== "apply")
    ) {
      throw setupError();
    }

    const root = await this.dependencies.canonicalizeVault(input.vaultRoot, input.installationId);
    const existing = await this.dependencies.config.load();
    if (existing !== null) {
      if (!matchingExistingConfig(existing, input.installationId, root)) throw setupError();
      if (input.mode === "preview") return Object.freeze({ configuration: "ready" as const, created: false });
      if (!validToken(input.token)) throw setupError();
      await this.dependencies.state.ensureInitial(input.installationId);
      await this.dependencies.credentials.set("notion-token", input.token);
      return Object.freeze({ configuration: "ready" as const, created: false });
    }

    if (input.mode === "preview") return Object.freeze({ configuration: "unconfigured" as const, created: false });
    if (!validToken(input.token)) throw setupError();

    const workspace = await this.dependencies.provisionNotion({
      token: input.token,
      parentPageId: input.parentPageId,
      installationId: input.installationId,
    });
    if (!validProvisionedWorkspace(workspace)) throw setupError();
    const config = parseBridgeConfig({
      schemaVersion: 1,
      installationId: input.installationId,
      vaultRoot: root.canonicalRealPath,
      vaultFingerprint: root.vaultFingerprint,
      notion: {
        parentPageId: input.parentPageId,
        dashboardPageId: input.parentPageId,
        databaseId: workspace.databaseId,
        dataSourceId: workspace.dataSourceId,
      },
      relay: null,
      graph: null,
    });
    await this.dependencies.config.save(config);
    await this.dependencies.state.ensureInitial(input.installationId);
    await this.dependencies.credentials.set("notion-token", input.token);
    return Object.freeze({ configuration: "ready" as const, created: true });
  }
}
