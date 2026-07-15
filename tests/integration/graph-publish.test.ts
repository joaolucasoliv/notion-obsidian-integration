import {
  randomUUID,
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  base64url,
  decryptGraph,
  type BridgeConfigV1,
  type BridgeRunSummary,
  type BridgeStateV1,
  type Clock,
  type CredentialSlot,
  type CredentialStore,
  type GraphProjectionV1,
  type GraphPublishStateV1,
} from "@grandbox-bridge/shared";
import { describe, expect, it, vi } from "vitest";
import {
  GraphPublisher,
  type GraphNonceSource,
} from "../../worker/src/graph/publisher.js";
import {
  recoverPendingRelayTokenRotation,
  RelayClient,
  rotateRelayToken,
  type RelayClientFactory,
} from "../../worker/src/relay/client.js";
import { RelayEventSource } from "../../worker/src/relay/event-source.js";
import { RelaySnapshotSink } from "../../worker/src/relay/snapshot-sink.js";
import { GrandboxBridgeWorker, type WorkerDependencies } from "../../worker/src/worker.js";
import { canonicalVaultRoot, type CanonicalVaultRoot } from "../../worker/src/vault/safety.js";
import type { ConfigStore } from "../../worker/src/persistence/config-store.js";
import type { StateStore } from "../../worker/src/persistence/state-store.js";
import { FakeNotionApi, MemoryJournal } from "../fakes/bridge-harness.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const BLOCK_ID = "33333333-3333-4333-8333-333333333333";
const NESTED_BLOCK_ID = "44444444-4444-4444-8444-444444444444";
const EVENT_ID = "55555555-5555-4555-8555-555555555555";
const UNRELATED_EVENT_ID = "66666666-6666-4666-8666-666666666666";
const ACTIVE_TOKEN = base64url(new Uint8Array(32).fill(1));
const NEXT_TOKEN = base64url(new Uint8Array(32).fill(2));
const GRAPH_KEY = Uint8Array.from({ length: 32 }, (_unused, index) => index + 1);

function projection(label = "PRIVATE BODY SENTINEL"): GraphProjectionV1 {
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    nodes: [
      {
        id: "vault:root",
        label: "The Grandbox",
        path: null,
        kind: "vault",
        domain: "other",
        tags: [],
        notionUrl: null,
        obsidianUrl: null,
        collapsed: false,
      },
      {
        id: "note:private",
        label,
        path: "Private.md",
        kind: "note",
        domain: "personal",
        tags: ["private"],
        notionUrl: null,
        obsidianUrl: "obsidian://open?vault=The%20Grandbox&file=Private.md",
        collapsed: false,
      },
    ],
    edges: [
      { id: "edge:vault:private", source: "vault:root", target: "note:private", kind: "vault" },
    ],
    conflicts: 0,
  };
}

function initialGraphState(): GraphPublishStateV1 {
  return {
    projectionHash: null,
    graphId: "fixture-graph",
    keyId: "fixture-key",
    sequence: 0,
    lastPublishedAt: null,
  };
}

class TestClock implements Clock {
  private milliseconds = new Date("2026-07-15T12:00:00.000Z").getTime();
  public readonly sleeps: number[] = [];

  public now(): Date {
    return new Date(this.milliseconds);
  }

  public advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }

  public async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.advance(milliseconds);
  }
}

class SequenceNonces implements GraphNonceSource {
  private nextByte = 1;

  public next(): Uint8Array {
    const value = new Uint8Array(12).fill(this.nextByte);
    this.nextByte += 1;
    return value;
  }
}

class MemoryCredentials implements CredentialStore {
  public readonly values = new Map<CredentialSlot, string>();
  public readonly writes: CredentialSlot[] = [];
  public readonly deletes: CredentialSlot[] = [];

  public constructor(active = ACTIVE_TOKEN, pending: string | null = null) {
    this.values.set("relay-token", active);
    if (pending !== null) this.values.set("relay-token-pending", pending);
  }

  public async get(slot: CredentialSlot): Promise<string | null> {
    return this.values.get(slot) ?? null;
  }

  public async set(slot: CredentialSlot, value: string): Promise<void> {
    this.writes.push(slot);
    this.values.set(slot, value);
  }

  public async delete(slot: CredentialSlot): Promise<void> {
    this.deletes.push(slot);
    this.values.delete(slot);
  }
}

class GraphConfigStore implements ConfigStore {
  public constructor(private readonly value: BridgeConfigV1) {}

  public async load(): Promise<BridgeConfigV1> {
    return structuredClone(this.value);
  }

  public async save(): Promise<void> {
    throw new Error("graph worker never writes configuration");
  }
}

class GraphStateStore implements StateStore {
  public saves = 0;

  public constructor(public value: BridgeStateV1) {}

  public async load(): Promise<BridgeStateV1> {
    return structuredClone(this.value);
  }

  public async save(value: BridgeStateV1): Promise<void> {
    this.saves += 1;
    this.value = structuredClone(value);
  }
}

function workerState(): BridgeStateV1 {
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    pairs: {},
    graph: null,
    lastFullReconciliationAt: null,
    lastRun: null,
  };
}

function workerConfig(root: CanonicalVaultRoot): BridgeConfigV1 {
  return {
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
    relay: { baseUrl: "https://relay.example.test" },
    graph: {
      graphId: "fixture-graph",
      keyId: "fixture-key",
      webOrigin: null,
      domains: [],
    },
  };
}

function optedIn(body: string): string {
  return `---\nnotion_sync: true\ntags: [private]\n---\n${body}`;
}

function optedOut(body: string): string {
  return `---\nnotion_sync: false\ntags: [private]\n---\n${body}`;
}

interface QueuedEvent {
  readonly id: string;
  readonly type: string;
  readonly entityId: string;
  readonly eventAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  consumed: boolean;
}

interface RecordedRequest {
  readonly pathname: string;
  readonly authorization: string | null;
  readonly body: string;
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function empty(status: number, headers: HeadersInit = {}): Response {
  return new Response(null, { status, headers });
}

class MemoryRelay {
  public readonly requests: RecordedRequest[] = [];
  public readonly snapshots: Array<Record<string, unknown>> = [];
  public readonly acknowledgedEvents: string[] = [];
  public readonly registrations = new Map<string, string>();
  public readonly clock: TestClock;
  public activeToken = ACTIVE_TOKEN;
  public pendingToken: string | null = null;
  public expectedKeyId = "fixture-key";
  public rejectSnapshotStatus: number | null = null;
  public claimResponses: Response[] = [];

  public constructor(clock: TestClock) {
    this.clock = clock;
  }

  public readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    this.requests.push({ pathname: url.pathname, authorization: request.headers.get("authorization"), body });
    const token = request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? null;
    const authKind = token === this.activeToken ? "active" : token === this.pendingToken ? "pending" : null;
    if (authKind === null) return empty(401);

    if (url.pathname === "/v1/events/claim") {
      const queuedResponse = this.claimResponses.shift();
      if (queuedResponse !== undefined) return queuedResponse;
      const inputBody = JSON.parse(body) as { workerId: string; limit: number };
      const available = [...this.events.values()]
        .filter((event) => !event.consumed && (event.leaseExpiresAt === null || event.leaseExpiresAt <= this.clock.now().getTime()))
        .slice(0, inputBody.limit);
      for (const event of available) {
        event.leaseOwner = inputBody.workerId;
        event.leaseExpiresAt = this.clock.now().getTime() + 60_000;
      }
      return json({
        events: available.map(({ id, type, entityId, eventAt }) => ({ id, type, entityId, eventAt })),
        leaseSeconds: 60,
      });
    }

    if (url.pathname === "/v1/events/ack") {
      const inputBody = JSON.parse(body) as { workerId: string; eventIds: string[] };
      const events = inputBody.eventIds.map((id) => this.events.get(id));
      if (events.some((event) => event === undefined || event.consumed || event.leaseOwner !== inputBody.workerId || (event.leaseExpiresAt ?? 0) <= this.clock.now().getTime())) {
        return empty(409);
      }
      for (const event of events) {
        if (event === undefined) return empty(409);
        event.consumed = true;
        event.leaseOwner = null;
        event.leaseExpiresAt = null;
        this.acknowledgedEvents.push(event.id);
      }
      return empty(204);
    }

    if (url.pathname === "/v1/pages/register" || url.pathname === "/v1/pages/unregister") {
      const inputBody = JSON.parse(body) as { pageId: string; bridgeId: string };
      if (url.pathname === "/v1/pages/register") this.registrations.set(inputBody.pageId, inputBody.bridgeId);
      else this.registrations.delete(inputBody.pageId);
      return empty(204);
    }

    if (url.pathname === "/v1/snapshot") {
      if (this.rejectSnapshotStatus !== null) return empty(this.rejectSnapshotStatus);
      const envelope = JSON.parse(body) as Record<string, unknown>;
      if (envelope.keyId !== this.expectedKeyId) return empty(409);
      const sequence = envelope.sequence;
      const previous = this.snapshots.at(-1)?.sequence;
      if (typeof sequence !== "number" || (typeof previous === "number" && sequence <= previous)) return empty(409);
      this.snapshots.push(envelope);
      return empty(201);
    }

    if (url.pathname === "/v1/auth/rotate/prepare") {
      if (authKind !== "active") return empty(403);
      const inputBody = JSON.parse(body) as { newToken: string };
      if (inputBody.newToken === this.activeToken || (this.pendingToken !== null && this.pendingToken !== inputBody.newToken)) return empty(409);
      this.pendingToken = inputBody.newToken;
      return empty(204);
    }

    if (url.pathname === "/v1/auth/rotate/commit") {
      if (authKind !== "pending" || this.pendingToken === null) return empty(403);
      this.activeToken = this.pendingToken;
      this.pendingToken = null;
      return empty(204);
    }

    if (url.pathname === "/v1/auth/rotate/cancel") {
      if (authKind !== "active") return empty(403);
      const inputBody = JSON.parse(body) as { pendingToken: string };
      if (inputBody.pendingToken !== this.pendingToken) return empty(409);
      this.pendingToken = null;
      return empty(204);
    }

    return empty(404);
  };

  private readonly events = new Map<string, QueuedEvent>();

  public enqueue(input: Omit<QueuedEvent, "leaseOwner" | "leaseExpiresAt" | "consumed">): void {
    this.events.set(input.id, { ...input, leaseOwner: null, leaseExpiresAt: null, consumed: false });
  }

  public client(token = this.activeToken): RelayClient {
    return new RelayClient({
      baseUrl: "https://relay.example.test",
      token,
      fetch: this.fetch,
      clock: this.clock,
      jitter: { delayMs: (attempt) => attempt * 10 },
    });
  }

  public factory(): RelayClientFactory {
    return { create: (token) => this.client(token) };
  }

  public relayPlaintext(): string {
    return this.requests.map((request) => request.body).join("\n");
  }
}

class WorkerGraphHarness {
  public readonly clock = new TestClock();
  public readonly relay = new MemoryRelay(this.clock);
  public readonly credentials = new MemoryCredentials();
  public readonly journal = new MemoryJournal();
  public readonly notion = new FakeNotionApi();
  public readonly state = new GraphStateStore(workerState());
  public readonly worker: GrandboxBridgeWorker;

  private constructor(public readonly root: CanonicalVaultRoot) {
    this.credentials.values.set("notion-token", "synthetic-notion-token");
    this.credentials.values.set("graph-key", base64url(GRAPH_KEY));
    const dependencies: WorkerDependencies = {
      config: new GraphConfigStore(workerConfig(root)),
      state: this.state,
      credentials: this.credentials,
      journal: this.journal,
      lock: { runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => operation() },
      clock: this.clock,
      uuid: { randomUUID },
      canonicalizeVault: async () => root,
      createNotionApi: async () => this.notion,
      createRelayClient: ({ token }) => this.relay.client(token),
      nonceSource: new SequenceNonces(),
    } as WorkerDependencies;
    this.worker = new GrandboxBridgeWorker(dependencies);
  }

  public static async create(): Promise<WorkerGraphHarness> {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "grandbox-graph-publish-")));
    return new WorkerGraphHarness(await canonicalVaultRoot(directory, INSTALLATION_ID, { mode: "bootstrap" }));
  }

  public async write(path: string, content: string): Promise<void> {
    await writeFile(join(this.root.canonicalRealPath, path), content, "utf8");
  }

  public async read(path: string): Promise<string> {
    return readFile(join(this.root.canonicalRealPath, path), "utf8");
  }

  public async run(reason: "manual" | "obsidian-event" | "schedule" | "reconciliation" = "manual"): Promise<BridgeRunSummary> {
    return this.worker.run({ mode: "apply", reason });
  }

  public async preview(): Promise<BridgeRunSummary> {
    return this.worker.run({ mode: "preview", reason: "manual" });
  }

  public enqueueEvent(id: string, entityId: string): void {
    this.relay.enqueue({ id, type: "page.content_updated", entityId, eventAt: this.clock.now().toISOString() });
  }
}

describe("encrypted graph publisher and local relay client", () => {
  it("publishes one encrypted snapshot, skips an unchanged run, and acknowledges after reconciliation", async () => {
    const clock = new TestClock();
    const relay = new MemoryRelay(clock);
    const source = new RelayEventSource(relay.client());
    const publisher = new GraphPublisher({ sink: new RelaySnapshotSink(relay.client()), nonceSource: new SequenceNonces() });

    const first = await publisher.publishIfChanged({ projection: projection(), state: initialGraphState(), key: GRAPH_KEY, now: clock.now().toISOString() });
    expect(first.uploaded).toBe(true);
    expect(first.state.sequence).toBe(1);
    expect(relay.snapshots).toHaveLength(1);
    await expect(decryptGraph(relay.snapshots[0] as never, GRAPH_KEY)).resolves.toMatchObject({ nodes: expect.arrayContaining([expect.objectContaining({ label: "PRIVATE BODY SENTINEL" })]) });

    const unchanged = await publisher.publishIfChanged({ projection: projection(), state: first.state, key: GRAPH_KEY, now: "2026-07-15T12:01:00.000Z" });
    expect(unchanged).toMatchObject({ uploaded: false, state: first.state });
    expect(relay.snapshots).toHaveLength(1);

    relay.enqueue({ id: EVENT_ID, type: "page.content_updated", entityId: PAGE_ID, eventAt: clock.now().toISOString() });
    const claimed = await source.claim("worker-1", 50);
    await source.acknowledge("worker-1", claimed.events.map((event) => event.id));
    expect(relay.acknowledgedEvents).toEqual([EVENT_ID]);
    expect(relay.relayPlaintext()).not.toMatch(/The Grandbox|PRIVATE BODY SENTINEL/);
  });

  it("retains graph state after failed upload, sequence conflict, and key mismatch", async () => {
    const clock = new TestClock();
    const relay = new MemoryRelay(clock);
    const publisher = new GraphPublisher({ sink: new RelaySnapshotSink(relay.client()), nonceSource: new SequenceNonces() });
    const initial = initialGraphState();

    relay.rejectSnapshotStatus = 503;
    await expect(publisher.publishIfChanged({ projection: projection(), state: initial, key: GRAPH_KEY, now: clock.now().toISOString() })).rejects.toThrow();
    expect(relay.snapshots).toEqual([]);
    expect(initial).toEqual(initialGraphState());

    relay.rejectSnapshotStatus = null;
    const stored = await publisher.publishIfChanged({ projection: projection(), state: initial, key: GRAPH_KEY, now: clock.now().toISOString() });
    relay.rejectSnapshotStatus = 409;
    await expect(publisher.publishIfChanged({ projection: projection("changed"), state: stored.state, key: GRAPH_KEY, now: "2026-07-15T12:02:00.000Z" })).rejects.toThrow();
    expect(stored.state.sequence).toBe(1);
    expect(stored.state.projectionHash).not.toBeNull();

    relay.rejectSnapshotStatus = null;
    relay.expectedKeyId = "another-key";
    await expect(publisher.publishIfChanged({ projection: projection("changed"), state: stored.state, key: GRAPH_KEY, now: "2026-07-15T12:03:00.000Z" })).rejects.toThrow();
    expect(relay.snapshots).toHaveLength(1);
  });

  it("uses distinct nonces for distinct projection revisions", async () => {
    const clock = new TestClock();
    const relay = new MemoryRelay(clock);
    const publisher = new GraphPublisher({ sink: new RelaySnapshotSink(relay.client()), nonceSource: new SequenceNonces() });
    const first = await publisher.publishIfChanged({ projection: projection(), state: initialGraphState(), key: GRAPH_KEY, now: clock.now().toISOString() });
    const second = await publisher.publishIfChanged({ projection: projection("changed"), state: first.state, key: GRAPH_KEY, now: "2026-07-15T12:02:00.000Z" });

    expect(second.state.sequence).toBe(2);
    expect(relay.snapshots.map((snapshot) => snapshot.nonce)).toEqual([base64url(new Uint8Array(12).fill(1)), base64url(new Uint8Array(12).fill(2))]);
  });

  it("rejects an invalid retained graph state before treating a projection as unchanged", async () => {
    const clock = new TestClock();
    const relay = new MemoryRelay(clock);
    const publisher = new GraphPublisher({ sink: new RelaySnapshotSink(relay.client()), nonceSource: new SequenceNonces() });
    const hash = (await publisher.publishIfChanged({ projection: projection(), state: initialGraphState(), key: GRAPH_KEY, now: clock.now().toISOString() })).state.projectionHash;

    await expect(publisher.publishIfChanged({
      projection: projection(),
      state: { ...initialGraphState(), projectionHash: hash, sequence: Number.MAX_SAFE_INTEGER },
      key: GRAPH_KEY,
      now: clock.now().toISOString(),
    })).rejects.toThrow("Invalid graph publish state");
  });

  it("retries bounded relay responses, honors Retry-After, and leaves expired leases unacknowledged", async () => {
    const clock = new TestClock();
    const relay = new MemoryRelay(clock);
    relay.claimResponses.push(empty(429, { "retry-after": "2" }));
    relay.enqueue({ id: EVENT_ID, type: "page.content_updated", entityId: PAGE_ID, eventAt: clock.now().toISOString() });
    const source = new RelayEventSource(relay.client());

    const claimed = await source.claim("worker-1", 50);
    expect(claimed.events.map((event) => event.id)).toEqual([EVENT_ID]);
    expect(clock.sleeps).toEqual([2_000]);
    clock.advance(60_001);
    await expect(source.acknowledge("worker-1", [EVENT_ID])).rejects.toThrow();
    expect(relay.acknowledgedEvents).toEqual([]);
  });

  it("honors a server Retry-After beyond one HTTP attempt deadline", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = new RelayClient({
        baseUrl: "https://relay.example.test",
        token: ACTIVE_TOKEN,
        clock: {
          now: () => new Date("2026-07-15T12:00:00.000Z"),
          sleep: async (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        },
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? empty(429, { "retry-after": "60" })
            : json({ events: [], leaseSeconds: 60 });
        },
      });
      let result: unknown = null;
      let failure: unknown = null;
      void client.claimEvents("worker-1", 1).then(
        (claim) => { result = claim; },
        (caught: unknown) => { failure = caught; },
      );

      await vi.advanceTimersByTimeAsync(5_001);
      expect(failure).toBeNull();
      expect(result).toBeNull();

      await vi.advanceTimersByTimeAsync(55_000);
      expect(failure).toBeNull();
      expect(result).toMatchObject({ events: [], leaseSeconds: 60 });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses an authorization header only and refuses insecure remote relay URLs", async () => {
    const clock = new TestClock();
    const relay = new MemoryRelay(clock);
    relay.enqueue({ id: EVENT_ID, type: "page.content_updated", entityId: PAGE_ID, eventAt: clock.now().toISOString() });

    await relay.client().claimEvents("worker-1", 1);

    expect(relay.requests[0]).toMatchObject({
      pathname: "/v1/events/claim",
      authorization: `Bearer ${ACTIVE_TOKEN}`,
    });
    expect(relay.requests[0]?.pathname).not.toContain(ACTIVE_TOKEN);
    expect(() => new RelayClient({ baseUrl: "http://relay.example.test", token: ACTIVE_TOKEN })).toThrow();
    expect(() => new RelayClient({ baseUrl: `https://relay.example.test/?token=${ACTIVE_TOKEN}`, token: ACTIVE_TOKEN })).toThrow();
  });

  it("enforces the five-second deadline while a relay response body is still pending", async () => {
    vi.useFakeTimers();
    try {
      const neverEndingBody = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
      let calls = 0;
      let firstSignal: AbortSignal | null = null;
      const client = new RelayClient({
        baseUrl: "https://relay.example.test",
        token: ACTIVE_TOKEN,
        jitter: { delayMs: () => 0 },
        fetch: async (_input, init) => {
          calls += 1;
          if (calls === 1) {
            firstSignal = init?.signal instanceof AbortSignal ? init.signal : null;
            return new Response(neverEndingBody, { status: 200, headers: { "content-type": "application/json" } });
          }
          return empty(400);
        },
      });
      let failure: unknown = null;
      void client.claimEvents("worker-1", 1).then(
        () => { failure = new Error("claim unexpectedly resolved"); },
        (caught: unknown) => { failure = caught; },
      );

      await vi.advanceTimersByTimeAsync(5_001);

      expect(firstSignal?.aborted).toBe(true);
      expect(calls).toBe(2);
      expect(failure).toMatchObject({ code: "invalid-response", retryable: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers and unregisters pages without passing note bodies through the relay", async () => {
    const clock = new TestClock();
    const relay = new MemoryRelay(clock);
    const source = new RelayEventSource(relay.client());

    await source.register(PAGE_ID, BLOCK_ID);
    expect(relay.registrations.get(PAGE_ID)).toBe(BLOCK_ID);
    await source.unregister(PAGE_ID, BLOCK_ID);
    expect(relay.registrations.has(PAGE_ID)).toBe(false);
    expect(relay.relayPlaintext()).not.toMatch(/The Grandbox|PRIVATE BODY SENTINEL/);
  });

  it("rotates through the pending Keychain slot and recovers a crash after relay commit", async () => {
    const clock = new TestClock();
    const relay = new MemoryRelay(clock);
    const credentials = new MemoryCredentials();
    await rotateRelayToken({ credentials, clients: relay.factory(), nextToken: NEXT_TOKEN });
    expect(await credentials.get("relay-token")).toBe(NEXT_TOKEN);
    expect(await credentials.get("relay-token-pending")).toBeNull();
    expect(relay.activeToken).toBe(NEXT_TOKEN);

    const crashed = new MemoryCredentials(ACTIVE_TOKEN, NEXT_TOKEN);
    relay.activeToken = NEXT_TOKEN;
    relay.pendingToken = null;
    const recovery = await recoverPendingRelayTokenRotation({ credentials: crashed, clients: relay.factory() });
    expect(recovery).toBe("recovered");
    expect(await crashed.get("relay-token")).toBe(NEXT_TOKEN);
    expect(await crashed.get("relay-token-pending")).toBeNull();
  });

  it("accepts nested and unrelated event IDs as opaque relay metadata", async () => {
    const clock = new TestClock();
    const relay = new MemoryRelay(clock);
    relay.enqueue({ id: EVENT_ID, type: "page.content_updated", entityId: BLOCK_ID, eventAt: clock.now().toISOString() });
    relay.enqueue({ id: UNRELATED_EVENT_ID, type: "page.content_updated", entityId: NESTED_BLOCK_ID, eventAt: clock.now().toISOString() });
    const source = new RelayEventSource(relay.client());
    const claimed = await source.claim("worker-1", 50);

    expect(claimed.events.map((event) => event.entityId)).toEqual([BLOCK_ID, NESTED_BLOCK_ID]);
    expect(relay.relayPlaintext()).not.toMatch(/The Grandbox|PRIVATE BODY SENTINEL/);
  });
});

describe("worker graph relay orchestration", () => {
  it("publishes one encrypted snapshot, skips an unchanged run, and acknowledges after reconciliation", async () => {
    const harness = await WorkerGraphHarness.create();
    await harness.write("Private.md", optedIn("PRIVATE BODY SENTINEL\n"));

    expect((await harness.run()).graphUploads).toBe(1);
    expect((await harness.run()).graphUploads).toBe(0);
    harness.enqueueEvent(EVENT_ID, PAGE_ID);
    await harness.run();

    expect(harness.relay.acknowledgedEvents).toEqual([EVENT_ID]);
    expect(harness.relay.registrations.has(PAGE_ID)).toBe(true);
    expect(harness.journal.begun.some((intent) => intent.effectKind === "register-relay-page")).toBe(true);
    expect(harness.relay.relayPlaintext()).not.toMatch(/The Grandbox|PRIVATE BODY SENTINEL/);
  });

  it("retains changed graph state after a failed upload and retries it with a fresh nonce", async () => {
    const harness = await WorkerGraphHarness.create();
    await harness.write("Private.md", optedIn("first revision\n"));
    await harness.run();
    const before = structuredClone(harness.state.value.graph);
    const beforeNonce = harness.relay.snapshots.at(-1)?.nonce;
    await harness.write("Private.md", "---\nnotion_sync: true\ntags: [changed, private]\n---\nsecond revision\n");
    harness.relay.rejectSnapshotStatus = 409;

    const failed = await harness.run();

    expect(failed.graphUploads).toBe(0);
    expect(harness.state.value.graph).toEqual(before);
    harness.relay.rejectSnapshotStatus = null;
    expect((await harness.run()).graphUploads).toBe(1);
    expect(harness.relay.snapshots.at(-1)?.nonce).not.toBe(beforeNonce);
  });

  it("resolves at most sixteen opaque nested parent hops, acknowledges unrelated entities, and leaves a Notion failure leased", async () => {
    const harness = await WorkerGraphHarness.create();
    await harness.write("Private.md", optedIn("paired\n"));
    await harness.run();
    harness.notion.setEventParent(BLOCK_ID, NESTED_BLOCK_ID);
    harness.notion.setEventParent(NESTED_BLOCK_ID, PAGE_ID);
    harness.enqueueEvent(EVENT_ID, BLOCK_ID);
    harness.enqueueEvent(UNRELATED_EVENT_ID, "77777777-7777-4777-8777-777777777777");

    await harness.run();

    expect(harness.relay.acknowledgedEvents).toEqual([EVENT_ID, UNRELATED_EVENT_ID]);
    const failingEvent = "88888888-8888-4888-8888-888888888888";
    harness.notion.failEventResolution = true;
    harness.enqueueEvent(failingEvent, BLOCK_ID);
    const failed = await harness.run();
    expect(failed.outcome).toBe("failed");
    expect(harness.relay.acknowledgedEvents).not.toContain(failingEvent);
    harness.notion.failEventResolution = false;
    harness.clock.advance(60_001);
    await harness.run();
    expect(harness.relay.acknowledgedEvents).toContain(failingEvent);
  });

  it("unregisters a detached page only after local opt-out classification", async () => {
    const harness = await WorkerGraphHarness.create();
    await harness.write("Private.md", optedIn("paired\n"));
    await harness.run();
    expect(harness.relay.registrations.has(PAGE_ID)).toBe(true);
    const paired = await harness.read("Private.md");
    const bridgeId = /^bridge_id:\s*([^\r\n]+)$/mu.exec(paired)?.[1];
    expect(bridgeId).toMatch(/^[0-9a-f-]{36}$/u);
    await harness.write("Private.md", `---\nnotion_sync: false\nbridge_id: ${bridgeId}\ntags: [private]\n---\nstill local and never deleted\n`);

    await harness.run();

    expect(Object.values(harness.state.value.pairs)).toContainEqual(expect.objectContaining({ status: "detached" }));
    expect(harness.relay.registrations.has(PAGE_ID)).toBe(false);
    expect(harness.journal.begun.some((intent) => intent.effectKind === "unregister-relay-page")).toBe(true);
    await expect(harness.read("Private.md")).resolves.toContain("still local and never deleted");
  });

  it("keeps an already registered page through a non-detached missing-local state", async () => {
    const harness = await WorkerGraphHarness.create();
    await harness.write("Private.md", optedIn("paired\n"));
    await harness.run();
    expect(harness.relay.registrations.has(PAGE_ID)).toBe(true);

    await unlink(join(harness.root.canonicalRealPath, "Private.md"));
    await harness.run();

    expect(Object.values(harness.state.value.pairs)).toContainEqual(expect.objectContaining({ status: "missing-local" }));
    expect(harness.relay.registrations.has(PAGE_ID)).toBe(true);
    expect(harness.journal.begun.some((intent) => intent.effectKind === "unregister-relay-page")).toBe(false);
  });

  it("bounds partial reconciliation while the daily pass still observes every persisted pair", async () => {
    const harness = await WorkerGraphHarness.create();
    await Promise.all([
      harness.write("A.md", optedIn("A\n")),
      harness.write("B.md", optedIn("B\n")),
      harness.write("C.md", optedIn("C\n")),
      harness.write("D.md", optedIn("D\n")),
    ]);
    await harness.run();

    const retrieve = vi.spyOn(harness.notion, "retrievePage");
    await harness.run();
    expect(retrieve).toHaveBeenCalledTimes(3);

    retrieve.mockClear();
    harness.clock.advance(24 * 60 * 60 * 1_000 + 1);
    await harness.run();
    expect(retrieve).toHaveBeenCalledTimes(4);
  });

  it("leaves matching relay events leased when their pair falls outside the partial reconciliation budget", async () => {
    const harness = await WorkerGraphHarness.create();
    await Promise.all([
      harness.write("A.md", optedIn("A\n")),
      harness.write("B.md", optedIn("B\n")),
      harness.write("C.md", optedIn("C\n")),
      harness.write("D.md", optedIn("D\n")),
    ]);
    await harness.run();
    const pairs = Object.values(harness.state.value.pairs)
      .sort((left, right) => left.localPath.localeCompare(right.localPath));
    const events = pairs.map((pair) => ({ id: randomUUID(), pageId: pair.notionPageId }));
    for (const event of events) harness.enqueueEvent(event.id, event.pageId);

    await harness.run();

    expect(harness.relay.acknowledgedEvents).toHaveLength(3);
    expect(harness.relay.acknowledgedEvents).not.toContain(events[3]?.id);
  });

  it("defers a prioritized moved pair when bounded discovery cannot prove its local absence", async () => {
    const harness = await WorkerGraphHarness.create();
    await Promise.all([
      harness.write("A.md", optedIn("A\n")),
      harness.write("B.md", optedIn("B\n")),
      harness.write("C.md", optedIn("C\n")),
      harness.write("Z.md", optedIn("Z\n")),
    ]);
    await harness.run();
    const moved = Object.values(harness.state.value.pairs).find((pair) => pair.localPath === "Z.md");
    expect(moved).toBeDefined();
    if (moved === undefined) throw new Error("expected the initially synchronized Z.md pair");
    const eventId = randomUUID();
    await rename(
      join(harness.root.canonicalRealPath, "Z.md"),
      join(harness.root.canonicalRealPath, "ZZ moved.md"),
    );
    harness.enqueueEvent(eventId, moved.notionPageId);

    await harness.run();

    const movedState = harness.state.value.pairs[moved.bridgeId];
    expect(movedState).toMatchObject({ status: "synced" });
    expect(["Z.md", "ZZ moved.md"]).toContain(movedState?.localPath);
  });

  it("defers graph publication rather than uploading a truncated partial discovery", async () => {
    const harness = await WorkerGraphHarness.create();
    await Promise.all([
      harness.write("A.md", optedIn("A\n")),
      harness.write("B.md", optedIn("B\n")),
      harness.write("C.md", optedIn("C\n")),
      harness.write("D.md", optedIn("D\n")),
    ]);
    await harness.run();
    const before = structuredClone(harness.state.value.graph);
    const paired = await harness.read("A.md");
    const bridgeId = /^bridge_id:\s*([^\r\n]+)$/mu.exec(paired)?.[1];
    expect(bridgeId).toMatch(/^[0-9a-f-]{36}$/u);
    await harness.write("A.md", `---\nnotion_sync: true\nbridge_id: ${bridgeId}\ntags: [changed]\n---\nA revised\n`);

    const partial = await harness.run();

    expect(partial.graphUploads).toBe(0);
    expect(harness.state.value.graph).toEqual(before);
    harness.clock.advance(24 * 60 * 60 * 1_000 + 1);
    expect((await harness.run()).graphUploads).toBe(1);
  });

  it("advances daily full-reconciliation state only after complete success and keeps preview mutation-free", async () => {
    const harness = await WorkerGraphHarness.create();
    await harness.write("Private.md", optedIn("paired\n"));
    const beforePreviewState = structuredClone(harness.state.value);
    const beforePreviewRequests = harness.relay.requests.length;

    const preview = await harness.preview();

    expect(preview.mode).toBe("preview");
    expect(harness.state.value).toEqual(beforePreviewState);
    expect(harness.relay.requests).toHaveLength(beforePreviewRequests);
    await harness.run();
    const firstFull = harness.state.value.lastFullReconciliationAt;
    expect(firstFull).not.toBeNull();
    harness.clock.advance(23 * 60 * 60 * 1_000);
    await harness.run();
    expect(harness.state.value.lastFullReconciliationAt).toBe(firstFull);
    harness.clock.advance(60 * 60 * 1_000 + 1);
    await harness.run();
    expect(harness.state.value.lastFullReconciliationAt).not.toBe(firstFull);
  });

  it("does not claim events, publish, pair, or save state when either provider preflight fails", async () => {
    const notionFailure = await WorkerGraphHarness.create();
    await notionFailure.write("Private.md", optedIn("blocked\n"));
    notionFailure.notion.verifyFails = true;

    const failedNotion = await notionFailure.run();

    expect(failedNotion.outcome).toBe("failed");
    expect(notionFailure.relay.requests).toEqual([]);
    expect(notionFailure.state.saves).toBe(0);
    expect(notionFailure.notion.creates).toBe(0);

    const relayFailure = await WorkerGraphHarness.create();
    await relayFailure.write("Private.md", optedIn("blocked\n"));
    relayFailure.relay.activeToken = NEXT_TOKEN;
    const failedRelay = await relayFailure.run();
    expect(failedRelay.outcome).toBe("failed");
    expect(relayFailure.state.saves).toBe(0);
    expect(relayFailure.notion.creates).toBe(0);
  });
});
