import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
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
// One retirement marker may coexist with the previous maximum of intent and
// completion rows while an interrupted rotation is being recovered.
const MAX_JOURNAL_AUDIT_ROWS = MAX_JOURNAL_OPERATION_IDS * 2 + 1;
const MAX_JOURNAL_JSON_BYTES = 64 * 1_024;
const JOURNAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTENT_FILE_PATTERN = /^intent-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const COMPLETION_FILE_PATTERN = /^completion-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const RETIREMENT_FILE_PATTERN = /^retirement-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;

export interface JournalStore {
  begin(intent: JournalIntentV1): Promise<void>;
  complete(id: string, evidence: JournalCompletionV1): Promise<void>;
  incomplete(): Promise<readonly JournalIntentV1[]>;
}

/** Narrow test-only durability and rotation seams; no runtime configuration consumes them. */
export interface FileJournalStoreTestHooks {
  readonly syncDirectory?: (directoryPath: string, sync: () => Promise<void>) => Promise<void>;
  readonly syncFile?: (filePath: string, sync: () => Promise<void>) => Promise<void>;
  readonly rotationThreshold?: number;
  readonly cacheSnapshots?: boolean;
  readonly beforeCompactionPhase?: (phase: JournalCompactionPhase) => Promise<void>;
}

/** Narrow test-only interruption seam after each durable compaction phase. */
export type JournalCompactionPhase = "retirement-written" | "intent-removed" | "completion-removed" | "retirement-removed";

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface JournalSnapshot {
  readonly intents: Map<string, JournalIntentV1>;
  readonly completions: Set<string>;
  readonly retirements: Map<string, JournalRetirement>;
}

interface JournalRetirement {
  readonly id: string;
  readonly intent: JournalIntentV1;
  readonly completion: JournalCompletionV1;
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

function normalizedJournalQueueKey(journalDir: string): string {
  assertJournalDirectorySyntax(journalDir);
  // `resolve` is lexical only: it removes a trailing separator without following symlinks.
  const queueKey = resolve(journalDir);
  if (!isAbsolute(queueKey) || queueKey.includes("\0") || normalize(queueKey) !== queueKey) {
    throw journalStoreError();
  }
  return queueKey;
}

function intentFilename(id: string): string {
  assertJournalId(id);
  return `intent-${id}.json`;
}

function completionFilename(id: string): string {
  assertJournalId(id);
  return `completion-${id}.json`;
}

function retirementFilename(id: string): string {
  assertJournalId(id);
  return `retirement-${id}.json`;
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

function exactRetirementSnapshot(retirement: JournalRetirement): Record<string, unknown> {
  const value = Object.create(null) as Record<string, unknown>;
  value.schemaVersion = 1;
  value.id = retirement.id;
  value.intent = exactIntentSnapshot(retirement.intent);
  value.completion = exactCompletionSnapshot(retirement.completion);
  return value;
}

function sameIntent(left: JournalIntentV1, right: JournalIntentV1): boolean {
  return JSON.stringify(exactIntentSnapshot(left)) === JSON.stringify(exactIntentSnapshot(right));
}

function sameCompletion(left: JournalCompletionV1, right: JournalCompletionV1): boolean {
  return JSON.stringify(exactCompletionSnapshot(left)) === JSON.stringify(exactCompletionSnapshot(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function parseRetirement(value: unknown): JournalRetirement {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "id", "intent", "completion"])) {
    throw journalStoreError();
  }
  if (value.schemaVersion !== 1 || typeof value.id !== "string") throw journalStoreError();
  assertJournalId(value.id);
  const intent = parseJournalIntent(value.intent);
  const completion = parseJournalCompletion(value.completion);
  if (intent.id !== value.id) throw journalStoreError();
  return Object.freeze({ id: value.id, intent, completion });
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
  private readonly journalQueueKey: string;
  private cachedSnapshot: JournalSnapshot | null = null;

  public constructor(
    private readonly journalDir: string,
    private readonly installationId: string,
    private readonly testHooks: FileJournalStoreTestHooks = {},
  ) {
    try {
      this.journalQueueKey = normalizedJournalQueueKey(journalDir);
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
        await this.recoverRetirements();
        let snapshot = await this.readSnapshot();
        const outstanding = [...snapshot.intents.values()].filter((entry) => !snapshot.completions.has(entry.id));
        if (outstanding.length >= MAX_JOURNAL_OPERATION_IDS || snapshot.intents.has(parsed.id) || snapshot.retirements.has(parsed.id)) {
          throw journalStoreError();
        }
        if (snapshot.intents.size >= this.rotationThreshold() && snapshot.completions.size > 0) {
          await this.compactOneCompleted(snapshot);
          snapshot = await this.readSnapshot();
          if (snapshot.intents.size >= MAX_JOURNAL_OPERATION_IDS) throw journalStoreError();
        }
        await this.writeExclusive(intentFilename(parsed.id), serializeRecord(exactIntentSnapshot(parsed)));
        snapshot.intents.set(parsed.id, parsed);
        this.rememberSnapshot(snapshot);
      });
    } catch {
      this.clearCachedSnapshot();
      throw journalStoreError();
    }
  }

  public async complete(id: string, evidence: JournalCompletionV1): Promise<void> {
    try {
      assertJournalId(id);
      const parsed = parseJournalCompletion(evidence);
      await this.serializeMutation(async () => {
        await this.recoverRetirements();
        const snapshot = await this.readSnapshot();
        if (!snapshot.intents.has(id) || snapshot.completions.has(id)) {
          throw journalStoreError();
        }
        await this.writeExclusive(completionFilename(id), serializeRecord(exactCompletionSnapshot(parsed)));
        snapshot.completions.add(id);
        this.rememberSnapshot(snapshot);
      });
    } catch {
      this.clearCachedSnapshot();
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
    await this.assertExistingJournalParent();
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
        // An ENOENT for the leaf is empty only while its immediate runtime
        // parent still exists as a safe directory; otherwise recovery must
        // fail closed rather than silently treating a broken runtime path as
        // a clean journal.
        await this.assertExistingJournalParent();
        return false;
      }
      throw journalStoreError();
    }
  }

  private async assertExistingJournalParent(): Promise<string> {
    const parent = dirname(this.journalDir);
    try {
      await assertCanonicalRuntimePath(parent);
      const parentEntry = await lstat(parent);
      if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
        throw journalStoreError();
      }
      return parent;
    } catch {
      throw journalStoreError();
    }
  }

  private async ensurePrivateJournalDirectory(): Promise<void> {
    const parent = await this.assertExistingJournalParent();
    await assertCanonicalRuntimePath(this.journalDir);
    try {
      await mkdir(this.journalDir, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "EEXIST") {
        throw journalStoreError();
      }
    }
    await assertCanonicalRuntimePath(this.journalDir);
    const before = await lstat(this.journalDir);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw journalStoreError();
    }
    const permissionsUpdated = (before.mode & 0o777) !== PRIVATE_DIRECTORY_MODE;
    if (permissionsUpdated) {
      await chmod(this.journalDir, PRIVATE_DIRECTORY_MODE);
    }
    const after = await lstat(this.journalDir);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw journalStoreError();
    }
    // A previous failed attempt may have created the directory without making
    // its entry durable, so every successful ensure re-syncs the parent first.
    await this.syncDirectory(parent);
    await this.syncDirectory(this.journalDir);
  }

  private async readSnapshot(): Promise<JournalSnapshot> {
    if (this.testHooks.cacheSnapshots && this.cachedSnapshot !== null) return this.cachedSnapshot;
    if (!(await this.journalDirectoryExists())) {
      return this.rememberSnapshot({ intents: new Map(), completions: new Set(), retirements: new Map() });
    }

    const entries = await readdir(this.journalDir, { withFileTypes: true });
    if (entries.length > MAX_JOURNAL_AUDIT_ROWS) {
      throw journalStoreError();
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    const intents = new Map<string, JournalIntentV1>();
    const completions = new Map<string, JournalCompletionV1>();
    const retirements = new Map<string, JournalRetirement>();
    for (const entry of entries) {
      const intentMatch = INTENT_FILE_PATTERN.exec(entry.name);
      const completionMatch = COMPLETION_FILE_PATTERN.exec(entry.name);
      const retirementMatch = RETIREMENT_FILE_PATTERN.exec(entry.name);
      if ((intentMatch === null && completionMatch === null && retirementMatch === null) || entry.isSymbolicLink() || !entry.isFile()) {
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

      if (completionMatch !== null) {
        const id = completionMatch[1] as string;
        if (completions.has(id)) throw journalStoreError();
        completions.set(id, await this.readCompletionFile(filePath));
        continue;
      }

      const id = retirementMatch?.[1];
      if (id === undefined || retirements.has(id)) throw journalStoreError();
      const parsed = await this.readRetirementFile(filePath, id);
      this.assertBoundIntent(parsed.intent);
      retirements.set(id, parsed);
    }

    if (retirements.size > 1) throw journalStoreError();
    for (const retirement of retirements.values()) {
      const rowIntent = intents.get(retirement.id);
      const rowCompletion = completions.get(retirement.id);
      if (rowIntent !== undefined && !sameIntent(rowIntent, retirement.intent)) throw journalStoreError();
      if (rowCompletion !== undefined && !sameCompletion(rowCompletion, retirement.completion)) throw journalStoreError();
      // Marker -> intent removal -> completion removal is the only durable
      // sequence. A marker paired with an intent but no completion cannot be
      // produced by that sequence, so recovery must fail closed.
      if (rowIntent !== undefined && rowCompletion === undefined) throw journalStoreError();
      intents.delete(retirement.id);
      completions.delete(retirement.id);
    }

    for (const id of completions.keys()) {
      if (!intents.has(id)) {
        throw journalStoreError();
      }
    }
    if (intents.size > MAX_JOURNAL_OPERATION_IDS) {
      throw journalStoreError();
    }
    return this.rememberSnapshot({ intents, completions: new Set(completions.keys()), retirements });
  }

  private async recoverRetirements(): Promise<void> {
    const snapshot = await this.readSnapshot();
    for (const retirement of snapshot.retirements.values()) {
      await this.finishRetirement(retirement, false);
      snapshot.retirements.delete(retirement.id);
    }
    this.rememberSnapshot(snapshot);
  }

  private async compactOneCompleted(snapshot: JournalSnapshot): Promise<void> {
    if (snapshot.retirements.size !== 0) throw journalStoreError();
    const id = [...snapshot.completions].sort()[0];
    if (id === undefined) throw journalStoreError();
    const intent = snapshot.intents.get(id);
    if (intent === undefined) throw journalStoreError();
    const retirement = Object.freeze({
      id,
      intent,
      completion: await this.readCompletionFile(join(this.journalDir, completionFilename(id))),
    });
    await this.writeExclusive(retirementFilename(id), serializeRecord(exactRetirementSnapshot(retirement)));
    await this.beforeCompactionPhase("retirement-written");
    await this.finishRetirement(retirement, true);
    snapshot.intents.delete(id);
    snapshot.completions.delete(id);
    this.rememberSnapshot(snapshot);
  }

  private async finishRetirement(retirement: JournalRetirement, invokeHooks: boolean): Promise<void> {
    await this.removeExpectedIntent(retirement);
    if (invokeHooks) await this.beforeCompactionPhase("intent-removed");
    await this.removeExpectedCompletion(retirement);
    if (invokeHooks) await this.beforeCompactionPhase("completion-removed");
    await this.removeExpectedRetirement(retirement);
    if (invokeHooks) await this.beforeCompactionPhase("retirement-removed");
  }

  private async beforeCompactionPhase(phase: JournalCompactionPhase): Promise<void> {
    await this.testHooks.beforeCompactionPhase?.(phase);
  }

  private rotationThreshold(): number {
    const threshold = this.testHooks.rotationThreshold ?? MAX_JOURNAL_OPERATION_IDS;
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > MAX_JOURNAL_OPERATION_IDS) {
      throw journalStoreError();
    }
    return threshold;
  }

  private rememberSnapshot(snapshot: JournalSnapshot): JournalSnapshot {
    if (this.testHooks.cacheSnapshots) this.cachedSnapshot = snapshot;
    return snapshot;
  }

  private clearCachedSnapshot(): void {
    this.cachedSnapshot = null;
  }

  private async serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = FileJournalStore.mutationTails.get(this.journalQueueKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    FileJournalStore.mutationTails.set(this.journalQueueKey, current);
    try {
      await previous;
      return await mutation();
    } finally {
      release();
      if (FileJournalStore.mutationTails.get(this.journalQueueKey) === current) {
        FileJournalStore.mutationTails.delete(this.journalQueueKey);
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

  private async readRetirementFile(filePath: string, expectedId: string): Promise<JournalRetirement> {
    const before = await this.assertPrivateRegularFile(filePath);
    const parsed = await readStrictJson(filePath, parseRetirement, { maxBytes: MAX_JOURNAL_JSON_BYTES });
    const after = await this.assertPrivateRegularFile(filePath);
    if (!isSameIdentity(before, after) || parsed.id !== expectedId) {
      throw journalStoreError();
    }
    return parsed;
  }

  private async removeExpectedIntent(retirement: JournalRetirement): Promise<void> {
    const filePath = join(this.journalDir, intentFilename(retirement.id));
    const before = await this.privateRegularFileOrNull(filePath);
    if (before === null) return;
    const parsed = await this.readIntentFile(filePath, retirement.id);
    const after = await this.privateRegularFileOrNull(filePath);
    if (after === null || !isSameIdentity(before, after) || !sameIntent(parsed, retirement.intent)) {
      throw journalStoreError();
    }
    await unlink(filePath);
    await this.syncJournalDirectory();
  }

  private async removeExpectedCompletion(retirement: JournalRetirement): Promise<void> {
    const filePath = join(this.journalDir, completionFilename(retirement.id));
    const before = await this.privateRegularFileOrNull(filePath);
    if (before === null) return;
    const parsed = await this.readCompletionFile(filePath);
    const after = await this.privateRegularFileOrNull(filePath);
    if (after === null || !isSameIdentity(before, after) || !sameCompletion(parsed, retirement.completion)) {
      throw journalStoreError();
    }
    await unlink(filePath);
    await this.syncJournalDirectory();
  }

  private async removeExpectedRetirement(retirement: JournalRetirement): Promise<void> {
    const filePath = join(this.journalDir, retirementFilename(retirement.id));
    const before = await this.privateRegularFileOrNull(filePath);
    if (before === null) throw journalStoreError();
    const parsed = await this.readRetirementFile(filePath, retirement.id);
    const after = await this.privateRegularFileOrNull(filePath);
    if (
      after === null ||
      !isSameIdentity(before, after) ||
      !sameIntent(parsed.intent, retirement.intent) ||
      !sameCompletion(parsed.completion, retirement.completion)
    ) {
      throw journalStoreError();
    }
    await unlink(filePath);
    await this.syncJournalDirectory();
  }

  private async privateRegularFileOrNull(filePath: string): Promise<FileIdentity | null> {
    await assertCanonicalRuntimePath(filePath);
    try {
      const entry = await lstat(filePath);
      if (entry.isSymbolicLink() || !entry.isFile() || (entry.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw journalStoreError();
      }
      return { dev: entry.dev, ino: entry.ino };
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw journalStoreError();
    }
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
      const activeHandle = handle;
      const opened = await activeHandle.stat();
      temporaryIdentity = { dev: opened.dev, ino: opened.ino };
      if (!opened.isFile() || (opened.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw journalStoreError();
      }
      await activeHandle.writeFile(serialized, "utf8");
      await this.syncFile(temporary, () => activeHandle.sync());
      const afterSync = await activeHandle.stat();
      if (!afterSync.isFile() || !isSameIdentity(temporaryIdentity, afterSync)) {
        throw journalStoreError();
      }
      await activeHandle.close();
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
    await this.syncDirectory(this.journalDir);
  }

  private async syncFile(filePath: string, sync: () => Promise<void>): Promise<void> {
    if (this.testHooks.syncFile === undefined) {
      await sync();
    } else {
      await this.testHooks.syncFile(filePath, sync);
    }
  }

  private async syncDirectory(directoryPath: string): Promise<void> {
    await assertCanonicalRuntimePath(directoryPath);
    const named = await lstat(directoryPath);
    if (named.isSymbolicLink() || !named.isDirectory()) {
      throw journalStoreError();
    }
    const handle = await open(directoryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const entry = await handle.stat();
      if (!entry.isDirectory()) {
        throw journalStoreError();
      }
      const sync = async (): Promise<void> => handle.sync();
      if (this.testHooks.syncDirectory === undefined) {
        await sync();
      } else {
        await this.testHooks.syncDirectory(directoryPath, sync);
      }
    } finally {
      await handle.close();
    }
  }
}
