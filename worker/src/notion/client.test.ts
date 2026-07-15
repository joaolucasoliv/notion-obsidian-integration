import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Clock, NotionObservation, PairStatus } from "@grandbox-bridge/shared";
import {
  NotionClient,
  NotionClientError,
  type NotionClientOptions,
  type NotionObservationDecoder,
  type RawNotionPageRecord,
} from "./client.js";
import {
  NotionTransportError,
  type NotionTransport,
  type NotionTransportResponse,
} from "./transport.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BRIDGE_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PAGE_ID = "44444444-4444-4444-8444-444444444444";
const EDITED_AT = "2026-07-14T12:00:00.000Z";
const TEST_CREDENTIALS = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/safe/notion-credentials.json", import.meta.url), "utf8"),
) as Readonly<{
  token: string;
  authorization: string;
  networkError: string;
  bodyMessage: string;
  providerException: string;
}>;
const TOKEN = TEST_CREDENTIALS.token;
const SEMANTIC_HASH = "a".repeat(64);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../../tests/fixtures/notion/${name}`, import.meta.url), "utf8")) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function response<T>(data: T, status = 200, headers: Record<string, string> = {}): NotionTransportResponse<T> {
  return { status, headers, data };
}

class RecordingTransport implements NotionTransport {
  public readonly requests: Parameters<NotionTransport["request"]>[0][] = [];

  public constructor(private readonly results: Array<NotionTransportResponse<unknown> | Error>) {}

  public async request<T>(input: Parameters<NotionTransport["request"]>[0]): Promise<NotionTransportResponse<T>> {
    this.requests.push(clone(input));
    const result = this.results.shift();
    if (result === undefined) throw new Error("unexpected synthetic request");
    if (result instanceof Error) throw result;
    return result as NotionTransportResponse<T>;
  }
}

function observationFromDecoder(record: Readonly<RawNotionPageRecord>, overrides: Partial<NotionObservation> = {}): NotionObservation {
  return {
    kind: "present",
    pageId: record.pageId,
    pageUrl: record.pageUrl,
    editedAt: record.editedAt,
    sourceMarkdown: record.sourceMarkdown,
    complete: !record.truncated && record.unknownBlockIds.length === 0,
    unsupportedKinds: [...record.unknownBlockIds],
    bridgeId: record.bridgeId,
    managed: {
      title: record.managed.title,
      obsidianPath: record.managed.obsidianPath,
      status: record.managed.status,
    },
    semantic: {
      bodyMarkdown: "semantic payload owned by the injected decoder",
      tags: [...record.managed.tags],
    },
    semanticHash: SEMANTIC_HASH,
    ...overrides,
  } as NotionObservation;
}

function decoder(
  transform: (record: Readonly<RawNotionPageRecord>) => NotionObservation | Promise<NotionObservation> = observationFromDecoder,
): NotionObservationDecoder {
  return { decode: async (record) => transform(record) };
}

function recordingClock(): Clock & { readonly delays: number[] } {
  const delays: number[] = [];
  return {
    now: () => new Date(EDITED_AT),
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    delays,
  };
}

function client(
  transport: NotionTransport,
  decode: NotionObservationDecoder = decoder(),
  options: Partial<NotionClientOptions> = {},
): { readonly value: NotionClient; readonly clock: ReturnType<typeof recordingClock> } {
  const clock = (options.clock as ReturnType<typeof recordingClock> | undefined) ?? recordingClock();
  return {
    value: new NotionClient(TOKEN, transport, decode, {
      clock,
      jitter: { delayMs: (attempt) => 100 * 2 ** (attempt - 1) },
      ...options,
    }),
    clock,
  };
}

function page(): Record<string, unknown> {
  return fixture<Record<string, unknown>>("page.json");
}

function markdown(): Record<string, unknown> {
  return fixture<Record<string, unknown>>("page-markdown.json");
}

function updatedMarkdown(): Record<string, unknown> {
  return fixture<Record<string, unknown>>("page-markdown-updated.json");
}

function emptyMarkdown(): Record<string, unknown> {
  return fixture<Record<string, unknown>>("page-markdown-empty.json");
}

function commonHeaders(hasBody = false): Record<string, string> {
  return {
    Authorization: TEST_CREDENTIALS.authorization,
    Accept: "application/json",
    "Notion-Version": "2026-03-11",
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  };
}

function expectSafeClientError(error: unknown, code: string, retryable: boolean): void {
  expect(error).toBeInstanceOf(NotionClientError);
  expect((error as NotionClientError).code).toBe(code);
  expect((error as NotionClientError).retryable).toBe(retryable);
  const rendered = `${String(error)} ${JSON.stringify(error)} ${Object.values(error as object).join(" ")}`;
  expect(rendered).not.toContain(TOKEN);
  expect(rendered).not.toContain("Bearer");
}

describe("NotionClient request contract", () => {
  it("sends exact-body compare-and-update with the required API version", async () => {
    const transport = new RecordingTransport([
      response(page()),
      response(markdown()),
      response(updatedMarkdown()),
      response(page()),
      response(updatedMarkdown()),
    ]);
    const { value } = client(transport);

    await value.updateBodyExact({
      pageId: PAGE_ID,
      oldMarkdown: "old body",
      newMarkdown: "new body",
      observedEditedAt: EDITED_AT,
    });

    expect(transport.requests).toEqual([
      { method: "GET", path: `/v1/pages/${PAGE_ID}`, headers: commonHeaders(), timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
      { method: "GET", path: `/v1/pages/${PAGE_ID}/markdown`, headers: commonHeaders(), timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
      {
        method: "PATCH",
        path: `/v1/pages/${PAGE_ID}/markdown`,
        headers: commonHeaders(true),
        body: {
          type: "update_content",
          update_content: { content_updates: [{ old_str: "old body", new_str: "new body" }] },
        },
        timeoutMs: 15_000,
        maxBytes: 2 * 1024 * 1024,
      },
      { method: "GET", path: `/v1/pages/${PAGE_ID}`, headers: commonHeaders(), timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
      { method: "GET", path: `/v1/pages/${PAGE_ID}/markdown`, headers: commonHeaders(), timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
    ]);
  });

  it("uses the exact connection, retrieve, create, and managed-property endpoint requests", async () => {
    const verifyTransport = new RecordingTransport([response(fixture("user-me.json"))]);
    await client(verifyTransport).value.verifyConnection();
    expect(verifyTransport.requests).toEqual([
      { method: "GET", path: "/v1/users/me", headers: commonHeaders(), timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
    ]);

    const retrieveTransport = new RecordingTransport([response(page()), response(markdown())]);
    await client(retrieveTransport).value.retrievePage(PAGE_ID);
    expect(retrieveTransport.requests.map(({ path, method, headers }) => ({ path, method, headers }))).toEqual([
      { method: "GET", path: `/v1/pages/${PAGE_ID}`, headers: commonHeaders() },
      { method: "GET", path: `/v1/pages/${PAGE_ID}/markdown`, headers: commonHeaders() },
    ]);

    const createTransport = new RecordingTransport([response(page()), response(page()), response(markdown())]);
    await client(createTransport).value.createNotePage({
      parentPageId: USER_ID,
      dataSourceId: OTHER_PAGE_ID,
      bridgeId: BRIDGE_ID,
      title: "Alpha",
      obsidianPath: "Notes/Alpha.md",
      tags: ["alpha", "zeta"],
      markdown: "# Alpha\n",
    });
    expect(createTransport.requests[0]).toEqual({
      method: "POST",
      path: "/v1/pages",
      headers: commonHeaders(true),
      body: {
        parent: { type: "data_source_id", data_source_id: OTHER_PAGE_ID },
        properties: {
          Name: { title: [{ type: "text", text: { content: "Alpha" } }] },
          "Bridge ID": { rich_text: [{ type: "text", text: { content: BRIDGE_ID } }] },
          "Obsidian Path": { rich_text: [{ type: "text", text: { content: "Notes/Alpha.md" } }] },
          Tags: { multi_select: [{ name: "alpha" }, { name: "zeta" }] },
          "Sync Status": { select: { name: "Synced" } },
        },
        markdown: "# Alpha\n",
      },
      timeoutMs: 15_000,
      maxBytes: 2 * 1024 * 1024,
    });
    expect(JSON.stringify(createTransport.requests[0]?.body)).not.toContain("parentPageId");

    const propertiesTransport = new RecordingTransport([response(page()), response(page()), response(page()), response(markdown())]);
    await client(propertiesTransport).value.updateManagedProperties({
      pageId: PAGE_ID,
      title: "Beta",
      obsidianPath: "Notes/Beta.md",
      tags: ["beta"],
      status: "conflict",
      observedEditedAt: EDITED_AT,
    });
    expect(propertiesTransport.requests[1]).toEqual({
      method: "PATCH",
      path: `/v1/pages/${PAGE_ID}`,
      headers: commonHeaders(true),
      body: {
        properties: {
          Name: { title: [{ type: "text", text: { content: "Beta" } }] },
          "Obsidian Path": { rich_text: [{ type: "text", text: { content: "Notes/Beta.md" } }] },
          Tags: { multi_select: [{ name: "beta" }] },
          "Sync Status": { select: { name: "Conflict" } },
        },
      },
      timeoutMs: 15_000,
      maxBytes: 2 * 1024 * 1024,
    });
  });
});

describe("NotionClient retries and fixed errors", () => {
  it("honors a case-insensitive Retry-After header and caps retries after the initial attempt", async () => {
    const transport = new RecordingTransport([
      response({ provider_message: TOKEN }, 429, { "rEtRy-AfTeR": "2" }),
      response(fixture("user-me.json")),
    ]);
    const { value, clock } = client(transport);

    await expect(value.verifyConnection()).resolves.toEqual({ userId: USER_ID, name: "Grandbox Bridge" });
    expect(clock.delays).toEqual([2_000]);
    expect(transport.requests).toHaveLength(2);
  });

  it.each([502, 503, 504, 529])("retries HTTP %s exactly three times with bounded injected delays", async (status) => {
    const transport = new RecordingTransport([
      response({ provider_message: TOKEN }, status),
      response({ provider_message: TOKEN }, status),
      response({ provider_message: TOKEN }, status),
      response({ provider_message: TOKEN }, status),
    ]);
    const { value, clock } = client(transport);
    const error = await value.verifyConnection().catch((caught) => caught);

    expectSafeClientError(error, "network-failed", true);
    expect(transport.requests).toHaveLength(4);
    expect(clock.delays).toEqual([100, 200, 400]);
    expect(clock.delays.every((delay) => delay >= 0 && delay <= 300_000)).toBe(true);
  });

  it("retries timeout and network transport failures without retaining their provider text", async () => {
    for (const failure of [new NotionTransportError("timeout"), new Error(TEST_CREDENTIALS.networkError)]) {
      const transport = new RecordingTransport([failure, failure, failure, failure]);
      const { value, clock } = client(transport);
      const error = await value.verifyConnection().catch((caught) => caught);
      expectSafeClientError(error, failure instanceof NotionTransportError ? "timeout" : "network-failed", true);
      expect(transport.requests).toHaveLength(4);
      expect(clock.delays).toHaveLength(3);
    }
  });

  it.each([
    [400, "invalid-response"],
    [401, "authentication-failed"],
    [403, "authorization-failed"],
    [404, "not-found"],
    [409, "revision-race"],
  ] as const)("does not retry HTTP %s", async (status, code) => {
    const transport = new RecordingTransport([response({ message: TOKEN }, status)]);
    const { value, clock } = client(transport);
    const error = await value.verifyConnection().catch((caught) => caught);

    expectSafeClientError(error, code, false);
    expect(transport.requests).toHaveLength(1);
    expect(clock.delays).toEqual([]);
  });
});

describe("NotionClient raw page validation and decoder boundary", () => {
  it.each([
    ["missing managed property", (value: Record<string, any>) => { delete value.properties.Name; }],
    ["wrong managed property type", (value: Record<string, any>) => { value.properties.Name.type = "rich_text"; }],
    ["ambiguous title array", (value: Record<string, any>) => { value.properties.Name.title.push(clone(value.properties.Name.title[0])); }],
    ["bad status", (value: Record<string, any>) => { value.properties["Sync Status"].select.name = "Unmanaged"; }],
    ["duplicate tag", (value: Record<string, any>) => { value.properties.Tags.multi_select.push({ name: "alpha" }); }],
    ["unsafe path", (value: Record<string, any>) => { value.properties["Obsidian Path"].rich_text[0].plain_text = "../Alpha.md"; }],
    ["bad title", (value: Record<string, any>) => { value.properties.Name.title[0].plain_text = ""; }],
    ["malformed page UUID", (value: Record<string, any>) => { value.id = "not-a-uuid"; }],
    ["malformed timestamp", (value: Record<string, any>) => { value.last_edited_time = "soon"; }],
    ["malformed page URL", (value: Record<string, any>) => { value.url = "https://attacker.invalid/page"; }],
  ])("rejects %s before semantic decoding", async (_label, mutate) => {
    const invalid = page() as Record<string, any>;
    mutate(invalid);
    const transport = new RecordingTransport([response(invalid)]);
    const error = await client(transport).value.retrievePage(PAGE_ID).catch((caught) => caught);

    expectSafeClientError(error, "invalid-response", false);
    expect(transport.requests).toHaveLength(1);
  });

  it("rejects a page-markdown object for a different page", async () => {
    const mismatch = markdown() as Record<string, any>;
    mismatch.id = OTHER_PAGE_ID;
    const transport = new RecordingTransport([response(page()), response(mismatch)]);
    const error = await client(transport).value.retrievePage(PAGE_ID).catch((caught) => caught);

    expectSafeClientError(error, "invalid-response", false);
  });

  it("passes an immutable detached raw record to the decoder and does not invent semantics", async () => {
    let received: Readonly<RawNotionPageRecord> | undefined;
    const immutableDecoder = decoder((record) => {
      received = record;
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.managed)).toBe(true);
      expect(Object.isFrozen(record.managed.tags)).toBe(true);
      expect(() => (record.managed.tags as string[]).push("mutated")).toThrow();
      return observationFromDecoder(record);
    });
    const transport = new RecordingTransport([response(page()), response(markdown())]);
    const result = await client(transport, immutableDecoder).value.retrievePage(PAGE_ID);

    expect(received).toMatchObject({ pageId: PAGE_ID, sourceMarkdown: "old body", managed: { tags: ["alpha", "zeta"] } });
    expect(result.semantic.bodyMarkdown).toBe("semantic payload owned by the injected decoder");
    expect(result.semantic.bodyMarkdown).not.toBe(result.sourceMarkdown);
    expect(result.semanticHash).toBe(SEMANTIC_HASH);
  });

  it("rejects a decoder that changes raw identity, managed values, or completeness", async () => {
    const changingPage = decoder((record) => observationFromDecoder(record, { pageId: OTHER_PAGE_ID }));
    const changedManaged = decoder((record) => observationFromDecoder(record, {
      managed: { title: "Other", obsidianPath: "Notes/Alpha.md", status: "synced" },
    }));
    const incomplete = markdown() as Record<string, any>;
    incomplete.truncated = true;
    const claimsComplete = decoder((record) => observationFromDecoder(record, { complete: true }));

    for (const [transport, decode] of [
      [new RecordingTransport([response(page()), response(markdown())]), changingPage],
      [new RecordingTransport([response(page()), response(markdown())]), changedManaged],
      [new RecordingTransport([response(page()), response(incomplete)]), claimsComplete],
    ] as const) {
      const error = await client(transport, decode).value.retrievePage(PAGE_ID).catch((caught) => caught);
      expectSafeClientError(error, "invalid-response", false);
    }
  });

  it.each([
    ["forged", ["alpha", "forged"]],
    ["lost", ["alpha"]],
    ["duplicated", ["alpha", "alpha"]],
  ] as const)("rejects decoder semantic tags that are %s instead of the managed tag set", async (_label, tags) => {
    const transport = new RecordingTransport([response(page()), response(markdown())]);
    const changedTags = decoder((record) => observationFromDecoder(record, {
      semantic: { bodyMarkdown: "decoder-owned body", tags: [...tags] },
    }));
    const error = await client(transport, changedTags).value.retrievePage(PAGE_ID).catch((caught) => caught);

    expectSafeClientError(error, "invalid-response", false);
  });

  it("permits canonical decoder tag reordering while preserving the managed tag set", async () => {
    const source = page() as Record<string, any>;
    source.properties.Tags.multi_select.reverse();
    const sortedTags = decoder((record) => observationFromDecoder(record, {
      semantic: { bodyMarkdown: "decoder-owned body", tags: [...record.managed.tags].sort() },
    }));
    const result = await client(
      new RecordingTransport([response(source), response(markdown())]),
      sortedTags,
    ).value.retrievePage(PAGE_ID);

    expect(result.semantic.tags).toEqual(["alpha", "zeta"]);
  });

  it("only returns incomplete content through the decoder path for truncation or unknown blocks", async () => {
    for (const [field, value] of [
      ["truncated", true],
      ["unknown_block_ids", [OTHER_PAGE_ID]],
    ] as const) {
      const source = markdown() as Record<string, any>;
      source[field] = value;
      const transport = new RecordingTransport([response(page()), response(source)]);
      const result = await client(transport).value.retrievePage(PAGE_ID);
      expect(result.complete).toBe(false);
    }
  });
});

describe("NotionClient compare and update safety", () => {
  it.each([
    ["zero", "missing body"],
    ["multiple", "old body\nold body"],
  ])("rejects %s old-body matches before PATCH", async (_label, remoteMarkdown) => {
    const source = markdown() as Record<string, any>;
    source.markdown = remoteMarkdown;
    const transport = new RecordingTransport([response(page()), response(source)]);
    const error = await client(transport).value.updateBodyExact({
      pageId: PAGE_ID,
      oldMarkdown: "old body",
      newMarkdown: "new body",
      observedEditedAt: EDITED_AT,
    }).catch((caught) => caught);

    expectSafeClientError(error, "revision-race", false);
    expect(transport.requests).toHaveLength(2);
  });

  it("uses replace_content only after a pre-read confirms an empty remote body", async () => {
    const transport = new RecordingTransport([
      response(page()),
      response(emptyMarkdown()),
      response(updatedMarkdown()),
      response(page()),
      response(updatedMarkdown()),
    ]);
    await client(transport).value.updateBodyExact({
      pageId: PAGE_ID,
      oldMarkdown: "",
      newMarkdown: "new body",
      observedEditedAt: EDITED_AT,
    });

    expect(transport.requests[2]?.body).toEqual({
      type: "replace_content",
      replace_content: { new_str: "new body" },
    });
  });

  it("detects the observed-edited-at race before PATCH", async () => {
    const changed = page() as Record<string, any>;
    changed.last_edited_time = "2026-07-14T12:00:01.000Z";
    const transport = new RecordingTransport([response(changed), response(markdown())]);
    const error = await client(transport).value.updateBodyExact({
      pageId: PAGE_ID,
      oldMarkdown: "old body",
      newMarkdown: "new body",
      observedEditedAt: EDITED_AT,
    }).catch((caught) => caught);

    expectSafeClientError(error, "revision-race", false);
    expect(transport.requests).toHaveLength(2);
  });

  it("validates update responses and the mandatory post-read without exposing provider data", async () => {
    const badUpdate = updatedMarkdown() as Record<string, any>;
    badUpdate.id = OTHER_PAGE_ID;
    const badPostRead = page() as Record<string, any>;
    badPostRead.url = `https://www.notion.so/Beta-${OTHER_PAGE_ID.replaceAll("-", "")}`;

    for (const responses of [
      [response(page()), response(markdown()), response(badUpdate)],
      [response(page()), response(markdown()), response(updatedMarkdown()), response(badPostRead)],
    ]) {
      const transport = new RecordingTransport(responses);
      const error = await client(transport).value.updateBodyExact({
        pageId: PAGE_ID,
        oldMarkdown: "old body",
        newMarkdown: "new body",
        observedEditedAt: EDITED_AT,
      }).catch((caught) => caught);
      expectSafeClientError(error, "invalid-response", false);
    }
  });

  it("requires matching edited-at metadata before managed updates and validates its response", async () => {
    const raced = page() as Record<string, any>;
    raced.last_edited_time = "2026-07-14T12:00:01.000Z";
    const raceTransport = new RecordingTransport([response(raced)]);
    const racedError = await client(raceTransport).value.updateManagedProperties({
      pageId: PAGE_ID,
      title: "Alpha",
      obsidianPath: "Notes/Alpha.md",
      tags: ["alpha"],
      status: "synced" as PairStatus,
      observedEditedAt: EDITED_AT,
    }).catch((caught) => caught);
    expectSafeClientError(racedError, "revision-race", false);
    expect(raceTransport.requests).toHaveLength(1);

    const badUpdate = page() as Record<string, any>;
    badUpdate.id = OTHER_PAGE_ID;
    const invalidResponseTransport = new RecordingTransport([response(page()), response(badUpdate)]);
    const invalidResponseError = await client(invalidResponseTransport).value.updateManagedProperties({
      pageId: PAGE_ID,
      title: "Alpha",
      obsidianPath: "Notes/Alpha.md",
      tags: ["alpha"],
      status: "synced" as PairStatus,
      observedEditedAt: EDITED_AT,
    }).catch((caught) => caught);
    expectSafeClientError(invalidResponseError, "invalid-response", false);
  });
});

describe("NotionClient redaction", () => {
  it("never retains the test token from provider body, headers, or exception text in a client error", async () => {
    const responseToken = response({ message: TEST_CREDENTIALS.bodyMessage }, 403, { "x-provider-token": TOKEN });
    const httpTransport = new RecordingTransport([responseToken]);
    const httpError = await client(httpTransport).value.verifyConnection().catch((caught) => caught);
    expectSafeClientError(httpError, "authorization-failed", false);

    const thrown = new Error(TEST_CREDENTIALS.providerException);
    const thrownTransport = new RecordingTransport([thrown]);
    const thrownError = await client(thrownTransport).value.verifyConnection().catch((caught) => caught);
    expectSafeClientError(thrownError, "network-failed", true);
  });
});
