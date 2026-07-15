import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalVaultRoot,
  type CanonicalVaultRoot,
} from "../../worker/src/vault/safety.js";
import {
  GrandboxBridgeWorker,
  type BridgeWorker,
  type WorkerDependencies,
  type WorkerRunInput,
} from "../../worker/src/worker.js";
import type {
  BridgeConfigV1,
  BridgeRunSummary,
  BridgeStateV1,
  Clock,
  CredentialStore,
  JournalCompletionV1,
  JournalIntentV1,
  NotionApi,
  NotionObservation,
  PairStatus,
  SafeLogger,
  UuidSource,
} from "@grandbox-bridge/shared";
import { fromNotionMarkdown } from "../../worker/src/markdown/notion-mapping.js";
import { semanticHash } from "../../worker/src/markdown/normalize.js";
import type { ConfigStore } from "../../worker/src/persistence/config-store.js";
import type { JournalStore } from "../../worker/src/persistence/journal-store.js";
import type { StateStore } from "../../worker/src/persistence/state-store.js";

export const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
export const FIRST_PAGE_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_UUID = "33333333-3333-4333-8333-333333333333";
const SECOND_UUID = "44444444-4444-4444-8444-444444444444";
const THIRD_UUID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-07-14T12:34:56.000Z";

function initialState(): BridgeStateV1 {
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    pairs: {},
    graph: null,
    lastFullReconciliationAt: null,
    lastRun: null,
  };
}

class FixedClock implements Clock {
  public now(): Date {
    return new Date(NOW);
  }

  public async sleep(): Promise<void> {}
}

class MemoryConfigStore implements ConfigStore {
  public constructor(private readonly value: BridgeConfigV1) {}

  public async load(): Promise<BridgeConfigV1> {
    return structuredClone(this.value);
  }

  public async save(): Promise<void> {
    throw new Error("configuration must not be written by the worker");
  }
}

class MemoryStateStore implements StateStore {
  public saves = 0;

  public constructor(
    public value: BridgeStateV1,
    private remainingFailures = 0,
  ) {}

  public async load(): Promise<BridgeStateV1> {
    return structuredClone(this.value);
  }

  public async save(next: BridgeStateV1): Promise<void> {
    this.saves += 1;
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("synthetic state persistence failure");
    }
    this.value = structuredClone(next);
  }
}

export class MemoryJournal implements JournalStore {
  public readonly begun: JournalIntentV1[] = [];
  public readonly completed: Array<{ readonly id: string; readonly evidence: JournalCompletionV1 }> = [];

  public async begin(intent: JournalIntentV1): Promise<void> {
    this.begun.push(structuredClone(intent));
  }

  public async complete(id: string, evidence: JournalCompletionV1): Promise<void> {
    this.completed.push({ id, evidence: structuredClone(evidence) });
  }

  public async incomplete(): Promise<readonly JournalIntentV1[]> {
    const completeIds = new Set(this.completed.map((entry) => entry.id));
    return this.begun.filter((intent) => !completeIds.has(intent.id)).map((intent) => structuredClone(intent));
  }
}

class MemoryCredentials implements CredentialStore {
  public getCalls = 0;

  public constructor(private readonly token: string | null = "ntn_synthetic_token") {}

  public async get(): Promise<string | null> {
    this.getCalls += 1;
    return this.token;
  }

  public async set(): Promise<void> {}

  public async delete(): Promise<void> {}
}

class CountingUuidSource implements UuidSource {
  public calls = 0;
  private readonly values = [FIRST_UUID, SECOND_UUID, THIRD_UUID, randomUUID()];

  public randomUUID(): string {
    const value = this.values[this.calls] ?? randomUUID();
    this.calls += 1;
    return value;
  }
}

class RecordingLogger implements SafeLogger {
  public readonly entries: unknown[] = [];

  public write(entry: Parameters<SafeLogger["write"]>[0]): void {
    this.entries.push(entry);
  }
}

interface StoredPage {
  readonly pageId: string;
  bridgeId: string;
  sourceMarkdown: string;
  semantic: NotionObservation["semantic"];
  semanticHash: string;
  title: string;
  obsidianPath: string;
  tags: string[];
  status: PairStatus;
  editedAt: string;
}

export class FakeNotionApi implements NotionApi {
  public verifies = 0;
  public creates = 0;
  public bodyUpdates = 0;
  public propertyUpdates = 0;
  public verifyFails = false;
  public corruptCreateBridgeResult = false;
  public corruptBodyResult = false;
  public corruptManagedStatusResult = false;
  private readonly pages = new Map<string, StoredPage>();

  public async verifyConnection(): Promise<{ userId: string; name: string | null }> {
    this.verifies += 1;
    if (this.verifyFails) {
      throw Object.assign(new Error("synthetic provider failure"), { code: "authentication-failed", retryable: false });
    }
    return { userId: "66666666-6666-4666-8666-666666666666", name: "Synthetic" };
  }

  public async retrievePage(pageId: string): Promise<NotionObservation> {
    const page = this.pages.get(pageId);
    if (page === undefined) {
      const error = Object.assign(new Error("not found"), { code: "not-found", retryable: false });
      throw error;
    }
    return this.observe(page);
  }

  public async createNotePage(input: Parameters<NotionApi["createNotePage"]>[0]): Promise<NotionObservation> {
    this.creates += 1;
    const pageId = this.pages.size === 0
      ? FIRST_PAGE_ID
      : `${String(this.pages.size + 2).padStart(8, "0")}-2222-4222-8222-222222222222`;
    const mapped = fromNotionMarkdown(input.markdown, emptyLinks(), input.tags);
    const page: StoredPage = {
      pageId,
      bridgeId: input.bridgeId,
      sourceMarkdown: input.markdown,
      semantic: mapped.semantic,
      semanticHash: await semanticHash(mapped.semantic),
      title: input.title,
      obsidianPath: input.obsidianPath,
      tags: [...input.tags],
      status: "synced",
      editedAt: NOW,
    };
    this.pages.set(pageId, page);
    const observed = this.observe(page);
    if (this.corruptCreateBridgeResult && observed.kind === "present") {
      return { ...observed, bridgeId: THIRD_UUID };
    }
    return observed;
  }

  public async updateBodyExact(input: Parameters<NotionApi["updateBodyExact"]>[0]): Promise<NotionObservation> {
    const page = this.requirePage(input.pageId);
    if (page.editedAt !== input.observedEditedAt || page.sourceMarkdown !== input.oldMarkdown) {
      throw Object.assign(new Error("revision race"), { code: "revision-race", retryable: false });
    }
    const mapped = fromNotionMarkdown(input.newMarkdown, emptyLinks(), page.tags);
    page.sourceMarkdown = input.newMarkdown;
    page.semantic = mapped.semantic;
    page.semanticHash = await semanticHash(mapped.semantic);
    page.editedAt = "2026-07-14T12:34:57.000Z";
    this.bodyUpdates += 1;
    const observed = this.observe(page);
    if (this.corruptBodyResult && observed.kind === "present") {
      return {
        ...observed,
        semantic: { ...observed.semantic, bodyMarkdown: "synthetic incorrect body\n" },
      };
    }
    return observed;
  }

  public async updateManagedProperties(input: Parameters<NotionApi["updateManagedProperties"]>[0]): Promise<NotionObservation> {
    const page = this.requirePage(input.pageId);
    if (page.editedAt !== input.observedEditedAt) {
      throw Object.assign(new Error("revision race"), { code: "revision-race", retryable: false });
    }
    page.title = input.title;
    page.obsidianPath = input.obsidianPath;
    page.tags = [...input.tags];
    page.status = input.status;
    page.semantic = { ...page.semantic, tags: [...input.tags] };
    page.semanticHash = await semanticHash(page.semantic);
    page.editedAt = "2026-07-14T12:34:57.000Z";
    this.propertyUpdates += 1;
    const observed = this.observe(page);
    if (this.corruptManagedStatusResult && observed.kind === "present") {
      return { ...observed, managed: { ...observed.managed, status: "synced" } };
    }
    return observed;
  }

  public async editBody(pageId: string, body: string): Promise<void> {
    const page = this.requirePage(pageId);
    const mapped = fromNotionMarkdown(body, emptyLinks(), page.tags);
    page.sourceMarkdown = body;
    page.semantic = mapped.semantic;
    page.semanticHash = await semanticHash(mapped.semantic);
    page.editedAt = "2026-07-14T12:35:00.000Z";
  }

  public removePage(pageId: string): void {
    this.pages.delete(pageId);
  }

  public snapshot(): string {
    return JSON.stringify([...this.pages.entries()]);
  }

  private observe(page: StoredPage): NotionObservation {
    return {
      kind: "present",
      pageId: page.pageId,
      bridgeId: page.bridgeId,
      editedAt: page.editedAt,
      pageUrl: `https://www.notion.so/Synthetic-${page.pageId.replaceAll("-", "")}`,
      sourceMarkdown: page.sourceMarkdown,
      complete: true,
      unsupportedKinds: [],
      semantic: page.semantic,
      semanticHash: page.semanticHash,
      managed: { title: page.title, obsidianPath: page.obsidianPath, status: page.status },
    };
  }

  private requirePage(pageId: string): StoredPage {
    const page = this.pages.get(pageId);
    if (page === undefined) throw Object.assign(new Error("not found"), { code: "not-found", retryable: false });
    return page;
  }
}

function emptyLinks() {
  return { byLocalTarget: new Map(), byNotionPageId: new Map() };
}

export class BridgeHarness {
  public readonly journal = new MemoryJournal();
  public readonly notion = new FakeNotionApi();
  public readonly state: MemoryStateStore;
  public readonly uuid = new CountingUuidSource();
  public readonly logger = new RecordingLogger();
  public readonly credentials: MemoryCredentials;
  public readonly worker: BridgeWorker;
  private constructor(
    public readonly root: CanonicalVaultRoot,
    credentials: MemoryCredentials,
    options: Readonly<{
      vaultFingerprintMismatch?: boolean;
      lockFails?: boolean;
      verifyFails?: boolean;
      stateSaveFailures?: number;
      corruptCreateBridgeResult?: boolean;
      corruptBodyResult?: boolean;
      corruptManagedStatusResult?: boolean;
    }>,
  ) {
    this.state = new MemoryStateStore(initialState(), options.stateSaveFailures ?? 0);
    this.credentials = credentials;
    this.notion.verifyFails = options.verifyFails === true;
    this.notion.corruptCreateBridgeResult = options.corruptCreateBridgeResult === true;
    this.notion.corruptBodyResult = options.corruptBodyResult === true;
    this.notion.corruptManagedStatusResult = options.corruptManagedStatusResult === true;
    const config: BridgeConfigV1 = {
      schemaVersion: 1,
      installationId: INSTALLATION_ID,
      vaultRoot: root.canonicalRealPath,
      vaultFingerprint: root.vaultFingerprint,
      notion: {
        parentPageId: "77777777-7777-4777-8777-777777777777",
        dashboardPageId: "88888888-8888-4888-8888-888888888888",
        databaseId: "99999999-9999-4999-8999-999999999999",
        dataSourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      relay: null,
      graph: null,
    };
    const dependencies: WorkerDependencies = {
      config: new MemoryConfigStore(config),
      state: this.state,
      credentials,
      journal: this.journal,
      lock: {
        runExclusive: async <T>(operation: () => Promise<T>) => {
          if (options.lockFails === true) {
            throw Object.assign(new Error("synthetic lock failure"), { code: "active-lock", retryable: true });
          }
          return operation();
        },
      },
      clock: new FixedClock(),
      uuid: this.uuid,
      logger: this.logger,
      canonicalizeVault: async () => options.vaultFingerprintMismatch === true
        ? { ...root, vaultFingerprint: "f".repeat(64) }
        : root,
      createNotionApi: async () => this.notion,
    };
    this.worker = new GrandboxBridgeWorker(dependencies);
  }

  public static async create(
    options: Readonly<{
      credential?: string | null;
      vaultFingerprintMismatch?: boolean;
      lockFails?: boolean;
      verifyFails?: boolean;
      stateSaveFailures?: number;
      corruptCreateBridgeResult?: boolean;
      corruptBodyResult?: boolean;
      corruptManagedStatusResult?: boolean;
    }> = {},
  ): Promise<BridgeHarness> {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "grandbox-task8-")));
    const root = await canonicalVaultRoot(directory, INSTALLATION_ID, { mode: "bootstrap" });
    return new BridgeHarness(root, new MemoryCredentials(options.credential), options);
  }

  public async writeNote(path: string, bytes: string): Promise<void> {
    const target = join(this.root.canonicalRealPath, path);
    await writeFile(target, bytes, { encoding: "utf8" });
  }

  public async note(path: string): Promise<string> {
    return readFile(join(this.root.canonicalRealPath, path), "utf8");
  }

  public async apply(reason: WorkerRunInput["reason"] = "manual"): Promise<BridgeRunSummary> {
    return this.worker.run({ mode: "apply", reason });
  }

  public async preview(reason: WorkerRunInput["reason"] = "manual"): Promise<BridgeRunSummary> {
    return this.worker.run({ mode: "preview", reason });
  }

  public async remoteBodyFor(path: string, body: string): Promise<void> {
    const pair = Object.values(this.state.value.pairs).find((candidate) => candidate.localPath === path);
    if (pair === undefined) throw new Error("missing synthetic pair");
    await this.notion.editBody(pair.notionPageId, body);
  }

  public removeRemoteFor(path: string): void {
    const pair = Object.values(this.state.value.pairs).find((candidate) => candidate.localPath === path);
    if (pair === undefined) throw new Error("missing synthetic pair");
    this.notion.removePage(pair.notionPageId);
  }
}

export function optedIn(body: string, tags: readonly string[] = ["project"]): string {
  return `---\nnotion_sync: true\ntags: [${tags.join(", ")}]\n---\n${body}`;
}
