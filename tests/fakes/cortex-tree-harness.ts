import {
  sha256Hex,
  type BridgeStateV1,
  type Clock,
  type CortexPageObservation,
  type CortexTreeDiscovery,
  type CortexTreeNotionApi,
  type CortexTreeTransactionPlan,
  type CortexTreeTransactionRecovery,
  type CortexTreeTransactionResult,
  type JournalCompletionV1,
  type JournalIntentV1,
  type UuidSource,
} from "@grandbox-bridge/shared";
import { inspectCortexFrontmatter, upsertCortexFrontmatter } from "../../worker/src/cortex/frontmatter.js";
import { renderCortexMarkdown } from "../../worker/src/cortex/markdown.js";
import { cortexSemanticHash } from "../../worker/src/cortex/semantic.js";
import { parseLocalNote } from "../../worker/src/markdown/frontmatter.js";
import type { JournalStore } from "../../worker/src/persistence/journal-store.js";
import type { ScannedCortexVaultNote } from "../../worker/src/vault/scanner.js";
import { createCortexTreeTransactionManifest, parseCortexTreeTransactionPlan } from "../../worker/src/vault/cortex-transaction.js";
import type { CortexTreeTransactionWriter, VaultWriter } from "../../worker/src/vault/writer.js";

export const CORTEX_ROOT_ID = "11111111-1111-4111-8111-111111111111";
export const RESEARCH_ID = "22222222-2222-4222-8222-222222222222";
export const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
export const ARCHIVE_ID = "44444444-4444-4444-8444-444444444444";
export const INSTALLATION_ID = "55555555-5555-4555-8555-555555555555";
export const TRAVERSAL_ID = "66666666-6666-4666-8666-666666666666";
export const NOW = "2026-07-16T12:00:00.000Z";

const CHILD_PAGE_MARKER = /<!--\s*grandbox-cortex:child-page:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*-->/gu;

export interface FakeCortexPage {
  readonly pageId: string;
  parentPageId: string | null;
  title: string;
  sourceMarkdown: string;
  editedAt: string;
  complete?: boolean;
  opaqueRoot?: boolean;
}

function nextEditedAt(sequence: number): string {
  return `2026-07-16T12:00:${String(sequence).padStart(2, "0")}.000Z`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function childMarkers(markdown: string): readonly string[] | null {
  const matcher = new RegExp(CHILD_PAGE_MARKER.source, CHILD_PAGE_MARKER.flags);
  const ids = [...markdown.matchAll(matcher)].map((match) => match[1]);
  if (ids.some((id) => id === undefined) || markdown.replace(matcher, "").includes("<!-- grandbox-cortex:child-page:")) return null;
  return Object.freeze(ids.filter((id): id is string => id !== undefined));
}

function stripChildMarkers(markdown: string): string {
  return markdown.replace(CHILD_PAGE_MARKER, "");
}

export class FakeCortexTreeApi implements CortexTreeNotionApi {
  public readonly events: string[];
  public complete = true;
  /** Simulates a provider mutation that succeeds before its response is lost. */
  public throwAfterCreate = false;
  public createIds = ["77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888"];
  private readonly pages = new Map<string, FakeCortexPage>();
  private revision = 1;

  public constructor(events: string[]) {
    this.events = events;
  }

  public put(page: FakeCortexPage): void {
    this.pages.set(page.pageId, { ...page });
  }

  public remove(pageId: string): void {
    this.pages.delete(pageId);
  }

  public changeBody(pageId: string, sourceMarkdown: string): void {
    const page = this.require(pageId);
    page.sourceMarkdown = sourceMarkdown;
    page.editedAt = this.bump();
  }

  public changeTitle(pageId: string, title: string): void {
    const page = this.require(pageId);
    page.title = title;
    page.editedAt = this.bump();
  }

  public changeParent(pageId: string, parentPageId: string): void {
    const page = this.require(pageId);
    const oldParent = page.parentPageId;
    page.parentPageId = parentPageId;
    page.editedAt = this.bump();
    if (oldParent !== null && this.pages.has(oldParent)) this.require(oldParent).editedAt = this.bump();
    this.require(parentPageId).editedAt = this.bump();
  }

  public async discoverCortexTree(input: { readonly rootPageId: string }): Promise<CortexTreeDiscovery> {
    this.events.push("remote-discovery");
    const root = this.pages.get(input.rootPageId);
    if (root === undefined) {
      return Object.freeze({
        rootPageId: input.rootPageId,
        traversalId: TRAVERSAL_ID,
        pages: Object.freeze([]),
        complete: false,
        attention: Object.freeze([{ kind: "inaccessible" as const, pageId: input.rootPageId }]),
      });
    }
    const pages: CortexPageObservation[] = [];
    const visited = new Set<string>();
    const visit = async (pageId: string, expectedParentPageId: string | null): Promise<void> => {
      if (visited.has(pageId)) return;
      visited.add(pageId);
      const current = this.pages.get(pageId);
      if (current === undefined) return;
      pages.push(await this.observe(current, input.rootPageId, expectedParentPageId));
      for (const child of this.children(pageId)) await visit(child.pageId, pageId);
    };
    await visit(root.pageId, null);
    return Object.freeze({
      rootPageId: input.rootPageId,
      traversalId: TRAVERSAL_ID,
      pages: Object.freeze(pages),
      complete: this.complete && pages.every((page) => page.complete),
      attention: Object.freeze([]),
    });
  }

  public async createCortexPage(input: {
    readonly rootPageId: string;
    readonly parentPageId: string;
    readonly title: string;
    readonly markdown: string;
    readonly expectedParentEditedAt: string;
  }): Promise<CortexPageObservation> {
    this.events.push("remote-create");
    const parent = this.require(input.parentPageId);
    if (parent.editedAt !== input.expectedParentEditedAt) throw Object.assign(new Error("revision race"), { code: "revision-race" });
    const pageId = this.createIds.shift();
    if (pageId === undefined) throw new Error("test page IDs exhausted");
    this.pages.set(pageId, {
      pageId,
      parentPageId: input.parentPageId,
      title: input.title,
      sourceMarkdown: input.markdown,
      editedAt: this.bump(),
    });
    parent.editedAt = this.bump();
    if (this.throwAfterCreate) {
      throw Object.assign(new Error("synthetic create response interruption"), { code: "network-failed", retryable: true });
    }
    return this.observe(this.require(pageId), input.rootPageId, input.parentPageId);
  }

  public async updateCortexBodyExact(input: {
    readonly rootPageId: string;
    readonly pageId: string;
    readonly oldMarkdown: string;
    readonly newMarkdown: string;
    readonly observedEditedAt: string;
  }): Promise<CortexPageObservation> {
    this.events.push("remote-body");
    const page = this.require(input.pageId);
    const oldMarkers = childMarkers(input.oldMarkdown);
    const newMarkers = childMarkers(input.newMarkdown);
    const expectedChildren = this.children(page.pageId).map((child) => child.pageId);
    if (
      page.editedAt !== input.observedEditedAt ||
      oldMarkers === null ||
      newMarkers === null ||
      JSON.stringify(oldMarkers) !== JSON.stringify(expectedChildren) ||
      JSON.stringify(newMarkers) !== JSON.stringify(expectedChildren) ||
      page.sourceMarkdown !== stripChildMarkers(input.oldMarkdown)
    ) {
      throw Object.assign(new Error("revision race"), { code: "revision-race" });
    }
    page.sourceMarkdown = stripChildMarkers(input.newMarkdown);
    page.editedAt = this.bump();
    return this.observe(page, input.rootPageId, page.parentPageId);
  }

  public async updateCortexTitle(input: {
    readonly rootPageId: string;
    readonly pageId: string;
    readonly title: string;
    readonly observedEditedAt: string;
  }): Promise<CortexPageObservation> {
    this.events.push("remote-title");
    const page = this.require(input.pageId);
    if (page.editedAt !== input.observedEditedAt) throw Object.assign(new Error("revision race"), { code: "revision-race" });
    page.title = input.title;
    page.editedAt = this.bump();
    return this.observe(page, input.rootPageId, page.parentPageId);
  }

  public async moveCortexPage(input: {
    readonly rootPageId: string;
    readonly pageId: string;
    readonly parentPageId: string;
    readonly observedEditedAt: string;
  }): Promise<CortexPageObservation> {
    this.events.push("remote-move");
    const page = this.require(input.pageId);
    if (page.editedAt !== input.observedEditedAt || page.pageId === input.rootPageId) {
      throw Object.assign(new Error("revision race"), { code: "revision-race" });
    }
    this.require(input.parentPageId);
    const oldParent = page.parentPageId;
    page.parentPageId = input.parentPageId;
    page.editedAt = this.bump();
    if (oldParent !== null && this.pages.has(oldParent)) this.require(oldParent).editedAt = this.bump();
    this.require(input.parentPageId).editedAt = this.bump();
    return this.observe(page, input.rootPageId, input.parentPageId);
  }

  public async retrieveCortexPage(input: { readonly rootPageId: string; readonly pageId: string }): Promise<CortexPageObservation | null> {
    this.events.push("remote-reread");
    const page = this.pages.get(input.pageId);
    return page === undefined ? null : this.observe(page, input.rootPageId, page.parentPageId);
  }

  private children(parentPageId: string): FakeCortexPage[] {
    return [...this.pages.values()].filter((page) => page.parentPageId === parentPageId).sort((left, right) => compare(left.pageId, right.pageId));
  }

  private async observe(page: FakeCortexPage, rootPageId: string, parentPageId: string | null): Promise<CortexPageObservation> {
    const directChildPageIds = this.children(page.pageId).map((child) => child.pageId);
    return Object.freeze({
      pageId: page.pageId,
      parentPageId: page.pageId === rootPageId ? null : parentPageId,
      rootPageId,
      title: page.title,
      sourceMarkdown: page.sourceMarkdown,
      directChildPageIds: Object.freeze(directChildPageIds),
      semanticHash: await cortexSemanticHash(page.sourceMarkdown),
      structureHash: await sha256Hex(JSON.stringify(directChildPageIds)),
      editedAt: page.editedAt,
      complete: page.complete !== false,
      ...(page.opaqueRoot === true ? { opaqueRoot: true } : {}),
    });
  }

  private require(pageId: string): FakeCortexPage {
    const page = this.pages.get(pageId);
    if (page === undefined) throw Object.assign(new Error("not found"), { code: "not-found" });
    return page;
  }

  private bump(): string {
    this.revision += 1;
    return nextEditedAt(this.revision);
  }
}

export class MemoryCortexJournal implements JournalStore {
  public readonly begun: JournalIntentV1[] = [];
  public readonly completed: Array<{ readonly id: string; readonly evidence: JournalCompletionV1 }> = [];
  /** One-based completion attempt used to model a crash after an effect write. */
  public failCompletionAttempt: number | null = null;
  private completionAttempts = 0;

  public async begin(intent: JournalIntentV1): Promise<void> {
    this.begun.push(structuredClone(intent));
  }

  public async complete(id: string, evidence: JournalCompletionV1): Promise<void> {
    this.completionAttempts += 1;
    if (this.failCompletionAttempt === this.completionAttempts) {
      throw Object.assign(new Error("synthetic journal completion interruption"), { code: "internal-error" });
    }
    this.completed.push({ id, evidence: structuredClone(evidence) });
  }

  public async incomplete(): Promise<readonly JournalIntentV1[]> {
    const completed = new Set(this.completed.map((entry) => entry.id));
    return this.begun.filter((intent) => !completed.has(intent.id)).map((intent) => structuredClone(intent));
  }
}

class MemoryCortexWriter implements VaultWriter, CortexTreeTransactionWriter {
  public heldMoveLock = false;
  /** Targeted test seam for a verified earlier effect followed by a later failure. */
  public readonly failWritePaths = new Set<string>();
  public readonly moveCalls: Array<{ readonly sourcePath: string; readonly targetPath: string }> = [];

  public constructor(
    private readonly files: Map<string, string>,
    private readonly events: string[],
    private readonly relocated: (sourcePath: string, targetPath: string) => void = () => {},
    private readonly snapshotRelocations: () => (() => void) = () => () => {},
  ) {}

  public async write(input: { readonly relativePath: string; readonly expectedByteHash: string; readonly content: string }): Promise<Readonly<{ byteHash: string }>> {
    this.events.push("local-write");
    const current = this.files.get(input.relativePath);
    if (current === undefined || await sha256Hex(current) !== input.expectedByteHash) {
      throw Object.assign(new Error("revision race"), { code: "revision-race" });
    }
    if (this.failWritePaths.has(input.relativePath)) {
      throw Object.assign(new Error("synthetic local write failure"), { code: "revision-race" });
    }
    this.files.set(input.relativePath, input.content);
    return Object.freeze({ byteHash: await sha256Hex(input.content) });
  }

  public async create(input: { readonly relativePath: string; readonly expectedAbsent: true; readonly content: string }): Promise<Readonly<{ byteHash: string }>> {
    this.events.push("local-create");
    if (this.files.has(input.relativePath)) throw Object.assign(new Error("collision"), { code: "revision-race" });
    this.files.set(input.relativePath, input.content);
    return Object.freeze({ byteHash: await sha256Hex(input.content) });
  }

  public async moveCortexSubtree(input: { readonly sourcePath: string; readonly targetPath: string; readonly expectedSourceByteHash: string }): Promise<Readonly<{ byteHash: string }>> {
    this.events.push("local-move");
    if (this.heldMoveLock) throw Object.assign(new Error("Cortex move lock is held"), { code: "active-lock", retryable: false });
    const source = this.files.get(input.sourcePath);
    if (source === undefined || await sha256Hex(source) !== input.expectedSourceByteHash || this.files.has(input.targetPath)) {
      throw Object.assign(new Error("revision race"), { code: "revision-race" });
    }
    const sourceDirectory = input.sourcePath.slice(0, -3);
    const targetDirectory = input.targetPath.slice(0, -3);
    const descendants = [...this.files.entries()].filter(([path]) => path.startsWith(`${sourceDirectory}/`));
    if (descendants.some(([path]) => this.files.has(`${targetDirectory}${path.slice(sourceDirectory.length)}`))) {
      throw Object.assign(new Error("collision"), { code: "revision-race" });
    }
    this.files.delete(input.sourcePath);
    this.files.set(input.targetPath, source);
    for (const [path, contents] of descendants) {
      this.files.delete(path);
      this.files.set(`${targetDirectory}${path.slice(sourceDirectory.length)}`, contents);
    }
    this.relocated(input.sourcePath, input.targetPath);
    this.moveCalls.push({ sourcePath: input.sourcePath, targetPath: input.targetPath });
    return Object.freeze({ byteHash: await sha256Hex(source) });
  }

  public async applyCortexTreeTransaction(plan: CortexTreeTransactionPlan): Promise<CortexTreeTransactionResult> {
    const parsed = await parseCortexTreeTransactionPlan(plan);
    const prepared = await this.transactionManifest(parsed, "prepared", []);
    if (this.heldMoveLock) return this.transactionResult(prepared, "recovery-required");

    const files = new Map(this.files);
    const restoreRelocations = this.snapshotRelocations();
    const eventLength = this.events.length;
    const moveCallLength = this.moveCalls.length;
    const completedMemberIds: string[] = [];
    try {
      for (const member of parsed.members) {
        if (member.kind === "write") {
          await this.write({
            relativePath: member.relativePath,
            expectedByteHash: member.expectedByteHash,
            content: member.content,
          });
        } else if (member.kind === "create") {
          await this.create({
            relativePath: member.relativePath,
            expectedAbsent: true,
            content: member.content,
          });
        } else {
          await this.moveCortexSubtree({
            sourcePath: member.sourcePath,
            targetPath: member.targetPath,
            expectedSourceByteHash: member.expectedSourceByteHash,
          });
        }
        completedMemberIds.push(member.memberId);
      }
      return this.transactionResult(
        await this.transactionManifest(parsed, "committed", completedMemberIds),
        "committed",
      );
    } catch {
      this.files.clear();
      for (const [path, content] of files) this.files.set(path, content);
      restoreRelocations();
      this.events.splice(eventLength);
      this.moveCalls.splice(moveCallLength);
      return this.transactionResult(prepared, "rolled-back");
    }
  }

  public async recoverCortexTreeTransactions(): Promise<CortexTreeTransactionRecovery> {
    return Object.freeze({ transactions: Object.freeze([]) });
  }

  private async transactionManifest(
    plan: CortexTreeTransactionPlan,
    phase: "prepared" | "committed",
    completedMemberIds: readonly string[],
  ) {
    const completed = new Set(completedMemberIds);
    let identity = 0;
    return createCortexTreeTransactionManifest({
      schemaVersion: 1,
      transactionId: plan.transactionId,
      rootPageId: plan.rootPageId,
      participantIds: plan.participantIds,
      phase,
      completedMemberIds,
      pendingMember: null,
      members: plan.members.map((member) => {
        identity += 1;
        if (member.kind === "write") {
          return {
            memberId: member.memberId,
            kind: member.kind,
            relativePath: member.relativePath,
            expectedByteHash: member.expectedByteHash,
            resultByteHash: member.resultByteHash,
            preimageFile: `${member.memberId}.preimage`,
            ...(completed.has(member.memberId) ? { postIdentity: { file: { dev: "0", ino: String(identity) } } } : {}),
          };
        }
        if (member.kind === "create") {
          return {
            memberId: member.memberId,
            kind: member.kind,
            relativePath: member.relativePath,
            expectedAbsent: true,
            resultByteHash: member.resultByteHash,
            preimageFile: null,
            ...(completed.has(member.memberId) ? { postIdentity: { file: { dev: "0", ino: String(identity) } } } : {}),
          };
        }
        return {
          memberId: member.memberId,
          kind: member.kind,
          sourcePath: member.sourcePath,
          targetPath: member.targetPath,
          expectedSourceByteHash: member.expectedSourceByteHash,
          resultByteHash: member.expectedSourceByteHash,
          preimageFile: `${member.memberId}.preimage`,
          ...(completed.has(member.memberId) ? {
            postIdentity: {
              targetFile: { dev: "0", ino: String(identity) },
              targetDirectory: null,
            },
          } : {}),
        };
      }),
    });
  }

  private transactionResult(
    manifest: Awaited<ReturnType<MemoryCortexWriter["transactionManifest"]>>,
    status: CortexTreeTransactionResult["status"],
  ): CortexTreeTransactionResult {
    return Object.freeze({
      transactionId: manifest.transactionId,
      rootPageId: manifest.rootPageId,
      manifestDigest: manifest.manifestDigest,
      status,
      completedMemberIds: Object.freeze(status === "rolled-back" ? [] : [...manifest.completedMemberIds]),
      error: status === "recovery-required" ? Object.freeze({ code: "recovery-required" as const, retryable: false }) : null,
    });
  }

}

class FixedClock implements Clock {
  public now(): Date {
    return new Date(NOW);
  }

  public async sleep(): Promise<void> {}
}

class FixedUuid implements UuidSource {
  private index = 0;
  private readonly values = [
    "99999999-9999-4999-8999-999999999999",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    "ffffffff-ffff-4fff-8fff-ffffffffffff",
    "12121212-1212-4212-8212-121212121212",
    "13131313-1313-4313-8313-131313131313",
  ];

  public randomUUID(): string {
    const value = this.values[this.index];
    this.index += 1;
    if (value === undefined) throw new Error("test UUIDs exhausted");
    return value;
  }
}

export class CortexTreeHarness {
  public readonly events: string[] = [];
  public readonly notion = new FakeCortexTreeApi(this.events);
  public readonly journal = new MemoryCortexJournal();
  public readonly localFiles = new Map<string, string>();
  private readonly candidatePaths = new Set<string>();
  public readonly writer = new MemoryCortexWriter(
    this.localFiles,
    this.events,
    (sourcePath, targetPath) => this.relocateCandidates(sourcePath, targetPath),
    () => {
      const snapshot = new Set(this.candidatePaths);
      return () => {
        this.candidatePaths.clear();
        for (const path of snapshot) this.candidatePaths.add(path);
      };
    },
  );
  public readonly clock = new FixedClock();
  public readonly uuid = new FixedUuid();
  public savedStates: BridgeStateV1[] = [];

  private relocateCandidates(sourcePath: string, targetPath: string): void {
    if (!sourcePath.endsWith(".md") || !targetPath.endsWith(".md")) return;
    const sourceDirectory = sourcePath.slice(0, -3);
    const targetDirectory = targetPath.slice(0, -3);
    for (const path of [...this.candidatePaths]) {
      if (!path.startsWith(`${sourceDirectory}/`)) continue;
      this.candidatePaths.delete(path);
      this.candidatePaths.add(`${targetDirectory}${path.slice(sourceDirectory.length)}`);
    }
  }

  public putRemote(page: FakeCortexPage): void {
    this.notion.put(page);
  }

  public putOwnedLocal(input: Readonly<{
    path: string;
    pageId: string;
    parentPageId: string | null;
    parentPath: string | null;
    body: string;
    childPageIds?: readonly string[];
  }>): void {
    const markdown = renderCortexMarkdown({
      bodyMarkdown: input.body,
      parentWikiLink: input.parentPath,
      directChildPageIds: input.childPageIds ?? [],
    });
    this.localFiles.set(input.path, upsertCortexFrontmatter(markdown, {
      cortexTree: true,
      pageId: input.pageId,
      parentPageId: input.parentPageId,
      rootPageId: CORTEX_ROOT_ID,
    }));
  }

  public putCandidateLocal(path: string, body: string): void {
    this.candidatePaths.add(path);
    this.localFiles.set(path, body);
  }

  public async scan(): Promise<readonly ScannedCortexVaultNote[]> {
    this.events.push("local-scan");
    const entries: ScannedCortexVaultNote[] = [];
    for (const [path, bytes] of [...this.localFiles.entries()].sort(([left], [right]) => compare(left, right))) {
      try {
        const note = parseLocalNote(path, bytes);
        const inspection = inspectCortexFrontmatter(note);
        if (inspection.kind === "owned") {
          entries.push({ path, kind: "owned", note, cortex: inspection.cortex });
        } else if (inspection.kind === "none" && this.candidatePaths.has(path)) {
          entries.push({ path, kind: "candidate", note });
        } else {
          entries.push({ path, kind: "invalid" });
        }
      } catch {
        entries.push({ path, kind: "invalid" });
      }
    }
    return entries;
  }

  public async readLocalBytes(path: string): Promise<string | null> {
    this.events.push("local-reread");
    return this.localFiles.get(path) ?? null;
  }

  public initialState(cortex: BridgeStateV1["cortex"] = null): BridgeStateV1 {
    return {
      schemaVersion: 2,
      installationId: INSTALLATION_ID,
      pairs: {
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee": {
          bridgeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          localPath: "Legacy/Keep.md",
          notionPageId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          status: "synced",
          lastLocalSemanticHash: "1".repeat(64),
          lastNotionSemanticHash: "1".repeat(64),
          lastCommonSemanticHash: "1".repeat(64),
          lastCommonLocalByteHash: "1".repeat(64),
          lastNotionEditedAt: NOW,
          lastSyncedAt: NOW,
        },
      },
      graph: null,
      lastFullReconciliationAt: null,
      lastRun: null,
      cortex,
    };
  }
}
