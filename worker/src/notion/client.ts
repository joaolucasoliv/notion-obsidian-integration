import type {
  Clock,
  CreateNotePageInput,
  NotionApi,
  NotionObservation,
  PairStatus,
  SafeErrorCode,
  UpdateBodyExactInput,
  UpdateManagedPropertiesInput,
} from "@grandbox-bridge/shared";
import {
  NOTION_RESPONSE_MAX_BYTES,
  NotionTransportError,
  type NotionTransport,
  type NotionTransportResponse,
} from "./transport.js";

export const NOTION_API_VERSION = "2026-03-11";
export const NOTION_TIMEOUT_MS = 15_000;
export const NOTION_RETRY_AFTER_MAX_MS = 300_000;
export const NOTION_MAX_RETRY_DELAYS = 3;

const MAX_PAGE_URL_BYTES = 2_048;
const MAX_PLAIN_TEXT_BYTES = 2_000;
const MAX_TAG_BYTES = 100;
const MAX_TAGS = 100;
const MAX_UNKNOWN_BLOCK_IDS = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const STATUS_LABELS: Readonly<Record<PairStatus, string>> = Object.freeze({
  synced: "Synced",
  conflict: "Conflict",
  detached: "Detached",
  "missing-local": "Missing Local",
  "missing-notion": "Missing Notion",
  error: "Error",
});

const STATUS_BY_LABEL: Readonly<Record<string, PairStatus>> = Object.freeze(
  Object.fromEntries(Object.entries(STATUS_LABELS).map(([status, label]) => [label, status as PairStatus])),
);

export interface RawNotionPageRecord {
  readonly pageId: string;
  readonly pageUrl: string;
  readonly editedAt: string;
  readonly sourceMarkdown: string;
  readonly truncated: boolean;
  readonly unknownBlockIds: readonly string[];
  readonly bridgeId: string | null;
  readonly managed: Readonly<{
    title: string;
    obsidianPath: string;
    status: PairStatus;
    tags: readonly string[];
  }>;
}

export interface NotionObservationDecoder {
  decode(record: Readonly<RawNotionPageRecord>): Promise<NotionObservation>;
}

export interface NotionRetryJitter {
  delayMs(attempt: number): number;
}

export interface NotionClientOptions {
  readonly clock?: Clock;
  readonly jitter?: NotionRetryJitter;
}

export class NotionClientError extends Error {
  public constructor(
    public readonly code: SafeErrorCode,
    public readonly retryable: boolean,
  ) {
    super(`Notion client ${code}`);
    this.name = "NotionClientError";
  }
}

interface PageMetadata {
  readonly pageId: string;
  readonly pageUrl: string;
  readonly editedAt: string;
  readonly bridgeId: string | null;
  readonly managed: RawNotionPageRecord["managed"];
}

interface PageMarkdown {
  readonly pageId: string;
  readonly sourceMarkdown: string;
  readonly truncated: boolean;
  readonly unknownBlockIds: readonly string[];
}

function clientFailure(code: SafeErrorCode, retryable: boolean): NotionClientError {
  return new NotionClientError(code, retryable);
}

function safeClientCaught(caught: unknown): NotionClientError {
  if (caught instanceof NotionClientError) return caught;
  return clientFailure("invalid-response", false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isStrictInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isBoundedText(value: unknown, maximumBytes = MAX_PLAIN_TEXT_BYTES, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.trim() === value &&
    byteLength(value) <= maximumBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isSafeRelativePath(value: unknown): value is string {
  if (!isBoundedText(value, MAX_PLAIN_TEXT_BYTES) || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\"));
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

function isSafePageUrl(value: unknown, expectedPageId?: string): value is string {
  if (typeof value !== "string" || byteLength(value) > MAX_PAGE_URL_BYTES) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "notion.so" ||
        parsed.hostname.endsWith(".notion.so") ||
        parsed.hostname === "notion.site" ||
        parsed.hostname.endsWith(".notion.site")) &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.toString() === value &&
      (expectedPageId === undefined || urlPageId(value) === expectedPageId)
    );
  } catch {
    return false;
  }
}

function plainTextItem(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "text" || !isBoundedText(value.plain_text)) return null;
  if (value.text !== undefined) {
    if (!isRecord(value.text) || value.text.content !== value.plain_text) return null;
  }
  return value.plain_text;
}

function singleTextProperty(properties: Record<string, unknown>, name: string, kind: "title" | "rich_text"): string | null {
  const property = properties[name];
  if (!isRecord(property) || property.type !== kind || !Array.isArray(property[kind]) || property[kind].length !== 1) {
    return null;
  }
  return plainTextItem(property[kind][0]);
}

function bridgeIdProperty(properties: Record<string, unknown>): string | null | undefined {
  const property = properties["Bridge ID"];
  if (!isRecord(property) || property.type !== "rich_text" || !Array.isArray(property.rich_text)) return undefined;
  if (property.rich_text.length === 0) return null;
  if (property.rich_text.length !== 1) return undefined;
  const bridgeId = plainTextItem(property.rich_text[0]);
  return bridgeId !== null && isCanonicalUuid(bridgeId) ? bridgeId : undefined;
}

function tagsProperty(properties: Record<string, unknown>): readonly string[] | null {
  const property = properties.Tags;
  if (!isRecord(property) || property.type !== "multi_select" || !Array.isArray(property.multi_select)) return null;
  if (property.multi_select.length > MAX_TAGS) return null;
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of property.multi_select) {
    if (!isRecord(item) || !isBoundedText(item.name, MAX_TAG_BYTES) || seen.has(item.name)) return null;
    seen.add(item.name);
    tags.push(item.name);
  }
  return Object.freeze(tags);
}

function statusProperty(properties: Record<string, unknown>): PairStatus | null {
  const property = properties["Sync Status"];
  if (!isRecord(property) || property.type !== "select" || !isRecord(property.select) || typeof property.select.name !== "string") {
    return null;
  }
  return STATUS_BY_LABEL[property.select.name] ?? null;
}

function parsePageMetadata(value: unknown, expectedPageId?: string): PageMetadata {
  try {
    if (!isRecord(value) || value.object !== "page" || !isCanonicalUuid(value.id) || !isSafePageUrl(value.url, value.id) || !isStrictInstant(value.last_edited_time)) {
      throw clientFailure("invalid-response", false);
    }
    if (expectedPageId !== undefined && value.id !== expectedPageId) throw clientFailure("invalid-response", false);
    if (!isRecord(value.properties)) throw clientFailure("invalid-response", false);
    const title = singleTextProperty(value.properties, "Name", "title");
    const obsidianPath = singleTextProperty(value.properties, "Obsidian Path", "rich_text");
    const bridgeId = bridgeIdProperty(value.properties);
    const tags = tagsProperty(value.properties);
    const status = statusProperty(value.properties);
    if (title === null || obsidianPath === null || !isSafeRelativePath(obsidianPath) || bridgeId === undefined || tags === null || status === null) {
      throw clientFailure("invalid-response", false);
    }
    return Object.freeze({
      pageId: value.id,
      pageUrl: value.url,
      editedAt: value.last_edited_time,
      bridgeId,
      managed: Object.freeze({ title, obsidianPath, status, tags }),
    });
  } catch (caught) {
    throw safeClientCaught(caught);
  }
}

function parsePageMarkdown(value: unknown, expectedPageId: string): PageMarkdown {
  try {
    if (!isRecord(value) || value.object !== "page_markdown" || !isCanonicalUuid(value.id) || value.id !== expectedPageId) {
      throw clientFailure("invalid-response", false);
    }
    if (typeof value.markdown !== "string" || byteLength(value.markdown) > NOTION_RESPONSE_MAX_BYTES || typeof value.truncated !== "boolean") {
      throw clientFailure("invalid-response", false);
    }
    if (!Array.isArray(value.unknown_block_ids) || value.unknown_block_ids.length > MAX_UNKNOWN_BLOCK_IDS) {
      throw clientFailure("invalid-response", false);
    }
    const unknownBlockIds: string[] = [];
    const seen = new Set<string>();
    for (const unknownBlockId of value.unknown_block_ids) {
      if (!isCanonicalUuid(unknownBlockId) || seen.has(unknownBlockId)) throw clientFailure("invalid-response", false);
      seen.add(unknownBlockId);
      unknownBlockIds.push(unknownBlockId);
    }
    return Object.freeze({
      pageId: value.id,
      sourceMarkdown: value.markdown,
      truncated: value.truncated,
      unknownBlockIds: Object.freeze(unknownBlockIds),
    });
  } catch (caught) {
    throw safeClientCaught(caught);
  }
}

function rawRecord(metadata: PageMetadata, markdown: PageMarkdown): Readonly<RawNotionPageRecord> {
  return Object.freeze({
    pageId: metadata.pageId,
    pageUrl: metadata.pageUrl,
    editedAt: metadata.editedAt,
    sourceMarkdown: markdown.sourceMarkdown,
    truncated: markdown.truncated,
    unknownBlockIds: Object.freeze([...markdown.unknownBlockIds]),
    bridgeId: metadata.bridgeId,
    managed: Object.freeze({
      title: metadata.managed.title,
      obsidianPath: metadata.managed.obsidianPath,
      status: metadata.managed.status,
      tags: Object.freeze([...metadata.managed.tags]),
    }),
  });
}

function isDecodedObservation(value: unknown, source: Readonly<RawNotionPageRecord>): value is Extract<NotionObservation, { kind: "present" }> {
  if (!isRecord(value) || value.kind !== "present") return false;
  if (
    value.pageId !== source.pageId ||
    value.pageUrl !== source.pageUrl ||
    value.editedAt !== source.editedAt ||
    value.sourceMarkdown !== source.sourceMarkdown ||
    value.bridgeId !== source.bridgeId ||
    value.complete !== (!source.truncated && source.unknownBlockIds.length === 0)
  ) {
    return false;
  }
  if (!isRecord(value.managed) || value.managed.title !== source.managed.title || value.managed.obsidianPath !== source.managed.obsidianPath || value.managed.status !== source.managed.status) {
    return false;
  }
  if (!isRecord(value.semantic) || typeof value.semantic.bodyMarkdown !== "string" || !Array.isArray(value.semantic.tags)) return false;
  if (!value.semantic.tags.every((tag) => isBoundedText(tag, MAX_TAG_BYTES))) return false;
  return (
    typeof value.semanticHash === "string" &&
    HASH_PATTERN.test(value.semanticHash) &&
    Array.isArray(value.unsupportedKinds) &&
    value.unsupportedKinds.every((kind) => typeof kind === "string" && isBoundedText(kind, MAX_PLAIN_TEXT_BYTES))
  );
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

function validRetryAfter(headers: Readonly<Record<string, string>>): number | null {
  const values = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === "retry-after")
    .map(([, value]) => value);
  if (values.length !== 1 || !/^\d+$/u.test(values[0] ?? "")) return null;
  try {
    const seconds = BigInt(values[0] as string);
    if (seconds > 300n) return NOTION_RETRY_AFTER_MAX_MS;
    return Number(seconds) * 1_000;
  } catch {
    return null;
  }
}

function statusFailure(status: number): { readonly code: SafeErrorCode; readonly retryable: boolean } | null {
  if (status >= 200 && status < 300) return null;
  switch (status) {
    case 400:
      return { code: "invalid-response", retryable: false };
    case 401:
      return { code: "authentication-failed", retryable: false };
    case 403:
      return { code: "authorization-failed", retryable: false };
    case 404:
      return { code: "not-found", retryable: false };
    case 409:
      return { code: "revision-race", retryable: false };
    case 429:
      return { code: "rate-limited", retryable: true };
    case 502:
    case 503:
    case 504:
    case 529:
      return { code: "network-failed", retryable: true };
    default:
      return { code: "network-failed", retryable: false };
  }
}

function transportFailure(caught: unknown): { readonly code: SafeErrorCode; readonly retryable: boolean } {
  if (caught instanceof NotionTransportError) return { code: caught.code, retryable: caught.retryable };
  return { code: "network-failed", retryable: true };
}

function validTransportResponse(value: unknown): value is NotionTransportResponse<unknown> {
  return (
    isRecord(value) &&
    typeof value.status === "number" &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599 &&
    isRecord(value.headers) &&
    Object.entries(value.headers).every(([name, headerValue]) => typeof name === "string" && typeof headerValue === "string") &&
    "data" in value
  );
}

function defaultClock(): Clock {
  return {
    now: () => new Date(),
    sleep: async (milliseconds) => {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    },
  };
}

function defaultJitter(): NotionRetryJitter {
  return {
    delayMs: (attempt) => Math.min(NOTION_RETRY_AFTER_MAX_MS, 1_000 * 2 ** (attempt - 1)),
  };
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !/[\r\n\u0000]/u.test(value);
}

function validCreateInput(value: unknown): value is CreateNotePageInput {
  return (
    isRecord(value) &&
    isCanonicalUuid(value.parentPageId) &&
    isCanonicalUuid(value.dataSourceId) &&
    isCanonicalUuid(value.bridgeId) &&
    isBoundedText(value.title) &&
    isSafeRelativePath(value.obsidianPath) &&
    Array.isArray(value.tags) &&
    value.tags.length <= MAX_TAGS &&
    value.tags.every((tag) => isBoundedText(tag, MAX_TAG_BYTES)) &&
    new Set(value.tags).size === value.tags.length &&
    typeof value.markdown === "string"
  );
}

function validBodyUpdateInput(value: unknown): value is UpdateBodyExactInput {
  return (
    isRecord(value) &&
    isCanonicalUuid(value.pageId) &&
    typeof value.oldMarkdown === "string" &&
    typeof value.newMarkdown === "string" &&
    isStrictInstant(value.observedEditedAt)
  );
}

function validPropertiesUpdateInput(value: unknown): value is UpdateManagedPropertiesInput {
  return (
    isRecord(value) &&
    isCanonicalUuid(value.pageId) &&
    isBoundedText(value.title) &&
    isSafeRelativePath(value.obsidianPath) &&
    Array.isArray(value.tags) &&
    value.tags.length <= MAX_TAGS &&
    value.tags.every((tag) => isBoundedText(tag, MAX_TAG_BYTES)) &&
    new Set(value.tags).size === value.tags.length &&
    typeof value.status === "string" &&
    value.status in STATUS_LABELS &&
    isStrictInstant(value.observedEditedAt)
  );
}

function textProperty(kind: "title" | "rich_text", content: string): Record<string, unknown> {
  return { [kind]: [{ type: "text", text: { content } }] };
}

function managedProperties(input: {
  readonly title: string;
  readonly obsidianPath: string;
  readonly tags: readonly string[];
  readonly status: PairStatus;
  readonly bridgeId?: string;
}): Record<string, unknown> {
  return {
    Name: textProperty("title", input.title),
    ...(input.bridgeId === undefined ? {} : { "Bridge ID": textProperty("rich_text", input.bridgeId) }),
    "Obsidian Path": textProperty("rich_text", input.obsidianPath),
    Tags: { multi_select: input.tags.map((name) => ({ name })) },
    "Sync Status": { select: { name: STATUS_LABELS[input.status] } },
  };
}

export class NotionClient implements NotionApi {
  readonly #token: string;
  readonly #transport: NotionTransport;
  readonly #decoder: NotionObservationDecoder;
  readonly #clock: Clock;
  readonly #jitter: NotionRetryJitter;

  public constructor(
    token: string,
    transport: NotionTransport,
    decoder: NotionObservationDecoder,
    options: NotionClientOptions = {},
  ) {
    if (!validToken(token)) throw clientFailure("credential-unavailable", false);
    if (transport === null || typeof transport !== "object" || typeof transport.request !== "function") {
      throw clientFailure("invalid-config", false);
    }
    if (decoder === null || typeof decoder !== "object" || typeof decoder.decode !== "function") {
      throw clientFailure("invalid-config", false);
    }
    if (options.clock !== undefined && (typeof options.clock.now !== "function" || typeof options.clock.sleep !== "function")) {
      throw clientFailure("invalid-config", false);
    }
    if (options.jitter !== undefined && typeof options.jitter.delayMs !== "function") {
      throw clientFailure("invalid-config", false);
    }
    this.#token = token;
    this.#transport = transport;
    this.#decoder = decoder;
    this.#clock = options.clock ?? defaultClock();
    this.#jitter = options.jitter ?? defaultJitter();
  }

  public async verifyConnection(): Promise<{ userId: string; name: string | null }> {
    try {
      const value = await this.#request<unknown>("GET", "/v1/users/me");
      if (!isRecord(value) || value.object !== "user" || !isCanonicalUuid(value.id) || !(value.name === null || isBoundedText(value.name, MAX_PLAIN_TEXT_BYTES, true))) {
        throw clientFailure("invalid-response", false);
      }
      return Object.freeze({ userId: value.id, name: value.name });
    } catch (caught) {
      throw safeClientCaught(caught);
    }
  }

  public async retrievePage(pageId: string): Promise<NotionObservation> {
    try {
      if (!isCanonicalUuid(pageId)) throw clientFailure("invalid-response", false);
      return await this.#decode(await this.#retrieveRaw(pageId));
    } catch (caught) {
      throw safeClientCaught(caught);
    }
  }

  public async createNotePage(input: CreateNotePageInput): Promise<NotionObservation> {
    try {
      if (!validCreateInput(input)) throw clientFailure("invalid-response", false);
      const created = await this.#request<unknown>("POST", "/v1/pages", {
        parent: { type: "data_source_id", data_source_id: input.dataSourceId },
        properties: managedProperties({
          title: input.title,
          obsidianPath: input.obsidianPath,
          tags: input.tags,
          status: "synced",
          bridgeId: input.bridgeId,
        }),
        markdown: input.markdown,
      });
      const metadata = parsePageMetadata(created);
      return await this.retrievePage(metadata.pageId);
    } catch (caught) {
      throw safeClientCaught(caught);
    }
  }

  public async updateBodyExact(input: UpdateBodyExactInput): Promise<NotionObservation> {
    try {
      if (!validBodyUpdateInput(input)) throw clientFailure("invalid-response", false);
      const observed = await this.#retrieveRaw(input.pageId);
      if (observed.editedAt !== input.observedEditedAt) throw clientFailure("revision-race", false);
      const matches = bodyMatchCount(observed.sourceMarkdown, input.oldMarkdown);
      if (matches !== 1) throw clientFailure("revision-race", false);
      const body = observed.sourceMarkdown.length === 0 && input.oldMarkdown.length === 0
        ? { type: "replace_content", replace_content: { new_str: input.newMarkdown } }
        : {
            type: "update_content",
            update_content: { content_updates: [{ old_str: input.oldMarkdown, new_str: input.newMarkdown }] },
          };
      const updated = await this.#request<unknown>("PATCH", `/v1/pages/${input.pageId}/markdown`, body);
      parsePageMarkdown(updated, input.pageId);
      return await this.retrievePage(input.pageId);
    } catch (caught) {
      throw safeClientCaught(caught);
    }
  }

  public async updateManagedProperties(input: UpdateManagedPropertiesInput): Promise<NotionObservation> {
    try {
      if (!validPropertiesUpdateInput(input)) throw clientFailure("invalid-response", false);
      const observed = await this.#retrieveMetadata(input.pageId);
      if (observed.editedAt !== input.observedEditedAt) throw clientFailure("revision-race", false);
      const updated = await this.#request<unknown>("PATCH", `/v1/pages/${input.pageId}`, {
        properties: managedProperties({
          title: input.title,
          obsidianPath: input.obsidianPath,
          tags: input.tags,
          status: input.status,
        }),
      });
      parsePageMetadata(updated, input.pageId);
      return await this.retrievePage(input.pageId);
    } catch (caught) {
      throw safeClientCaught(caught);
    }
  }

  async #retrieveMetadata(pageId: string): Promise<PageMetadata> {
    const value = await this.#request<unknown>("GET", `/v1/pages/${pageId}`);
    return parsePageMetadata(value, pageId);
  }

  async #retrieveRaw(pageId: string): Promise<Readonly<RawNotionPageRecord>> {
    const metadata = await this.#retrieveMetadata(pageId);
    const markdown = await this.#request<unknown>("GET", `/v1/pages/${pageId}/markdown`);
    return rawRecord(metadata, parsePageMarkdown(markdown, pageId));
  }

  async #decode(source: Readonly<RawNotionPageRecord>): Promise<NotionObservation> {
    let decoded: NotionObservation;
    try {
      decoded = await this.#decoder.decode(source);
    } catch {
      throw clientFailure("invalid-response", false);
    }
    if (!isDecodedObservation(decoded, source)) throw clientFailure("invalid-response", false);
    return decoded;
  }

  async #request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    let retryAttempt = 0;
    while (true) {
      let result: NotionTransportResponse<unknown>;
      try {
        result = await this.#transport.request<unknown>({
          method,
          path,
          headers: Object.freeze({
            Authorization: `Bearer ${this.#token}`,
            Accept: "application/json",
            "Notion-Version": NOTION_API_VERSION,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          }),
          ...(body === undefined ? {} : { body }),
          timeoutMs: NOTION_TIMEOUT_MS,
          maxBytes: NOTION_RESPONSE_MAX_BYTES,
        });
      } catch (caught) {
        const failure = transportFailure(caught);
        if (!failure.retryable || retryAttempt >= NOTION_MAX_RETRY_DELAYS) {
          throw clientFailure(failure.code, failure.retryable);
        }
        retryAttempt += 1;
        await this.#delay(retryAttempt, undefined);
        continue;
      }

      if (!validTransportResponse(result)) throw clientFailure("invalid-response", false);
      const failure = statusFailure(result.status);
      if (failure === null) return result.data as T;
      if (!failure.retryable || retryAttempt >= NOTION_MAX_RETRY_DELAYS) {
        throw clientFailure(failure.code, failure.retryable);
      }
      retryAttempt += 1;
      await this.#delay(retryAttempt, result.headers);
    }
  }

  async #delay(attempt: number, headers: Readonly<Record<string, string>> | undefined): Promise<void> {
    let delay = headers === undefined ? null : validRetryAfter(headers);
    if (delay === null) {
      try {
        delay = this.#jitter.delayMs(attempt);
      } catch {
        throw clientFailure("invalid-config", false);
      }
      if (!Number.isSafeInteger(delay) || delay < 0 || delay > NOTION_RETRY_AFTER_MAX_MS) {
        throw clientFailure("invalid-config", false);
      }
    }
    try {
      await this.#clock.sleep(delay);
    } catch {
      throw clientFailure("network-failed", true);
    }
  }
}
