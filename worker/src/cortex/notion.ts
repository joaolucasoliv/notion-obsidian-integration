import {
  sha256Hex,
  type CortexPageObservation,
  type CortexTreeDiscovery,
  type CortexTreeNotionApi,
  type CreateCortexPageInput,
  type DiscoverCortexTreeInput,
  type MoveCortexPageInput,
  type RetrieveCortexPageInput,
  type SafeErrorCode,
  type UpdateCortexBodyExactInput,
  type UpdateCortexTitleInput,
} from "@grandbox-bridge/shared";
import { collectCortexChildPageIds, discoverCortexTree, type CortexDiscoverySource } from "./discovery.js";
import { cortexSemanticHash } from "./semantic.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_PAGE_URL_BYTES = 2_048;
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const MAX_UNKNOWN_BLOCK_IDS = 100;
const MAX_TREE_DEPTH = 32;
const MAX_TREE_PAGES = 5_000;
const LEADING_H1_SENTINEL = "\u200B\n\n";
const CHILD_PAGE_MARKER_PREFIX = "<!-- grandbox-cortex:child-page:";
const CHILD_PAGE_MARKER = /<!--\s*grandbox-cortex:child-page:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*-->/gu;

export interface CortexNotionRequestExecutor {
  request<T>(input: {
    readonly method: "GET" | "POST" | "PATCH";
    readonly path: string;
    readonly body?: unknown;
    readonly query?: Readonly<Record<string, string>>;
  }): Promise<T>;
}

export interface CortexNotionApiOptions {
  readonly traversalId?: () => string;
}

export class CortexNotionError extends Error {
  public constructor(
    public readonly code: SafeErrorCode,
    public readonly retryable = false,
  ) {
    super(`Cortex Notion ${code}`);
    this.name = "CortexNotionError";
  }
}

interface RegularPageMetadata {
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly title: string;
  readonly editedAt: string;
}

interface RegularPageMarkdown {
  readonly pageId: string;
  readonly sourceMarkdown: string;
  readonly complete: boolean;
}

interface RootMembership {
  readonly page: RegularPageMetadata | null;
  readonly depth: number;
}

function failure(code: SafeErrorCode, retryable = false): CortexNotionError {
  return new CortexNotionError(code, retryable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isStrictInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isBoundedText(
  value: unknown,
  maximumBytes = 2_000,
  allowEmpty = false,
  allowOuterWhitespace = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    (allowOuterWhitespace || value.trim() === value) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function urlPageId(value: string): string | null {
  try {
    const parsed = new URL(value);
    const match = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(parsed.pathname);
    if (match === null) return null;
    const compact = (match[1] as string).replaceAll("-", "");
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  } catch {
    return null;
  }
}

function isSafePageUrl(value: unknown, expectedPageId: string): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_PAGE_URL_BYTES) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "notion.so" ||
        parsed.hostname.endsWith(".notion.so") ||
        parsed.hostname === "app.notion.com" ||
        parsed.hostname === "notion.site" ||
        parsed.hostname.endsWith(".notion.site")) &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.toString() === value &&
      urlPageId(value) === expectedPageId
    );
  } catch {
    return false;
  }
}

function plainTextItem(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "text" || !isBoundedText(value.plain_text, 2_000, false, true)) return null;
  if (!isRecord(value.text) || value.text.content !== value.plain_text) return null;
  return value.plain_text;
}

function regularTitle(properties: unknown): string | null {
  if (!isRecord(properties)) return null;
  const entries = Object.entries(properties);
  if (entries.length !== 1) return null;
  const property = entries[0]?.[1];
  if (!isRecord(property) || property.type !== "title" || !Array.isArray(property.title) || property.title.length !== 1) return null;
  return plainTextItem(property.title[0]);
}

/** This intentionally does not call the legacy Grandbox Notes metadata parser. */
function parseRegularPageMetadata(value: unknown, expectedPageId?: string): RegularPageMetadata {
  try {
    const parent: Record<string, unknown> | null = isRecord(value) && isRecord(value.parent) ? value.parent : null;
    const parentPageId = parent?.type === "page_id" && isCanonicalUuid(parent.page_id)
      ? parent.page_id
      : parent?.type === "workspace" && parent.workspace === true
        ? null
        : undefined;
    if (
      !isRecord(value) ||
      value.object !== "page" ||
      !isCanonicalUuid(value.id) ||
      (expectedPageId !== undefined && value.id !== expectedPageId) ||
      !isSafePageUrl(value.url, value.id) ||
      !isStrictInstant(value.last_edited_time) ||
      value.in_trash !== false ||
      parentPageId === undefined
    ) {
      throw failure("invalid-response");
    }
    const title = regularTitle(value.properties);
    if (title === null) throw failure("invalid-response");
    return Object.freeze({ pageId: value.id, parentPageId, title, editedAt: value.last_edited_time });
  } catch (caught) {
    if (caught instanceof CortexNotionError) throw caught;
    throw failure("invalid-response");
  }
}

function parseRegularPageMarkdown(value: unknown, expectedPageId: string): RegularPageMarkdown {
  try {
    if (
      !isRecord(value) ||
      value.object !== "page_markdown" ||
      !isCanonicalUuid(value.id) ||
      value.id !== expectedPageId ||
      typeof value.markdown !== "string" ||
      Buffer.byteLength(value.markdown, "utf8") > MAX_MARKDOWN_BYTES ||
      typeof value.truncated !== "boolean" ||
      !Array.isArray(value.unknown_block_ids) ||
      value.unknown_block_ids.length > MAX_UNKNOWN_BLOCK_IDS
    ) {
      throw failure("invalid-response");
    }
    const seen = new Set<string>();
    for (const unknownBlockId of value.unknown_block_ids) {
      if (!isCanonicalUuid(unknownBlockId) || seen.has(unknownBlockId)) throw failure("invalid-response");
      seen.add(unknownBlockId);
    }
    return Object.freeze({ pageId: value.id, sourceMarkdown: value.markdown, complete: !value.truncated && seen.size === 0 });
  } catch (caught) {
    if (caught instanceof CortexNotionError) throw caught;
    throw failure("invalid-response");
  }
}

function validMarkdown(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_MARKDOWN_BYTES;
}

function validTreeInput(value: unknown): value is { readonly rootPageId: string; readonly pageId: string } {
  return isRecord(value) && isCanonicalUuid(value.rootPageId) && isCanonicalUuid(value.pageId);
}

function validCreateInput(value: unknown): value is CreateCortexPageInput {
  return (
    isRecord(value) &&
    isCanonicalUuid(value.rootPageId) &&
    isCanonicalUuid(value.parentPageId) &&
    isBoundedText(value.title) &&
    validMarkdown(value.markdown) &&
    isStrictInstant(value.expectedParentEditedAt)
  );
}

function validTitleInput(value: unknown): value is UpdateCortexTitleInput {
  return (
    isRecord(value) &&
    isCanonicalUuid(value.rootPageId) &&
    isCanonicalUuid(value.pageId) &&
    isBoundedText(value.title) &&
    isStrictInstant(value.observedEditedAt)
  );
}

function validBodyInput(value: unknown): value is UpdateCortexBodyExactInput {
  return (
    isRecord(value) &&
    isCanonicalUuid(value.rootPageId) &&
    isCanonicalUuid(value.pageId) &&
    validMarkdown(value.oldMarkdown) &&
    validMarkdown(value.newMarkdown) &&
    isStrictInstant(value.observedEditedAt)
  );
}

function validMoveInput(value: unknown): value is MoveCortexPageInput {
  return (
    isRecord(value) &&
    isCanonicalUuid(value.rootPageId) &&
    isCanonicalUuid(value.pageId) &&
    isCanonicalUuid(value.parentPageId) &&
    isStrictInstant(value.observedEditedAt)
  );
}

function titleProperty(title: string): Record<string, unknown> {
  return { title: [{ type: "text", text: { content: title } }] };
}

function preserveLeadingH1(markdown: string): string {
  return /^#[ \t]/u.test(markdown) ? `${LEADING_H1_SENTINEL}${markdown}` : markdown;
}

function bodyMatchCount(source: string, oldMarkdown: string): number {
  if (oldMarkdown.length === 0) return source.length === 0 ? 1 : 0;
  let count = 0;
  let offset = 0;
  while (offset <= source.length - oldMarkdown.length) {
    const index = source.indexOf(oldMarkdown, offset);
    if (index === -1) return count;
    count += 1;
    if (count > 1) return count;
    offset = index + 1;
  }
  return count;
}

function childPageMarkers(markdown: string): readonly string[] | null {
  const markers: string[] = [];
  const matcher = new RegExp(CHILD_PAGE_MARKER.source, CHILD_PAGE_MARKER.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(markdown)) !== null) {
    const pageId = match[1];
    if (!isCanonicalUuid(pageId)) return null;
    markers.push(pageId);
  }
  if (markdown.replace(matcher, "").includes(CHILD_PAGE_MARKER_PREFIX)) return null;
  return Object.freeze(markers);
}

function stripChildPageMarkers(markdown: string): string {
  return markdown.replace(CHILD_PAGE_MARKER, "");
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorCode(caught: unknown): SafeErrorCode | null {
  if (!isRecord(caught) || typeof caught.code !== "string") return null;
  const safeCodes: readonly SafeErrorCode[] = [
    "invalid-config", "invalid-state", "unsafe-path", "credential-unavailable", "active-lock", "recovery-required",
    "authentication-failed", "authorization-failed", "not-found", "rate-limited", "network-failed", "timeout",
    "request-too-large", "response-too-large", "invalid-response", "revision-race", "unsupported-content",
    "identity-collision", "conversion-failed", "internal-error",
  ];
  return safeCodes.includes(caught.code as SafeErrorCode) ? caught.code as SafeErrorCode : null;
}

export class CortexNotionApi implements CortexTreeNotionApi {
  readonly #request: CortexNotionRequestExecutor;
  readonly #traversalId: () => string;

  public constructor(request: CortexNotionRequestExecutor, options: CortexNotionApiOptions = {}) {
    if (request === null || typeof request !== "object" || typeof request.request !== "function") {
      throw failure("invalid-config");
    }
    if (options.traversalId !== undefined && typeof options.traversalId !== "function") throw failure("invalid-config");
    this.#request = request;
    this.#traversalId = options.traversalId ?? (() => globalThis.crypto.randomUUID());
  }

  public async discoverCortexTree(input: DiscoverCortexTreeInput): Promise<CortexTreeDiscovery> {
    return discoverCortexTree(input, {
      source: this.#discoverySource(),
      traversalId: this.#traversalId,
    });
  }

  public async retrieveCortexPage(input: RetrieveCortexPageInput): Promise<CortexPageObservation | null> {
    try {
      if (!validTreeInput(input)) throw failure("invalid-response");
      await this.#assertInRoot(input.pageId, input.rootPageId);
      return await this.#retrieveCompletePage(input.pageId, input.rootPageId);
    } catch (caught) {
      const code = errorCode(caught);
      if (code === "not-found" || code === "authorization-failed") return null;
      throw caught;
    }
  }

  public async createCortexPage(input: CreateCortexPageInput): Promise<CortexPageObservation> {
    if (!validCreateInput(input)) throw failure("invalid-response");
    const parentMembership = await this.#assertInRoot(input.parentPageId, input.rootPageId);
    if (parentMembership.depth >= MAX_TREE_DEPTH) throw failure("revision-race");
    const parent = await this.#retrieveCompletePage(input.parentPageId, input.rootPageId);
    if (!parent.complete || parent.editedAt !== input.expectedParentEditedAt) throw failure("revision-race");
    const created = parseRegularPageMetadata(await this.#request.request<unknown>({
      method: "POST",
      path: "/v1/pages",
      body: {
        parent: { type: "page_id", page_id: input.parentPageId },
        properties: { title: titleProperty(input.title) },
        markdown: preserveLeadingH1(input.markdown),
      },
    }));
    const observed = await this.#retrieveCompletePage(created.pageId, input.rootPageId);
    await this.#assertObservationInRoot(observed, input.rootPageId);
    if (observed.parentPageId !== input.parentPageId || observed.title !== input.title) throw failure("revision-race");
    return observed;
  }

  public async updateCortexTitle(input: UpdateCortexTitleInput): Promise<CortexPageObservation> {
    if (!validTitleInput(input)) throw failure("invalid-response");
    await this.#assertInRoot(input.pageId, input.rootPageId);
    const current = await this.#retrieveCompletePage(input.pageId, input.rootPageId);
    if (!current.complete || current.editedAt !== input.observedEditedAt) throw failure("revision-race");
    parseRegularPageMetadata(await this.#request.request<unknown>({
      method: "PATCH",
      path: `/v1/pages/${input.pageId}`,
      body: { properties: { title: titleProperty(input.title) } },
    }), input.pageId);
    const observed = await this.#retrieveCompletePage(input.pageId, input.rootPageId);
    await this.#assertObservationInRoot(observed, input.rootPageId);
    if (observed.title !== input.title || observed.parentPageId !== current.parentPageId) throw failure("revision-race");
    return observed;
  }

  public async updateCortexBodyExact(input: UpdateCortexBodyExactInput): Promise<CortexPageObservation> {
    if (!validBodyInput(input)) throw failure("invalid-response");
    await this.#assertInRoot(input.pageId, input.rootPageId);
    const current = await this.#retrieveCompletePage(input.pageId, input.rootPageId);
    if (!current.complete || current.editedAt !== input.observedEditedAt) throw failure("revision-race");
    const oldMarkers = childPageMarkers(input.oldMarkdown);
    const newMarkers = childPageMarkers(input.newMarkdown);
    if (oldMarkers === null || newMarkers === null || !sameIds(oldMarkers, current.directChildPageIds) || !sameIds(newMarkers, current.directChildPageIds)) {
      throw failure("revision-race");
    }
    const oldMarkdown = stripChildPageMarkers(input.oldMarkdown);
    const newMarkdown = preserveLeadingH1(stripChildPageMarkers(input.newMarkdown));
    if (bodyMatchCount(current.sourceMarkdown, oldMarkdown) !== 1) throw failure("revision-race");
    if (current.sourceMarkdown.length === 0 && oldMarkdown.length === 0 && current.directChildPageIds.length > 0) {
      throw failure("revision-race");
    }
    const body = current.sourceMarkdown.length === 0 && oldMarkdown.length === 0
      ? { type: "replace_content", replace_content: { new_str: newMarkdown } }
      : { type: "update_content", update_content: { content_updates: [{ old_str: oldMarkdown, new_str: newMarkdown }] } };
    parseRegularPageMarkdown(await this.#request.request<unknown>({
      method: "PATCH",
      path: `/v1/pages/${input.pageId}/markdown`,
      body,
    }), input.pageId);
    const observed = await this.#retrieveCompletePage(input.pageId, input.rootPageId);
    await this.#assertObservationInRoot(observed, input.rootPageId);
    if (!observed.complete || !sameIds(observed.directChildPageIds, current.directChildPageIds)) throw failure("revision-race");
    return observed;
  }

  public async moveCortexPage(input: MoveCortexPageInput): Promise<CortexPageObservation> {
    if (!validMoveInput(input) || input.pageId === input.rootPageId || input.pageId === input.parentPageId) {
      throw failure("invalid-response");
    }
    await this.#assertInRoot(input.pageId, input.rootPageId);
    const parentMembership = await this.#assertInRoot(input.parentPageId, input.rootPageId, input.pageId);
    if (parentMembership.depth >= MAX_TREE_DEPTH) throw failure("revision-race");
    const current = await this.#retrieveCompletePage(input.pageId, input.rootPageId);
    if (!current.complete || current.editedAt !== input.observedEditedAt) throw failure("revision-race");
    await this.#assertSubtreeFitsAtDepth(current.pageId, current.directChildPageIds, parentMembership.depth + 1);
    parseRegularPageMetadata(await this.#request.request<unknown>({
      method: "POST",
      path: `/v1/pages/${input.pageId}/move`,
      body: { parent: { type: "page_id", page_id: input.parentPageId } },
    }), input.pageId);
    const observed = await this.#retrieveCompletePage(input.pageId, input.rootPageId);
    await this.#assertObservationInRoot(observed, input.rootPageId);
    if (observed.parentPageId !== input.parentPageId) throw failure("revision-race");
    return observed;
  }

  async #retrieveMetadata(pageId: string): Promise<RegularPageMetadata> {
    return parseRegularPageMetadata(await this.#request.request<unknown>({ method: "GET", path: `/v1/pages/${pageId}` }), pageId);
  }

  async #retrieveUnstructuredPage(pageId: string, rootPageId: string): Promise<CortexPageObservation> {
    const metadata = await this.#retrieveMetadata(pageId);
    const parentPageId = pageId === rootPageId ? null : metadata.parentPageId;
    if (pageId !== rootPageId && parentPageId === null) throw failure("invalid-response");
    const markdown = parseRegularPageMarkdown(await this.#request.request<unknown>({
      method: "GET",
      path: `/v1/pages/${pageId}/markdown`,
    }), pageId);
    return Object.freeze({
      pageId,
      parentPageId,
      rootPageId,
      title: metadata.title,
      sourceMarkdown: markdown.sourceMarkdown,
      directChildPageIds: Object.freeze([]),
      semanticHash: await cortexSemanticHash(markdown.sourceMarkdown),
      structureHash: await sha256Hex("[]"),
      editedAt: metadata.editedAt,
      complete: markdown.complete,
    });
  }

  async #retrieveCompletePage(pageId: string, rootPageId: string): Promise<CortexPageObservation> {
    const page = await this.#retrieveUnstructuredPage(pageId, rootPageId);
    const directChildPageIds = await collectCortexChildPageIds(this.#discoverySource(), pageId);
    return Object.freeze({
      ...page,
      directChildPageIds: Object.freeze([...directChildPageIds]),
      structureHash: await sha256Hex(JSON.stringify(directChildPageIds)),
    });
  }

  #discoverySource(): CortexDiscoverySource {
    return {
      retrieveCortexPage: async (pageId, rootPageId) => this.#retrieveUnstructuredPage(pageId, rootPageId),
      listBlockChildren: async (pageId, startCursor) => this.#request.request<unknown>({
        method: "GET",
        path: `/v1/blocks/${pageId}/children`,
        query: Object.freeze({ page_size: "100", ...(startCursor === undefined ? {} : { start_cursor: startCursor }) }),
      }),
    };
  }

  async #assertObservationInRoot(observed: CortexPageObservation, rootPageId: string): Promise<void> {
    if (observed.rootPageId !== rootPageId) throw failure("revision-race");
    const membership = await this.#assertInRoot(observed.pageId, rootPageId);
    if (
      membership.page !== null &&
      (membership.page.parentPageId !== observed.parentPageId || membership.page.editedAt !== observed.editedAt)
    ) {
      throw failure("revision-race");
    }
  }

  async #assertSubtreeFitsAtDepth(
    pageId: string,
    directChildPageIds: readonly string[],
    proposedPageDepth: number,
  ): Promise<void> {
    if (
      !isCanonicalUuid(pageId) ||
      !Array.isArray(directChildPageIds) ||
      !directChildPageIds.every(isCanonicalUuid) ||
      !Number.isSafeInteger(proposedPageDepth) ||
      proposedPageDepth < 0 ||
      proposedPageDepth > MAX_TREE_DEPTH
    ) {
      throw failure("invalid-response");
    }
    const visited = new Set<string>([pageId]);
    const visit = async (childPageIds: readonly string[], parentDepth: number): Promise<void> => {
      for (const childPageId of childPageIds) {
        if (visited.has(childPageId) || visited.size >= MAX_TREE_PAGES) throw failure("revision-race");
        const childDepth = parentDepth + 1;
        if (childDepth > MAX_TREE_DEPTH) throw failure("revision-race");
        visited.add(childPageId);
        let descendants: readonly string[];
        try {
          descendants = await collectCortexChildPageIds(this.#discoverySource(), childPageId);
        } catch {
          throw failure("revision-race");
        }
        await visit(descendants, childDepth);
      }
    };
    await visit(directChildPageIds, proposedPageDepth);
  }

  async #assertInRoot(pageId: string, rootPageId: string, forbiddenPageId?: string): Promise<RootMembership> {
    let currentPageId = pageId;
    let page: RegularPageMetadata | null = null;
    const seen = new Set<string>();
    for (let depth = 0; depth <= MAX_TREE_DEPTH; depth += 1) {
      if (currentPageId === rootPageId) return Object.freeze({ page, depth });
      if (currentPageId === forbiddenPageId || seen.has(currentPageId)) throw failure("revision-race");
      seen.add(currentPageId);
      const metadata = await this.#retrieveMetadata(currentPageId);
      if (page === null) page = metadata;
      if (metadata.parentPageId === null) throw failure("revision-race");
      currentPageId = metadata.parentPageId;
    }
    throw failure("revision-race");
  }
}
