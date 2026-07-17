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
const BLOCK_ID = "55555555-5555-4555-8555-555555555555";
const NESTED_BLOCK_ID = "66666666-6666-4666-8666-666666666666";
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

function cortexRoot(): Record<string, unknown> {
  return fixture<Record<string, unknown>>("cortex-root.json");
}

function cortexChildOne(): Record<string, unknown> {
  return fixture<Record<string, unknown>>("cortex-child-page-1.json");
}

function cortexChildTwo(): Record<string, unknown> {
  return fixture<Record<string, unknown>>("cortex-child-page-2.json");
}

function cortexMarkdown(): Record<string, unknown> {
  return fixture<Record<string, unknown>>("cortex-markdown.json");
}

function cortexMarkdownFor(pageId: string, markdown = "Body"): Record<string, unknown> {
  const value = cortexMarkdown() as Record<string, any>;
  value.id = pageId;
  value.markdown = markdown;
  return value;
}

function blockChildren(ids: readonly string[], hasMore = false, nextCursor: string | null = null): Record<string, unknown> {
  return {
    object: "list",
    results: ids.map((id) => ({ object: "block", id, type: "child_page", child_page: { title: id } })),
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

function regularCortexPage(pageId: string, parentPageId: string, title = "Cortex page"): Record<string, unknown> {
  return {
    object: "page",
    id: pageId,
    url: `https://www.notion.so/Cortex-${pageId.replaceAll("-", "")}`,
    last_edited_time: "2026-07-15T12:00:00.000Z",
    in_trash: false,
    parent: { type: "page_id", page_id: parentPageId },
    properties: {
      title: {
        id: "title",
        type: "title",
        title: [{ type: "text", plain_text: title, text: { content: title } }],
      },
    },
  };
}

function cortexAncestorChain(rootPageId: string, depth: number): readonly Record<string, unknown>[] {
  const pageIds = Array.from(
    { length: depth },
    (_unused, index) => `70000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
  );
  return pageIds.map((pageId, index) => regularCortexPage(pageId, index === 0 ? rootPageId : pageIds[index - 1] as string, `Depth ${index + 1}`));
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

function expectSafeCortexError(error: unknown, code: string, retryable: boolean): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: unknown }).code).toBe(code);
  expect((error as { retryable?: unknown }).retryable).toBe(retryable);
  const rendered = `${String(error)} ${JSON.stringify(error)} ${Object.values(error as object).join(" ")}`;
  expect(rendered).not.toContain(TOKEN);
  expect(rendered).not.toContain("Bearer");
}

describe("NotionClient request contract", () => {
  it("discovers a title-only regular page without requiring Grandbox Notes properties", async () => {
    const root = cortexRoot();
    const rootId = root.id as string;
    const transport = new RecordingTransport([
      response(root),
      response(cortexMarkdown()),
      response({ object: "list", results: [], has_more: false, next_cursor: null }),
    ]);
    const cortex = (client(transport).value as unknown as {
      readonly cortexTree: { discoverCortexTree(input: { rootPageId: string; maxDepth: number; maxPages: number }): Promise<unknown> };
    }).cortexTree;

    await expect(cortex.discoverCortexTree({ rootPageId: rootId, maxDepth: 32, maxPages: 5 })).resolves.toMatchObject({
      rootPageId: rootId,
      complete: true,
      pages: [expect.objectContaining({ pageId: rootId, parentPageId: null, title: "The Cortex" })],
    });
  });

  it("uses paginated block-children requests and deterministic child IDs for regular-page discovery", async () => {
    const root = cortexRoot();
    const childOne = cortexChildOne();
    const childTwo = cortexChildTwo();
    const rootId = root.id as string;
    const childOneId = childOne.id as string;
    const childTwoId = childTwo.id as string;
    (childTwo as Record<string, any>).parent.page_id = rootId;
    const transport = new RecordingTransport([
      response(root),
      response(cortexMarkdownFor(rootId)),
      response({ ...blockChildren([childTwoId]), has_more: true, next_cursor: "cursor /?&" }),
      response(blockChildren([childOneId])),
      response(childOne),
      response(cortexMarkdownFor(childOneId)),
      response(blockChildren([])),
      response(childTwo),
      response(cortexMarkdownFor(childTwoId)),
      response(blockChildren([])),
    ]);

    const result = await client(transport).value.cortexTree.discoverCortexTree({ rootPageId: rootId, maxDepth: 32, maxPages: 5 });

    expect(result.pages.map((candidate) => candidate.pageId)).toEqual([rootId, childOneId, childTwoId]);
    expect(result.pages[0]).toMatchObject({ parentPageId: null, directChildPageIds: [childTwoId, childOneId] });
    expect(transport.requests.filter((request) => request.path.includes("/children")).map(({ path, query }) => ({ path, query }))).toEqual([
      { path: `/v1/blocks/${rootId}/children`, query: { page_size: "100" } },
      { path: `/v1/blocks/${rootId}/children`, query: { page_size: "100", start_cursor: "cursor /?&" } },
      { path: `/v1/blocks/${childOneId}/children`, query: { page_size: "100" } },
      { path: `/v1/blocks/${childTwoId}/children`, query: { page_size: "100" } },
    ]);
  });

  it.each([403, 404])("returns attention rather than a missing child when regular-page access is denied (%i)", async (status) => {
    const root = cortexRoot();
    const childOne = cortexChildOne();
    const rootId = root.id as string;
    const childOneId = childOne.id as string;
    const transport = new RecordingTransport([
      response(root),
      response(cortexMarkdownFor(rootId)),
      response(blockChildren([childOneId])),
      response({ message: "inaccessible" }, status),
    ]);

    const result = await client(transport).value.cortexTree.discoverCortexTree({ rootPageId: rootId, maxDepth: 32, maxPages: 5 });

    expect(result).toMatchObject({
      complete: false,
      pages: [expect.objectContaining({ pageId: rootId })],
      attention: [{ kind: "inaccessible", pageId: childOneId }],
    });
  });

  it("marks an unsupported regular-page object invalid without treating it as missing", async () => {
    const root = cortexRoot();
    const childOne = cortexChildOne();
    const rootId = root.id as string;
    const childOneId = childOne.id as string;
    const transport = new RecordingTransport([
      response(root),
      response(cortexMarkdownFor(rootId)),
      response(blockChildren([childOneId])),
      response({ object: "database" }),
    ]);

    const result = await client(transport).value.cortexTree.discoverCortexTree({ rootPageId: rootId, maxDepth: 32, maxPages: 5 });

    expect(result).toMatchObject({
      complete: false,
      pages: [expect.objectContaining({ pageId: rootId })],
      attention: [{ kind: "invalid-page", pageId: childOneId }],
    });
  });

  it("does not expose an out-of-root page through root-scoped retrieval", async () => {
    const root = cortexRoot();
    const child = cortexChildOne() as Record<string, any>;
    const external = cortexChildTwo() as Record<string, any>;
    const rootId = root.id as string;
    const childId = child.id as string;
    child.parent.page_id = OTHER_PAGE_ID;
    external.id = OTHER_PAGE_ID;
    external.url = (external.url as string).replaceAll("33333333333343338333333333333333", "44444444444444448444444444444444");
    external.parent.page_id = OTHER_PAGE_ID;
    const transport = new RecordingTransport([response(child), response(external)]);

    const error = await client(transport).value.cortexTree.retrieveCortexPage({ rootPageId: rootId, pageId: childId }).catch((caught) => caught);

    expectSafeCortexError(error, "revision-race", false);
    expect(transport.requests).toEqual([
      expect.objectContaining({ method: "GET", path: `/v1/pages/${childId}` }),
      expect.objectContaining({ method: "GET", path: `/v1/pages/${OTHER_PAGE_ID}` }),
    ]);
  });

  it("creates a title-only regular page below a revision-checked page parent", async () => {
    const root = cortexRoot();
    const child = cortexChildOne();
    const rootId = root.id as string;
    const childId = child.id as string;
    const transport = new RecordingTransport([
      response(root),
      response(cortexMarkdownFor(rootId)),
      response(blockChildren([])),
      response(child),
      response(child),
      response(cortexMarkdownFor(childId, "Created body")),
      response(blockChildren([])),
      response(child),
    ]);

    const result = await client(transport).value.cortexTree.createCortexPage({
      rootPageId: rootId,
      parentPageId: rootId,
      title: "Research",
      markdown: "Created body",
      expectedParentEditedAt: root.last_edited_time as string,
    });

    expect(result).toMatchObject({ pageId: childId, parentPageId: rootId, title: "Research", directChildPageIds: [] });
    expect(transport.requests).toHaveLength(8);
    expect(transport.requests[7]).toMatchObject({ method: "GET", path: `/v1/pages/${childId}` });
    expect(transport.requests[3]).toEqual({
      method: "POST",
      path: "/v1/pages",
      headers: commonHeaders(true),
      body: {
        parent: { type: "page_id", page_id: rootId },
        properties: { title: { title: [{ type: "text", text: { content: "Research" } }] } },
        markdown: "Created body",
      },
      timeoutMs: 15_000,
      maxBytes: 2 * 1024 * 1024,
    });
  });

  it("rechecks title revisions and never sends a stale regular-page mutation", async () => {
    const root = cortexRoot();
    const rootId = root.id as string;
    const transport = new RecordingTransport([
      response(root),
      response(cortexMarkdownFor(rootId)),
      response(blockChildren([])),
    ]);

    const error = await client(transport).value.cortexTree.updateCortexTitle({
      rootPageId: rootId,
      pageId: rootId,
      title: "New Cortex",
      observedEditedAt: "2026-07-15T11:59:00.000Z",
    }).catch((caught) => caught);

    expectSafeCortexError(error, "revision-race", false);
    expect(transport.requests).toHaveLength(3);
    expect(transport.requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("updates a regular-page title through only its title property", async () => {
    const root = cortexRoot();
    const child = cortexChildOne() as Record<string, any>;
    const rootId = root.id as string;
    const childId = child.id as string;
    const updated = clone(child) as Record<string, any>;
    updated.properties.title.title[0].plain_text = "Research Notes";
    updated.properties.title.title[0].text.content = "Research Notes";
    updated.last_edited_time = "2026-07-15T12:03:00.000Z";
    const transport = new RecordingTransport([
      response(child),
      response(child),
      response(cortexMarkdownFor(childId)),
      response(blockChildren([])),
      response(updated),
      response(updated),
      response(cortexMarkdownFor(childId)),
      response(blockChildren([])),
      response(updated),
    ]);

    const result = await client(transport).value.cortexTree.updateCortexTitle({
      rootPageId: rootId,
      pageId: childId,
      title: "Research Notes",
      observedEditedAt: child.last_edited_time,
    });

    expect(result).toMatchObject({ pageId: childId, title: "Research Notes", parentPageId: rootId });
    expect(transport.requests).toHaveLength(9);
    expect(transport.requests[8]).toMatchObject({ method: "GET", path: `/v1/pages/${childId}` });
    expect(transport.requests[4]).toMatchObject({
      method: "PATCH",
      path: `/v1/pages/${childId}`,
      body: { properties: { title: { title: [{ type: "text", text: { content: "Research Notes" } }] } } },
    });
  });

  it("fails closed when a post-title ancestor leaves the configured root after preflight", async () => {
    const root = cortexRoot();
    const ancestor = cortexChildOne() as Record<string, any>;
    const target = cortexChildTwo() as Record<string, any>;
    const rootId = root.id as string;
    const targetId = target.id as string;
    const updated = clone(target) as Record<string, any>;
    updated.properties.title.title[0].plain_text = "Project Renamed";
    updated.properties.title.title[0].text.content = "Project Renamed";
    updated.last_edited_time = "2026-07-15T12:04:00.000Z";
    const ancestorMoved = clone(ancestor) as Record<string, any>;
    ancestorMoved.parent.page_id = OTHER_PAGE_ID;
    const outside = regularCortexPage(OTHER_PAGE_ID, OTHER_PAGE_ID, "Outside Cortex");
    const transport = new RecordingTransport([
      response(target),
      response(ancestor),
      response(target),
      response(cortexMarkdownFor(targetId)),
      response(blockChildren([])),
      response(updated),
      response(updated),
      response(cortexMarkdownFor(targetId)),
      response(blockChildren([])),
      response(updated),
      response(ancestorMoved),
      response(outside),
    ]);

    const error = await client(transport).value.cortexTree.updateCortexTitle({
      rootPageId: rootId,
      pageId: targetId,
      title: "Project Renamed",
      observedEditedAt: target.last_edited_time,
    }).catch((caught) => caught);

    expectSafeCortexError(error, "revision-race", false);
    expect(transport.requests.some((request) => request.method === "PATCH")).toBe(true);
  });

  it("does not retry an ambiguous Cortex page creation", async () => {
    const root = cortexRoot();
    const rootId = root.id as string;
    const transport = new RecordingTransport([
      response(root),
      response(cortexMarkdownFor(rootId)),
      response(blockChildren([])),
      new NotionTransportError("timeout"),
    ]);

    const error = await client(transport).value.cortexTree.createCortexPage({
      rootPageId: rootId,
      parentPageId: rootId,
      title: "Research",
      markdown: "Created body",
      expectedParentEditedAt: root.last_edited_time as string,
    }).catch((caught) => caught);

    expectSafeClientError(error, "timeout", true);
    expect(transport.requests).toHaveLength(4);
    expect(transport.requests[3]).toMatchObject({ method: "POST", path: "/v1/pages" });
  });

  it("rejects creation below a depth-32 parent before sending POST", async () => {
    const root = cortexRoot();
    const rootId = root.id as string;
    const ancestors = cortexAncestorChain(rootId, 32);
    const parent = ancestors[31] as Record<string, unknown>;
    const parentId = parent.id as string;
    const transport = new RecordingTransport([...ancestors].reverse().map((entry) => response(entry)));

    const error = await client(transport).value.cortexTree.createCortexPage({
      rootPageId: rootId,
      parentPageId: parentId,
      title: "Too deep",
      markdown: "Body",
      expectedParentEditedAt: parent.last_edited_time as string,
    }).catch((caught) => caught);

    expectSafeCortexError(error, "revision-race", false);
    expect(transport.requests).toHaveLength(32);
    expect(transport.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("updates regular-page bodies only when ordered child-page markers match the fresh snapshot", async () => {
    const root = cortexRoot();
    const child = cortexChildOne();
    const grandchild = cortexChildTwo();
    const rootId = root.id as string;
    const childId = child.id as string;
    const grandchildId = grandchild.id as string;
    const firstChildPageId = OTHER_PAGE_ID;
    const updatedChild = clone(child) as Record<string, any>;
    updatedChild.last_edited_time = "2026-07-15T12:03:00.000Z";
    const firstMarker = `<!-- grandbox-cortex:child-page:${firstChildPageId} -->`;
    const secondMarker = `<!-- grandbox-cortex:child-page:${grandchildId} -->`;
    const transport = new RecordingTransport([
      response(child),
      response(child),
      response(cortexMarkdownFor(childId, "old body")),
      response(blockChildren([firstChildPageId, grandchildId])),
      response(cortexMarkdownFor(childId, "new body")),
      response(updatedChild),
      response(cortexMarkdownFor(childId, "new body")),
      response(blockChildren([firstChildPageId, grandchildId])),
      response(updatedChild),
    ]);

    const result = await client(transport).value.cortexTree.updateCortexBodyExact({
      rootPageId: rootId,
      pageId: childId,
      oldMarkdown: `old body${firstMarker}${secondMarker}`,
      newMarkdown: `new body${firstMarker}${secondMarker}`,
      observedEditedAt: child.last_edited_time as string,
    });

    expect(result).toMatchObject({ pageId: childId, directChildPageIds: [firstChildPageId, grandchildId] });
    expect(transport.requests).toHaveLength(9);
    expect(transport.requests[8]).toMatchObject({ method: "GET", path: `/v1/pages/${childId}` });
    expect(transport.requests[4]).toMatchObject({
      method: "PATCH",
      path: `/v1/pages/${childId}/markdown`,
      body: { type: "update_content", update_content: { content_updates: [{ old_str: "old body", new_str: "new body" }] } },
    });
    expect(JSON.stringify(transport.requests[4]?.body)).not.toContain("allow_deleting_content");
  });

  it("rejects a regular-page body write before PATCH when its child-page marker order changes", async () => {
    const root = cortexRoot();
    const child = cortexChildOne();
    const grandchild = cortexChildTwo();
    const rootId = root.id as string;
    const childId = child.id as string;
    const grandchildId = grandchild.id as string;
    const transport = new RecordingTransport([
      response(child),
      response(child),
      response(cortexMarkdownFor(childId, "old body")),
      response(blockChildren([grandchildId])),
    ]);

    const error = await client(transport).value.cortexTree.updateCortexBodyExact({
      rootPageId: rootId,
      pageId: childId,
      oldMarkdown: "old body",
      newMarkdown: "new body",
      observedEditedAt: child.last_edited_time as string,
    }).catch((caught) => caught);

    expectSafeCortexError(error, "revision-race", false);
    expect(transport.requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("moves a regular page through Notion's page-move endpoint after a fresh revision check", async () => {
    const root = cortexRoot();
    const childOne = cortexChildOne();
    const childTwo = cortexChildTwo();
    const rootId = root.id as string;
    const childOneId = childOne.id as string;
    const childTwoId = childTwo.id as string;
    const moved = clone(childTwo) as Record<string, any>;
    moved.parent.page_id = rootId;
    moved.last_edited_time = "2026-07-15T12:04:00.000Z";
    const transport = new RecordingTransport([
      response(childTwo),
      response(childOne),
      response(childTwo),
      response(cortexMarkdownFor(childTwoId)),
      response(blockChildren([])),
      response(moved),
      response(moved),
      response(cortexMarkdownFor(childTwoId)),
      response(blockChildren([])),
      response(moved),
    ]);

    const result = await client(transport).value.cortexTree.moveCortexPage({
      rootPageId: rootId,
      pageId: childTwoId,
      parentPageId: rootId,
      observedEditedAt: childTwo.last_edited_time as string,
    });

    expect(result).toMatchObject({ pageId: childTwoId, parentPageId: rootId });
    expect(transport.requests).toHaveLength(10);
    expect(transport.requests[9]).toMatchObject({ method: "GET", path: `/v1/pages/${childTwoId}` });
    expect(transport.requests[5]).toMatchObject({
      method: "POST",
      path: `/v1/pages/${childTwoId}/move`,
      body: { parent: { type: "page_id", page_id: rootId } },
    });
  });

  it("rejects a move below a depth-32 parent before reading or moving the target", async () => {
    const root = cortexRoot();
    const rootId = root.id as string;
    const target = regularCortexPage(PAGE_ID, rootId, "Target");
    const ancestors = cortexAncestorChain(rootId, 32);
    const parent = ancestors[31] as Record<string, unknown>;
    const parentId = parent.id as string;
    const transport = new RecordingTransport([
      response(target),
      ...[...ancestors].reverse().map((entry) => response(entry)),
    ]);

    const error = await client(transport).value.cortexTree.moveCortexPage({
      rootPageId: rootId,
      pageId: PAGE_ID,
      parentPageId: parentId,
      observedEditedAt: target.last_edited_time as string,
    }).catch((caught) => caught);

    expectSafeCortexError(error, "revision-race", false);
    expect(transport.requests).toHaveLength(33);
    expect(transport.requests.some((request) => request.path === `/v1/pages/${PAGE_ID}/markdown`)).toBe(false);
    expect(transport.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("rejects a move when a nested existing descendant would become depth 33", async () => {
    const root = cortexRoot();
    const rootId = root.id as string;
    const target = regularCortexPage(PAGE_ID, rootId, "Target");
    const childId = BLOCK_ID;
    const ancestors = cortexAncestorChain(rootId, 30);
    const parent = ancestors[29] as Record<string, unknown>;
    const parentId = parent.id as string;
    const moved = clone(target) as Record<string, any>;
    moved.parent.page_id = parentId;
    moved.last_edited_time = "2026-07-15T12:05:00.000Z";
    const transport = new RecordingTransport([
      response(target),
      ...[...ancestors].reverse().map((entry) => response(entry)),
      response(target),
      response(cortexMarkdownFor(PAGE_ID)),
      response(blockChildren([childId])),
      response(blockChildren([NESTED_BLOCK_ID])),
      response(moved),
      response(moved),
      response(cortexMarkdownFor(PAGE_ID)),
      response(blockChildren([childId])),
    ]);

    const error = await client(transport).value.cortexTree.moveCortexPage({
      rootPageId: rootId,
      pageId: PAGE_ID,
      parentPageId: parentId,
      observedEditedAt: target.last_edited_time as string,
    }).catch((caught) => caught);

    expectSafeCortexError(error, "revision-race", false);
    expect(transport.requests.some((request) => request.method === "POST")).toBe(false);
    expect(transport.requests.filter((request) => request.path.includes("/children"))).toEqual([
      expect.objectContaining({ path: `/v1/blocks/${PAGE_ID}/children`, query: { page_size: "100" } }),
      expect.objectContaining({ path: `/v1/blocks/${childId}/children`, query: { page_size: "100" } }),
    ]);
  });

  it("resolves only bounded opaque block-parent hops without retrieving page content", async () => {
    const transport = new RecordingTransport([
      response({ object: "block", id: BLOCK_ID, parent: { type: "block_id", block_id: NESTED_BLOCK_ID } }),
      response({ object: "block", id: NESTED_BLOCK_ID, parent: { type: "page_id", page_id: PAGE_ID } }),
    ]);

    await expect(client(transport).value.resolveEventPage(BLOCK_ID, 16)).resolves.toBe(PAGE_ID);
    expect(transport.requests).toEqual([
      { method: "GET", path: `/v1/blocks/${BLOCK_ID}`, headers: commonHeaders(), timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
      { method: "GET", path: `/v1/blocks/${NESTED_BLOCK_ID}`, headers: commonHeaders(), timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
    ]);

    const tooDeep = new RecordingTransport([
      response({ object: "block", id: BLOCK_ID, parent: { type: "block_id", block_id: NESTED_BLOCK_ID } }),
    ]);
    await expect(client(tooDeep).value.resolveEventPage(BLOCK_ID, 1)).resolves.toBeNull();
    expect(tooDeep.requests).toHaveLength(1);
  });

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
        markdown: "\u200B\n\n# Alpha\n",
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

  it("prefixes a leading H1 when replacing Notion markdown so it remains page content", async () => {
    const transport = new RecordingTransport([
      response(page()),
      response(markdown()),
      response(updatedMarkdown()),
      response(page()),
      response(updatedMarkdown()),
    ]);

    await client(transport).value.updateBodyExact({
      pageId: PAGE_ID,
      oldMarkdown: "old body",
      newMarkdown: "# Alpha\n",
      observedEditedAt: EDITED_AT,
    });

    expect(transport.requests[2]?.body).toEqual({
      type: "update_content",
      update_content: { content_updates: [{ old_str: "old body", new_str: "\u200B\n\n# Alpha\n" }] },
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

  it("does not replay an ambiguous page creation after a timeout", async () => {
    const transport = new RecordingTransport([
      new NotionTransportError("timeout"),
      response(page()),
      response(page()),
      response(markdown()),
    ]);
    const { value, clock } = client(transport);
    const error = await value.createNotePage({
      parentPageId: USER_ID,
      dataSourceId: OTHER_PAGE_ID,
      bridgeId: BRIDGE_ID,
      title: "Alpha",
      obsidianPath: "Notes/Alpha.md",
      tags: ["alpha"],
      markdown: "# Alpha\n",
    }).catch((caught) => caught);

    expectSafeClientError(error, "timeout", true);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({ method: "POST", path: "/v1/pages" });
    expect(clock.delays).toEqual([]);
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
  it("accepts canonical app.notion.com URLs returned by the current page API", async () => {
    const currentPage = page() as Record<string, any>;
    currentPage.url = `https://app.notion.com/${PAGE_ID}`;

    await expect(
      client(new RecordingTransport([response(currentPage), response(markdown())])).value.retrievePage(PAGE_ID),
    ).resolves.toMatchObject({ kind: "present", pageId: PAGE_ID });
  });

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
