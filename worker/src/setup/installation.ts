import {
  parseBridgeConfig,
  type ParsedBridgeConfigV1,
  type ParsedBridgeStateV1,
} from "@grandbox-bridge/shared";
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

export interface CortexSetupInput {
  readonly installationId: string;
  readonly vaultRoot: string;
  readonly rootPageId: string;
}

export interface InstallationConfigStore {
  load(): Promise<Readonly<ParsedBridgeConfigV1> | null>;
  save(config: ParsedBridgeConfigV1): Promise<void>;
}

export interface InstallationStateStore {
  ensureInitial(installationId: string): Promise<void>;
  load?(): Promise<Readonly<ParsedBridgeStateV1>>;
}

export interface InstallationCredentialStore {
  get?(slot: "notion-token"): Promise<string | null>;
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

export interface CortexRootValidator {
  (input: Readonly<{
    token: string;
    rootPageId: string;
  }>): Promise<readonly string[]>;
}

export interface InstallationInitializerDependencies {
  readonly canonicalizeVault: (vaultRoot: string, installationId: string) => Promise<CanonicalVaultRoot>;
  readonly config: InstallationConfigStore;
  readonly state: InstallationStateStore;
  readonly credentials: InstallationCredentialStore;
  readonly provisionNotion: NotionWorkspaceProvisioner;
  readonly validateCortexRoot?: CortexRootValidator;
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

function reservedCortexPath(path: string): boolean {
  const key = path.normalize("NFC").toLocaleLowerCase("en-US");
  return key === "the cortex.md" || key === "the cortex" || key.startsWith("the cortex/");
}

function hasReservedLegacyPath(state: Readonly<ParsedBridgeStateV1>): boolean {
  return Object.values(state.pairs).some((pair) => reservedCortexPath(pair.localPath));
}

function hasLegacyRemoteOverlap(state: Readonly<ParsedBridgeStateV1>, pageIds: ReadonlySet<string>): boolean {
  return Object.values(state.pairs).some((pair) => pageIds.has(pair.notionPageId));
}

function validCortexPageIds(value: unknown, rootPageId: string): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 5_000 &&
    value.every(validUuid) &&
    new Set(value).size === value.length &&
    value.includes(rootPageId)
  );
}

function matchingCortexState(state: Readonly<ParsedBridgeStateV1>, rootPageId: string): boolean {
  const cortex = state.cortex ?? null;
  return cortex === null || (
    cortex.rootPageId === rootPageId &&
    cortex.rootFilePath === "The Cortex.md" &&
    cortex.rootDirectoryPath === "The Cortex"
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

  /** Reports only whether the reserved Cortex root is locally configured. */
  public async cortexStatus(input: InstallationStatusInput): Promise<InstallationSetupResult> {
    if (
      !validUuid(input.installationId) ||
      typeof input.vaultRoot !== "string" ||
      input.vaultRoot.length === 0 ||
      this.dependencies.state.load === undefined
    ) {
      throw setupError();
    }
    const root = await this.dependencies.canonicalizeVault(input.vaultRoot, input.installationId);
    const existing = await this.dependencies.config.load();
    if (existing === null) return Object.freeze({ configuration: "unconfigured" as const, created: false });
    if (!matchingExistingConfig(existing, input.installationId, root)) throw setupError();
    const state = await this.dependencies.state.load();
    if (state.installationId !== input.installationId || hasReservedLegacyPath(state)) throw setupError();
    const cortex = existing.cortex;
    if (cortex === null) return Object.freeze({ configuration: "unconfigured" as const, created: false });
    if (!matchingCortexState(state, cortex.rootPageId) || hasLegacyRemoteOverlap(state, new Set([cortex.rootPageId]))) {
      throw setupError();
    }
    return Object.freeze({ configuration: "ready" as const, created: false });
  }

  /**
   * Enables the fixed reserved Cortex namespace only after proving it cannot
   * overlap a legacy pair. The stored credential is used solely to validate
   * the supplied regular-page root; it is never persisted or returned.
   */
  public async configureCortex(input: CortexSetupInput): Promise<InstallationSetupResult> {
    if (
      !validUuid(input.installationId) ||
      typeof input.vaultRoot !== "string" ||
      input.vaultRoot.length === 0 ||
      !validUuid(input.rootPageId) ||
      this.dependencies.state.load === undefined ||
      this.dependencies.credentials.get === undefined ||
      this.dependencies.validateCortexRoot === undefined
    ) {
      throw setupError();
    }

    const root = await this.dependencies.canonicalizeVault(input.vaultRoot, input.installationId);
    const existing = await this.dependencies.config.load();
    if (existing === null) throw setupError();
    if (!matchingExistingConfig(existing, input.installationId, root)) throw setupError();
    const state = await this.dependencies.state.load();
    if (
      state.installationId !== input.installationId ||
      hasReservedLegacyPath(state) ||
      !matchingCortexState(state, input.rootPageId) ||
      (existing.cortex !== null && existing.cortex.rootPageId !== input.rootPageId)
    ) {
      throw setupError();
    }

    const token = await this.dependencies.credentials.get("notion-token");
    if (!validToken(token)) throw setupError();
    const pageIds = await this.dependencies.validateCortexRoot({ token, rootPageId: input.rootPageId });
    if (!validCortexPageIds(pageIds, input.rootPageId) || hasLegacyRemoteOverlap(state, new Set(pageIds))) {
      throw setupError();
    }

    if (existing.cortex !== null) return Object.freeze({ configuration: "ready" as const, created: false });
    const config = parseBridgeConfig({
      ...existing,
      schemaVersion: 2,
      cortex: {
        rootPageId: input.rootPageId,
        rootFilePath: "The Cortex.md",
        rootDirectoryPath: "The Cortex",
      },
    });
    await this.dependencies.config.save(config);
    return Object.freeze({ configuration: "ready" as const, created: true });
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
