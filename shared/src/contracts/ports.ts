import type { NotionObservation } from "./planning.ts";
import type { PairStatus } from "./core.ts";
import type { CortexPageObservation, CortexTreeDiscovery } from "./cortex.ts";
import type { SafeLogEntry } from "../errors.ts";

export type CredentialSlot = "notion-token" | "relay-token" | "relay-token-pending" | "graph-key";

export interface CredentialStore {
  get(slot: CredentialSlot): Promise<string | null>;
  set(slot: CredentialSlot, value: string): Promise<void>;
  delete(slot: CredentialSlot): Promise<void>;
}

export interface CreateNotePageInput {
  readonly parentPageId: string;
  readonly dataSourceId: string;
  readonly bridgeId: string;
  readonly title: string;
  readonly obsidianPath: string;
  readonly tags: readonly string[];
  readonly markdown: string;
}

export interface UpdateBodyExactInput {
  readonly pageId: string;
  readonly oldMarkdown: string;
  readonly newMarkdown: string;
  readonly observedEditedAt: string;
}

export interface UpdateManagedPropertiesInput {
  readonly pageId: string;
  readonly title: string;
  readonly obsidianPath: string;
  readonly tags: readonly string[];
  readonly status: PairStatus;
  readonly observedEditedAt: string;
}

export interface DiscoverCortexTreeInput {
  readonly rootPageId: string;
  readonly maxDepth: number;
  readonly maxPages: number;
}

export interface CreateCortexPageInput {
  readonly rootPageId: string;
  readonly parentPageId: string;
  readonly title: string;
  readonly markdown: string;
  readonly expectedParentEditedAt: string;
}

export interface UpdateCortexBodyExactInput {
  readonly rootPageId: string;
  readonly pageId: string;
  readonly oldMarkdown: string;
  readonly newMarkdown: string;
  readonly observedEditedAt: string;
}

export interface UpdateCortexTitleInput {
  readonly rootPageId: string;
  readonly pageId: string;
  readonly title: string;
  readonly observedEditedAt: string;
}

export interface MoveCortexPageInput {
  readonly rootPageId: string;
  readonly pageId: string;
  readonly parentPageId: string;
  readonly observedEditedAt: string;
}

export interface RetrieveCortexPageInput {
  readonly rootPageId: string;
  readonly pageId: string;
}

/**
 * Regular-page API for the independently configured Cortex root. This never
 * assumes the managed Grandbox Notes data-source properties used by NotionApi.
 */
export interface CortexTreeNotionApi {
  discoverCortexTree(input: DiscoverCortexTreeInput): Promise<CortexTreeDiscovery>;
  createCortexPage(input: CreateCortexPageInput): Promise<CortexPageObservation>;
  updateCortexBodyExact(input: UpdateCortexBodyExactInput): Promise<CortexPageObservation>;
  updateCortexTitle(input: UpdateCortexTitleInput): Promise<CortexPageObservation>;
  moveCortexPage(input: MoveCortexPageInput): Promise<CortexPageObservation>;
  retrieveCortexPage(input: RetrieveCortexPageInput): Promise<CortexPageObservation | null>;
}

export interface NotionApi {
  verifyConnection(): Promise<{ userId: string; name: string | null }>;
  /** Resolves a page or nested block identity without requesting page Markdown. */
  resolveEventPage(entityId: string, maxParentHops: number): Promise<string | null>;
  retrievePage(pageId: string): Promise<NotionObservation>;
  createNotePage(input: CreateNotePageInput): Promise<NotionObservation>;
  updateBodyExact(input: UpdateBodyExactInput): Promise<NotionObservation>;
  updateManagedProperties(input: UpdateManagedPropertiesInput): Promise<NotionObservation>;
  /** Optional regular-page capability; direct-pair methods above remain unchanged. */
  readonly cortexTree?: CortexTreeNotionApi;
}

export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface UuidSource {
  randomUUID(): string;
}

export interface SafeLogger {
  write(entry: SafeLogEntry): void;
}
