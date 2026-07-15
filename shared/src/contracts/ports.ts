import type { NotionObservation } from "./planning.ts";
import type { PairStatus } from "./core.ts";
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

export interface NotionApi {
  verifyConnection(): Promise<{ userId: string; name: string | null }>;
  /** Resolves a page or nested block identity without requesting page Markdown. */
  resolveEventPage(entityId: string, maxParentHops: number): Promise<string | null>;
  retrievePage(pageId: string): Promise<NotionObservation>;
  createNotePage(input: CreateNotePageInput): Promise<NotionObservation>;
  updateBodyExact(input: UpdateBodyExactInput): Promise<NotionObservation>;
  updateManagedProperties(input: UpdateManagedPropertiesInput): Promise<NotionObservation>;
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
