import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import {
  parseJournalCompletion,
  parseJournalIntent,
  type JournalCompletionV1,
  type JournalIntentV1,
} from "@grandbox-bridge/shared";
import { readStrictJson } from "../runtime/atomic-json.js";
import { assertCanonicalRuntimePath, assertValidInstallationId } from "../runtime/paths.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_JOURNAL_OPERATION_IDS = 1_024;
const MAX_JOURNAL_AUDIT_ROWS = MAX_JOURNAL_OPERATION_IDS * 2;
const MAX_JOURNAL_JSON_BYTES = 64 * 1_024;
const JOURNAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTENT_FILE_PATTERN = /^intent-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const COMPLETION_FILE_PATTERN = /^completion-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;

export interface JournalStore {
  begin(intent: JournalIntentV1): Promise<void>;
  complete(id: string, evidence: JournalCompletionV1): Promise<void>;
  incomplete(): Promise<readonly JournalIntentV1[]>;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface JournalSnapshot {
  readonly intents: ReadonlyMap<string, JournalIntentV1>;
  readonly completions: ReadonlySet<string>;
}

function journalStoreError(): Error {
  return new Error("Journal store failed");
}

function isSameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertJournalId(id: string): void {
  if (!JOURNAL_ID_PATTERN.test(id)) {
    throw journalStoreError();
  }
}

function assertJournalDirectorySyntax(journalDir: string): void {
  if (!isAbsolute(journalDir) || journalDir.includes("\0") || normalize(journalDir) !== journalDir) {
    throw journalStoreError();
  }
}

function intentFilename(id: string): string {
  assertJournalId(id);
  return `intent-${id}.json`;
}

function completionFilename(id: string): string {
  assertJournalId(id);
  return `completion-${id}.json`;
}

function exactIntentSnapshot(intent: JournalIntentV1): Record<string, unknown> {
  const value = Object.create(null) as Record<string, unknown>;
  value.schemaVersion = intent.schemaVersion;
  value.id = intent.id;
  value.installationId = intent.installationId;
  value.effectKind = intent.effectKind;
  value.relativePath = intent.relativePath;
  value.remoteId = intent.remoteId;
  value.allocationId = intent.allocationId;
  value.expectedByteHash = intent.expectedByteHash;
  value.expectedSemanticHash = intent.expectedSemanticHash;
  value.resultByteHash = intent.resultByteHash;
  value.resultSemanticHash = intent.resultSemanticHash;
  value.expectedRemoteEditedAt = intent.expectedRemoteEditedAt;
  value.createdAt = intent.createdAt;
  return value;
}

function exactCompletionSnapshot(completion: JournalCompletionV1): Record<string, unknown> {
  const value = Object.create(null) as Record<string, unknown>;
  value.schemaVersion = completion.schemaVersion;
  value.resultByteHash = completion.resultByteHash;
  value.resultSemanticHash = completion.resultSemanticHash;
  value.resultRemoteId = completion.resultRemoteId;
  value.allocatedBridgeId = completion.allocatedBridgeId;
  value.observedRemoteEditedAt = completion.observedRemoteEditedAt;
  value.completedAt = completion.completedAt;
  return value;
}

function serializeRecord(value: Record<string, unknown>): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_JOURNAL_JSON_BYTES) {
    throw journalStoreError();
  }
  return `${serialized}\n`;
}

export class FileJournalStore implements JournalStore {
  /**
   * Serializes journal mutations in this process for a journal directory
   * through the capacity decision and link-based exclusive finalization. A
   * filesystem-only read/count/write cannot reserve capacity between processes,
   * so Task 8's outer runtime lock must cover journal mutations when workers are shared.
   */
  private static readonly mutationTails = new Map<string, Promise<void>>();

  public constructor(
    private readonly journalDir: string,
    private readonly installationId: string,
  ) {
    try {
      assertJournalDirectorySyntax(journalDir);
      assertValidInstallationId(installationId);
    } catch {
      throw journalStoreError();
    }
  }

  public async begin(intent: JournalIntentV1): Promise<void> {
    try {
      const parsed = parseJournalIntent(intent);
      this.assertBoundIntent(parsed);
      await this.serializeMutation(async () => {
        const snapshot = await this.readSnapshot();
        if (snapshot.intents.size >= MAX_JOURNAL_OPERATION_IDS || snapshot.intents.has(parsed.id)) {
          throw journalStoreError();
        }
        await this.ensurePrivateJournalDirectory();
        await this.writeExclusive(intentFilename(parsed.id), serializeRecord(exactIntentSnapshot(parsed)));
      });
    } catch {
      throw journalStoreError();
    }
  }

  public async complete(id: string, evidence: JournalCompletionV1): Promise<void> {
    try {
      assertJournalId(id);
      const parsed = parseJournalCompletion(evidence);
      await this.serializeMutation(async () => {
        const snapshot = await this.readSnapshot();
        if (!snapshot.intents.has(id) || snapshot.completions.has(id)) {
          throw journalStoreError();
        }
        await this.ensurePrivateJournalDirectory();
        await this.writeExclusive(completionFilename(id), serializeRecord(exactCompletionSnapshot(parsed)));
      });
    } catch {
      throw journalStoreError();
    }
  }

  public async incomplete(): Promise<readonly JournalIntentV1[]> {
    try {
      const snapshot = await this.readSnapshot();
      const incomplete = [...snapshot.intents.values()]
        .filter((intent) => !snapshot.completions.has(intent.id))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      return Object.freeze(incomplete);
    } catch {
      throw journalStoreError();
    }
  }

  private assertBoundIntent(intent: JournalIntentV1): void {
    assertJournalId(intent.id);
    assertJournalId(intent.installationId);
    if (intent.installationId !== this.installationId) {
      throw journalStoreError();
    }
  }

  private async journalDirectoryExists(): Promise<boolean> {
    await assertCanonicalRuntimePath(this.journalDir);
    try {
      const entry = await lstat(this.journalDir);
      if (
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        (entry.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
      ) {
        throw journalStoreError();
      }
      return true;
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw journalStoreError();
    }
  }

  private async ensurePrivateJournalDirectory(): Promise<void> {
    await assertCanonicalRuntimePath(this.journalDir);
    await mkdir(this.journalDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await assertCanonicalRuntimePath(this.journalDir);
    const before = await lstat(this.journalDir);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw journalStoreError();
    }
    await chmod(this.journalDir, PRIVATE_DIRECTORY_MODE);
    const after = await lstat(this.journalDir);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw journalStoreError();
    }
  }

  private async readSnapshot(): Promise<JournalSnapshot> {
    if (!(await this.journalDirectoryExists())) {
      return { intents: new Map(), completions: new Set() };
    }

    const entries = await readdir(this.journalDir, { withFileTypes: true });
    if (entries.length > MAX_JOURNAL_AUDIT_ROWS) {
      throw journalStoreError();
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    const intents = new Map<string, JournalIntentV1>();
    const completions = new Set<string>();
    for (const entry of entries) {
      const intentMatch = INTENT_FILE_PATTERN.exec(entry.name);
      const completionMatch = COMPLETION_FILE_PATTERN.exec(entry.name);
      if ((intentMatch === null && completionMatch === null) || entry.isSymbolicLink() || !entry.isFile()) {
        throw journalStoreError();
      }

      const filePath = join(this.journalDir, entry.name);
      if (intentMatch !== null) {
        const id = intentMatch[1] as string;
        const parsed = await this.readIntentFile(filePath, id);
        if (intents.has(id)) {
          throw journalStoreError();
        }
        intents.set(id, parsed);
        continue;
      }

      const id = completionMatch?.[1];
      if (id === undefined || completions.has(id)) {
        throw journalStoreError();
      }
      await this.readCompletionFile(filePath);
      completions.add(id);
    }

    for (const id of completions) {
      if (!intents.has(id)) {
        throw journalStoreError();
      }
    }
    if (intents.size > MAX_JOURNAL_OPERATION_IDS) {
      throw journalStoreError();
    }
    return { intents, completions };
  }

  private async serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = FileJournalStore.mutationTails.get(this.journalDir) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    FileJournalStore.mutationTails.set(this.journalDir, current);
    try {
      await previous;
      return await mutation();
    } finally {
      release();
      if (FileJournalStore.mutationTails.get(this.journalDir) === current) {
        FileJournalStore.mutationTails.delete(this.journalDir);
      }
    }
  }

  private async readIntentFile(filePath: string, expectedId: string): Promise<JournalIntentV1> {
    const before = await this.assertPrivateRegularFile(filePath);
    const parsed = await readStrictJson(filePath, parseJournalIntent, { maxBytes: MAX_JOURNAL_JSON_BYTES });
    const after = await this.assertPrivateRegularFile(filePath);
    if (!isSameIdentity(before, after)) {
      throw journalStoreError();
    }
    this.assertBoundIntent(parsed);
    if (parsed.id !== expectedId) {
      throw journalStoreError();
    }
    return parsed;
  }

  private async readCompletionFile(filePath: string): Promise<JournalCompletionV1> {
    const before = await this.assertPrivateRegularFile(filePath);
    const parsed = await readStrictJson(filePath, parseJournalCompletion, { maxBytes: MAX_JOURNAL_JSON_BYTES });
    const after = await this.assertPrivateRegularFile(filePath);
    if (!isSameIdentity(before, after)) {
      throw journalStoreError();
    }
    return parsed;
  }

  private async assertPrivateRegularFile(filePath: string): Promise<FileIdentity> {
    await assertCanonicalRuntimePath(filePath);
    const entry = await lstat(filePath);
    if (entry.isSymbolicLink() || !entry.isFile() || (entry.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw journalStoreError();
    }
    return { dev: entry.dev, ino: entry.ino };
  }

  private async writeExclusive(fileName: string, serialized: string): Promise<void> {
    const destination = join(this.journalDir, fileName);
    const temporary = join(this.journalDir, `.${fileName}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryIdentity: FileIdentity | undefined;

    try {
      await this.ensurePrivateJournalDirectory();
      await assertCanonicalRuntimePath(destination);
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      const opened = await handle.stat();
      temporaryIdentity = { dev: opened.dev, ino: opened.ino };
      if (!opened.isFile() || (opened.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw journalStoreError();
      }
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      const afterSync = await handle.stat();
      if (!afterSync.isFile() || !isSameIdentity(temporaryIdentity, afterSync)) {
        throw journalStoreError();
      }
      await handle.close();
      handle = undefined;

      await this.assertPrivateRegularFile(temporary);
      await this.ensurePrivateJournalDirectory();
      await assertCanonicalRuntimePath(destination);
      await link(temporary, destination);
      const destinationIdentity = await this.assertPrivateRegularFile(destination);
      if (!isSameIdentity(temporaryIdentity, destinationIdentity)) {
        throw journalStoreError();
      }
      await this.syncJournalDirectory();
      await unlink(temporary);
      temporaryIdentity = undefined;
      await this.syncJournalDirectory();
    } catch {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (temporaryIdentity !== undefined) {
        await this.removeOwnedTemporary(temporary, temporaryIdentity).catch(() => undefined);
      }
      throw journalStoreError();
    }
  }

  private async removeOwnedTemporary(path: string, expected: FileIdentity): Promise<void> {
    const actual = await this.assertPrivateRegularFile(path);
    if (isSameIdentity(actual, expected)) {
      await unlink(path);
    }
  }

  private async syncJournalDirectory(): Promise<void> {
    await this.ensurePrivateJournalDirectory();
    const handle = await open(this.journalDir, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const entry = await handle.stat();
      if (!entry.isDirectory()) {
        throw journalStoreError();
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
