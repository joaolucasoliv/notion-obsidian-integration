import type { SafeErrorCode } from "@grandbox-bridge/shared";
import { FetchNotionTransport, NotionTransportError, type NotionTransport } from "../notion/transport.js";
import type { NotionWorkspaceProvisioner } from "./installation.js";

const NOTION_VERSION = "2026-03-11";
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A bounded provisioning failure that is safe to pass to the local plugin UI. */
export class NotionSetupError extends Error {
  public constructor(public readonly code: SafeErrorCode) {
    super(`Notion setup ${code}`);
    this.name = "NotionSetupError";
  }
}

function setupError(code: SafeErrorCode = "internal-error"): NotionSetupError {
  return new NotionSetupError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8_192 && !/[\r\n\0]/u.test(value);
}

function headers(token: string, body = false): Readonly<Record<string, string>> {
  return Object.freeze({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Notion-Version": NOTION_VERSION,
    ...(body ? { "Content-Type": "application/json" } : {}),
  });
}

function managedProperties(): Record<string, unknown> {
  return {
    Name: { title: {} },
    "Bridge ID": { rich_text: {} },
    "Obsidian Path": { rich_text: {} },
    Tags: { multi_select: { options: [] } },
    "Sync Status": {
      select: {
        options: [
          { name: "Synced" },
          { name: "Conflict" },
          { name: "Detached" },
          { name: "Missing Local" },
          { name: "Missing Notion" },
          { name: "Error" },
        ],
      },
    },
    "Last Source": { select: { options: [{ name: "Obsidian" }, { name: "Notion" }] } },
    "Last Synced": { date: {} },
  };
}

function validResponse(response: Readonly<{ status: number }>): boolean {
  return Number.isInteger(response.status) && response.status >= 200 && response.status < 300;
}

function responseError(response: Readonly<{ status: number }>): NotionSetupError {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    return setupError("invalid-response");
  }
  if (response.status === 401) return setupError("authentication-failed");
  if (response.status === 403) return setupError("authorization-failed");
  if (response.status === 404) return setupError("not-found");
  if (response.status === 429) return setupError("rate-limited");
  if (response.status >= 500) return setupError("network-failed");
  return setupError("internal-error");
}

function requireSuccessfulResponse(response: Readonly<{ status: number }>): void {
  if (!validResponse(response)) throw responseError(response);
}

function parseUser(value: unknown): void {
  if (!isRecord(value) || value.object !== "user" || !validUuid(value.id)) throw setupError("invalid-response");
}

function parseParentPage(value: unknown, expectedId: string): void {
  if (!isRecord(value) || value.object !== "page" || value.id !== expectedId) throw setupError("invalid-response");
}

function parseCreatedDatabase(value: unknown): Readonly<{ databaseId: string; dataSourceId: string }> {
  if (!isRecord(value) || value.object !== "database" || !validUuid(value.id) || !Array.isArray(value.data_sources)) {
    throw setupError("invalid-response");
  }
  const matches = value.data_sources.filter((source): source is Record<string, unknown> => (
    isRecord(source) &&
    validUuid(source.id) &&
    (!Object.hasOwn(source, "object") || source.object === "data_source")
  ));
  if (matches.length !== 1) throw setupError("invalid-response");
  const source = matches[0];
  if (source === undefined || !validUuid(source.id)) throw setupError("invalid-response");
  return Object.freeze({ databaseId: value.id, dataSourceId: source.id });
}

/**
 * Creates the single managed Grandbox Notes data source under a page that the
 * user explicitly shared with their internal Notion connection.
 */
export function createNotionWorkspaceProvisioner(
  transport: NotionTransport = new FetchNotionTransport(),
): NotionWorkspaceProvisioner {
  return async (input) => {
    if (!validToken(input.token) || !validUuid(input.parentPageId) || !validUuid(input.installationId)) {
      throw setupError("invalid-config");
    }
    try {
      const user = await transport.request<unknown>({
        method: "GET",
        path: "/v1/users/me",
        headers: headers(input.token),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: RESPONSE_MAX_BYTES,
      });
      requireSuccessfulResponse(user);
      parseUser(user.data);

      const parent = await transport.request<unknown>({
        method: "GET",
        path: `/v1/pages/${input.parentPageId}`,
        headers: headers(input.token),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: RESPONSE_MAX_BYTES,
      });
      requireSuccessfulResponse(parent);
      parseParentPage(parent.data, input.parentPageId);

      const created = await transport.request<unknown>({
        method: "POST",
        path: "/v1/databases",
        headers: headers(input.token, true),
        body: {
          parent: { type: "page_id", page_id: input.parentPageId },
          title: [{ type: "text", text: { content: "Grandbox Notes" } }],
          is_inline: false,
          initial_data_source: { properties: managedProperties() },
        },
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: RESPONSE_MAX_BYTES,
      });
      requireSuccessfulResponse(created);
      return parseCreatedDatabase(created.data);
    } catch (caught) {
      if (caught instanceof NotionSetupError) throw caught;
      if (caught instanceof NotionTransportError) throw setupError(caught.code);
      throw setupError("internal-error");
    }
  };
}
