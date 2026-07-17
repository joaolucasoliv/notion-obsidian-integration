import { describe, expect, it } from "vitest";
import type { CortexPageObservation } from "@grandbox-bridge/shared";
import { discoverCortexTree } from "./discovery.js";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ONE_ID = "22222222-2222-4222-8222-222222222222";
const CHILD_TWO_ID = "33333333-3333-4333-8333-333333333333";
const OUTSIDE_PARENT_ID = "55555555-5555-4555-8555-555555555555";
const TRAVERSAL_ID = "66666666-6666-4666-8666-666666666666";
const HASH = "a".repeat(64);

function page(pageId: string, parentPageId: string | null, title: string): CortexPageObservation {
  return {
    pageId,
    parentPageId,
    rootPageId: ROOT_ID,
    title,
    sourceMarkdown: `${title} body`,
    directChildPageIds: [],
    semanticHash: HASH,
    structureHash: HASH,
    editedAt: "2026-07-15T12:00:00.000Z",
    complete: true,
  };
}

function children(ids: readonly string[], hasMore = false, nextCursor: string | null = null): unknown {
  return {
    object: "list",
    results: ids.map((id) => ({ object: "block", id, type: "child_page", child_page: { title: id } })),
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

describe("discoverCortexTree", () => {
  it("paginates child blocks and visits regular pages in deterministic ID order", async () => {
    const requested: Array<readonly [string, string | undefined]> = [];
    const source = {
      retrieveCortexPage: async (pageId: string) => {
        if (pageId === ROOT_ID) return page(ROOT_ID, OUTSIDE_PARENT_ID, "The Cortex");
        if (pageId === CHILD_ONE_ID) return page(CHILD_ONE_ID, ROOT_ID, "Research");
        if (pageId === CHILD_TWO_ID) return page(CHILD_TWO_ID, ROOT_ID, "Projects");
        return null;
      },
      listBlockChildren: async (pageId: string, startCursor?: string) => {
        requested.push([pageId, startCursor]);
        if (pageId === ROOT_ID && startCursor === undefined) return children([CHILD_TWO_ID], true, "next page");
        if (pageId === ROOT_ID && startCursor === "next page") return children([CHILD_ONE_ID]);
        return children([]);
      },
    };

    const result = await discoverCortexTree(
      { rootPageId: ROOT_ID, maxDepth: 32, maxPages: 5 },
      { source, traversalId: () => TRAVERSAL_ID },
    );

    expect(result).toMatchObject({ rootPageId: ROOT_ID, traversalId: TRAVERSAL_ID, complete: true, attention: [] });
    expect(result.pages.map((candidate) => [candidate.pageId, candidate.parentPageId])).toEqual([
      [ROOT_ID, null],
      [CHILD_ONE_ID, ROOT_ID],
      [CHILD_TWO_ID, ROOT_ID],
    ]);
    expect(requested).toEqual([
      [ROOT_ID, undefined],
      [ROOT_ID, "next page"],
      [CHILD_ONE_ID, undefined],
      [CHILD_TWO_ID, undefined],
    ]);
  });

  it("marks duplicate IDs and ancestor cycles incomplete without duplicating a page", async () => {
    const source = {
      retrieveCortexPage: async (pageId: string) => {
        if (pageId === ROOT_ID) return page(ROOT_ID, OUTSIDE_PARENT_ID, "The Cortex");
        if (pageId === CHILD_ONE_ID) return page(CHILD_ONE_ID, ROOT_ID, "Research");
        return null;
      },
      listBlockChildren: async (pageId: string) => {
        if (pageId === ROOT_ID) return children([CHILD_ONE_ID, CHILD_ONE_ID]);
        return children([ROOT_ID]);
      },
    };

    const result = await discoverCortexTree(
      { rootPageId: ROOT_ID, maxDepth: 32, maxPages: 5 },
      { source, traversalId: () => TRAVERSAL_ID },
    );

    expect(result.complete).toBe(false);
    expect(result.pages.map((candidate) => candidate.pageId)).toEqual([ROOT_ID, CHILD_ONE_ID]);
    expect(result.attention).toEqual([
      { kind: "cycle", pageId: ROOT_ID },
      { kind: "cycle", pageId: CHILD_ONE_ID },
    ]);
  });

  it("records malformed list data and incomplete cursor chains as attention", async () => {
    const malformedSource = {
      retrieveCortexPage: async () => page(ROOT_ID, OUTSIDE_PARENT_ID, "The Cortex"),
      listBlockChildren: async () => ({ object: "list", results: [null], has_more: false, next_cursor: null }),
    };
    const truncatedSource = {
      retrieveCortexPage: async () => page(ROOT_ID, OUTSIDE_PARENT_ID, "The Cortex"),
      listBlockChildren: async () => children([], true, null),
    };

    const malformed = await discoverCortexTree(
      { rootPageId: ROOT_ID, maxDepth: 32, maxPages: 5 },
      { source: malformedSource, traversalId: () => TRAVERSAL_ID },
    );
    const truncated = await discoverCortexTree(
      { rootPageId: ROOT_ID, maxDepth: 32, maxPages: 5 },
      { source: truncatedSource, traversalId: () => TRAVERSAL_ID },
    );

    expect(malformed).toMatchObject({ complete: false, attention: [{ kind: "invalid-page", pageId: ROOT_ID }] });
    expect(truncated).toMatchObject({ complete: false, attention: [{ kind: "truncated", pageId: ROOT_ID }] });
  });

  it("bounds depth and total pages before reporting a complete tree", async () => {
    const source = {
      retrieveCortexPage: async (pageId: string) => {
        if (pageId === ROOT_ID) return page(ROOT_ID, OUTSIDE_PARENT_ID, "The Cortex");
        if (pageId === CHILD_ONE_ID) return page(CHILD_ONE_ID, ROOT_ID, "Research");
        if (pageId === CHILD_TWO_ID) return page(CHILD_TWO_ID, ROOT_ID, "Projects");
        return null;
      },
      listBlockChildren: async (pageId: string) => pageId === ROOT_ID
        ? children([CHILD_TWO_ID, CHILD_ONE_ID])
        : children([]),
    };

    const depthLimited = await discoverCortexTree(
      { rootPageId: ROOT_ID, maxDepth: 0, maxPages: 5 },
      { source, traversalId: () => TRAVERSAL_ID },
    );
    const pageLimited = await discoverCortexTree(
      { rootPageId: ROOT_ID, maxDepth: 32, maxPages: 2 },
      { source, traversalId: () => TRAVERSAL_ID },
    );

    expect(depthLimited).toMatchObject({
      complete: false,
      pages: [expect.objectContaining({ pageId: ROOT_ID })],
      attention: [{ kind: "depth-limit", pageId: CHILD_ONE_ID }],
    });
    expect(pageLimited).toMatchObject({
      complete: false,
      pages: [expect.objectContaining({ pageId: ROOT_ID }), expect.objectContaining({ pageId: CHILD_ONE_ID })],
      attention: [{ kind: "page-limit", pageId: CHILD_TWO_ID }],
    });
  });

  it("counts inaccessible candidates toward the page cap before issuing unbounded child reads", async () => {
    const requested: string[] = [];
    const source = {
      retrieveCortexPage: async (pageId: string) => {
        requested.push(pageId);
        return pageId === ROOT_ID ? page(ROOT_ID, OUTSIDE_PARENT_ID, "The Cortex") : null;
      },
      listBlockChildren: async (pageId: string) => pageId === ROOT_ID
        ? children([CHILD_ONE_ID, CHILD_TWO_ID])
        : children([]),
    };

    const result = await discoverCortexTree(
      { rootPageId: ROOT_ID, maxDepth: 32, maxPages: 2 },
      { source, traversalId: () => TRAVERSAL_ID },
    );

    expect(requested).toEqual([ROOT_ID, CHILD_ONE_ID]);
    expect(result).toMatchObject({
      complete: false,
      pages: [expect.objectContaining({ pageId: ROOT_ID })],
      attention: [
        { kind: "inaccessible", pageId: CHILD_ONE_ID },
        { kind: "page-limit", pageId: CHILD_TWO_ID },
      ],
    });
  });

  it("keeps inaccessible, unsupported, and incomplete child pages out of missing-page classification", async () => {
    const unsupportedId = "44444444-4444-4444-8444-444444444444";
    const incomplete = page(CHILD_TWO_ID, ROOT_ID, "Projects");
    incomplete.complete = false;
    const source = {
      retrieveCortexPage: async (pageId: string) => {
        if (pageId === ROOT_ID) return page(ROOT_ID, OUTSIDE_PARENT_ID, "The Cortex");
        if (pageId === CHILD_ONE_ID) throw Object.assign(new Error("forbidden"), { code: "authorization-failed" });
        if (pageId === CHILD_TWO_ID) return incomplete;
        if (pageId === unsupportedId) return { object: "database" };
        return null;
      },
      listBlockChildren: async (pageId: string) => pageId === ROOT_ID
        ? children([unsupportedId, CHILD_TWO_ID, CHILD_ONE_ID])
        : children([]),
    };

    const result = await discoverCortexTree(
      { rootPageId: ROOT_ID, maxDepth: 32, maxPages: 5 },
      { source, traversalId: () => TRAVERSAL_ID },
    );

    expect(result.complete).toBe(false);
    expect(result.pages.map((candidate) => candidate.pageId)).toEqual([ROOT_ID, CHILD_TWO_ID]);
    expect(result.attention).toEqual([
      { kind: "inaccessible", pageId: CHILD_ONE_ID },
      { kind: "truncated", pageId: CHILD_TWO_ID },
      { kind: "invalid-page", pageId: unsupportedId },
    ]);
    expect(result.attention.map((entry) => entry.kind)).not.toContain("missing-notion");
  });
});
