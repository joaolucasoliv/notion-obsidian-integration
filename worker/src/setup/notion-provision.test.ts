import { describe, expect, it } from "vitest";
import type { NotionTransport, NotionTransportResponse } from "../notion/transport.js";
import { createNotionWorkspaceProvisioner } from "./notion-provision.js";

const TOKEN = "ntn_fixture_token";
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_PAGE_ID = "22222222-2222-4222-8222-222222222222";
const DATABASE_ID = "33333333-3333-4333-8333-333333333333";
const DATA_SOURCE_ID = "44444444-4444-4444-8444-444444444444";

class RecordingTransport implements NotionTransport {
  public readonly requests: Parameters<NotionTransport["request"]>[0][] = [];

  public constructor(private readonly responses: NotionTransportResponse<unknown>[]) {}

  public async request<T>(input: Parameters<NotionTransport["request"]>[0]): Promise<NotionTransportResponse<T>> {
    this.requests.push(structuredClone(input));
    const response = this.responses.shift();
    if (response === undefined) throw new Error("unexpected request");
    return response as NotionTransportResponse<T>;
  }
}

function response(data: unknown, status = 200): NotionTransportResponse<unknown> {
  return { status, headers: {}, data };
}

describe("createNotionWorkspaceProvisioner", () => {
  it("verifies the connection and parent page before creating one managed data source", async () => {
    const transport = new RecordingTransport([
      response({ object: "user", id: "55555555-5555-4555-8555-555555555555", name: "Grandbox Bridge" }),
      response({ object: "page", id: PARENT_PAGE_ID }),
      response({
        object: "database",
        id: DATABASE_ID,
        data_sources: [{ object: "data_source", id: DATA_SOURCE_ID }],
      }),
    ]);
    const provision = createNotionWorkspaceProvisioner(transport);

    await expect(provision({ token: TOKEN, parentPageId: PARENT_PAGE_ID, installationId: INSTALLATION_ID })).resolves.toEqual({
      databaseId: DATABASE_ID,
      dataSourceId: DATA_SOURCE_ID,
    });

    expect(transport.requests).toEqual([
      {
        method: "GET",
        path: "/v1/users/me",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/json",
          "Notion-Version": "2026-03-11",
        },
        timeoutMs: 30_000,
        maxBytes: 2 * 1024 * 1024,
      },
      {
        method: "GET",
        path: `/v1/pages/${PARENT_PAGE_ID}`,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/json",
          "Notion-Version": "2026-03-11",
        },
        timeoutMs: 30_000,
        maxBytes: 2 * 1024 * 1024,
      },
      {
        method: "POST",
        path: "/v1/databases",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/json",
          "Notion-Version": "2026-03-11",
          "Content-Type": "application/json",
        },
        body: {
          parent: { type: "page_id", page_id: PARENT_PAGE_ID },
          title: [{ type: "text", text: { content: "Grandbox Notes" } }],
          is_inline: false,
          initial_data_source: {
            properties: {
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
            },
          },
        },
        timeoutMs: 30_000,
        maxBytes: 2 * 1024 * 1024,
      },
    ]);
  });

  it("accepts the current Notion database response where a data-source summary omits object", async () => {
    const transport = new RecordingTransport([
      response({ object: "user", id: "55555555-5555-4555-8555-555555555555", name: "Grandbox Bridge" }),
      response({ object: "page", id: PARENT_PAGE_ID }),
      response({
        object: "database",
        id: DATABASE_ID,
        data_sources: [{ id: DATA_SOURCE_ID, name: "Grandbox Notes" }],
      }),
    ]);
    const provision = createNotionWorkspaceProvisioner(transport);

    await expect(provision({ token: TOKEN, parentPageId: PARENT_PAGE_ID, installationId: INSTALLATION_ID })).resolves.toEqual({
      databaseId: DATABASE_ID,
      dataSourceId: DATA_SOURCE_ID,
    });
  });

  it("classifies an unavailable parent page without exposing the connection token", async () => {
    const transport = new RecordingTransport([
      response({ object: "user", id: "55555555-5555-4555-8555-555555555555", name: "Grandbox Bridge" }),
      response({ object: "error", message: TOKEN }, 404),
    ]);
    const provision = createNotionWorkspaceProvisioner(transport);

    const error = await provision({ token: TOKEN, parentPageId: PARENT_PAGE_ID, installationId: INSTALLATION_ID })
      .then(() => null, (caught: unknown) => caught);

    expect(error).toMatchObject({ code: "not-found" });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(TOKEN);
    expect(transport.requests.map((request) => request.path)).toEqual([
      "/v1/users/me",
      `/v1/pages/${PARENT_PAGE_ID}`,
    ]);
  });
});
