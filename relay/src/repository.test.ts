import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  EventRepository,
  type EventRepositoryStore,
  type RateCounterName,
  type RateCounterState,
  type StoredWebhookEvent,
  type WebhookEventInput,
} from "./queue/repository.js";
import {
  SnapshotRepository,
  type GraphSnapshotInput,
  type GraphSnapshotRecord,
  type SnapshotRepositoryStore,
} from "./snapshot/repository.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const NOTION_PAGE_ID = "33333333-3333-4333-8333-333333333333";
const BRIDGE_ID = "44444444-4444-4444-8444-444444444444";
const EVENT: WebhookEventInput = {
  id: "55555555-5555-4555-8555-555555555555",
  type: "page.updated",
  entityId: NOTION_PAGE_ID,
  eventAt: "2026-07-15T12:00:00.000Z",
};
const NOW = new Date("2026-07-15T12:00:00.000Z");

function plusSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1_000);
}

function plusDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function eventKey(installationId: string, eventId: string): string {
  return `${installationId}:${eventId}`;
}

function counterKey(installationId: string, counter: RateCounterName): string {
  return `${installationId}:${counter}`;
}

class MemoryRelayStore implements EventRepositoryStore, SnapshotRepositoryStore {
  readonly events = new Map<string, StoredWebhookEvent>();
  readonly pages = new Map<string, { readonly installationId: string; readonly bridgeId: string }>();
  readonly bridgePages = new Map<string, string>();
  readonly counters = new Map<string, RateCounterState>();
  readonly snapshots = new Map<string, GraphSnapshotRecord>();

  async insertEventIfAbsent(event: StoredWebhookEvent): Promise<boolean> {
    const key = eventKey(event.installationId, event.id);
    if (this.events.has(key)) {
      return false;
    }
    this.events.set(key, { ...event });
    return true;
  }

  async listEvents(installationId: string): Promise<readonly StoredWebhookEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.installationId === installationId)
      .map((event) => ({ ...event }));
  }

  async compareAndSetLease(input: {
    readonly installationId: string;
    readonly eventId: string;
    readonly expectedLeaseExpiresAt: string | null;
    readonly leaseOwner: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean> {
    const event = this.events.get(eventKey(input.installationId, input.eventId));
    if (!event || event.consumedAt !== null || event.leaseExpiresAt !== input.expectedLeaseExpiresAt) {
      return false;
    }
    this.events.set(eventKey(input.installationId, input.eventId), {
      ...event,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
    });
    return true;
  }

  async compareAndSetConsumed(input: {
    readonly installationId: string;
    readonly eventId: string;
    readonly expectedLeaseOwner: string;
    readonly consumedAt: string;
  }): Promise<boolean> {
    const event = this.events.get(eventKey(input.installationId, input.eventId));
    if (!event || event.consumedAt !== null || event.leaseOwner !== input.expectedLeaseOwner) {
      return false;
    }
    this.events.set(eventKey(input.installationId, input.eventId), {
      ...event,
      consumedAt: input.consumedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    return true;
  }

  async deleteConsumedBefore(installationId: string, cutoff: string): Promise<number> {
    let deleted = 0;
    for (const [key, event] of this.events) {
      if (event.installationId === installationId && event.consumedAt !== null && event.consumedAt < cutoff) {
        this.events.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async putPageRegistration(input: {
    readonly installationId: string;
    readonly notionPageId: string;
    readonly bridgeId: string;
  }): Promise<void> {
    const pageKey = eventKey(input.installationId, input.notionPageId);
    const existingPage = this.pages.get(pageKey);
    const existingBridge = this.bridgePages.get(eventKey(input.installationId, input.bridgeId));
    if ((existingPage && existingPage.bridgeId !== input.bridgeId) || (existingBridge && existingBridge !== input.notionPageId)) {
      throw new Error("Page registration conflict");
    }
    this.pages.set(pageKey, { installationId: input.installationId, bridgeId: input.bridgeId });
    this.bridgePages.set(eventKey(input.installationId, input.bridgeId), input.notionPageId);
  }

  async findBridgeId(installationId: string, notionPageId: string): Promise<string | null> {
    return this.pages.get(eventKey(installationId, notionPageId))?.bridgeId ?? null;
  }

  async readRateCounter(installationId: string, counter: RateCounterName): Promise<RateCounterState> {
    return this.counters.get(counterKey(installationId, counter)) ?? {
      windowStartedAt: NOW.toISOString(),
      count: 0,
    };
  }

  async compareAndSetRateCounter(input: {
    readonly installationId: string;
    readonly counter: RateCounterName;
    readonly expected: RateCounterState;
    readonly next: RateCounterState;
  }): Promise<boolean> {
    const key = counterKey(input.installationId, input.counter);
    const current = this.counters.get(key) ?? {
      windowStartedAt: NOW.toISOString(),
      count: 0,
    };
    if (current.windowStartedAt !== input.expected.windowStartedAt || current.count !== input.expected.count) {
      return false;
    }
    this.counters.set(key, { ...input.next });
    return true;
  }

  async compareAndSetSnapshot(input: {
    readonly installationId: string;
    readonly expectedSequence: number;
    readonly next: GraphSnapshotRecord;
  }): Promise<boolean> {
    const current = this.snapshots.get(input.installationId);
    const sequence = current?.sequence ?? 0;
    if (sequence !== input.expectedSequence) {
      return false;
    }
    this.snapshots.set(input.installationId, { ...input.next });
    return true;
  }

  async readSnapshot(installationId: string): Promise<GraphSnapshotRecord | null> {
    const current = this.snapshots.get(installationId);
    return current ? { ...current } : null;
  }
}

function repositoryHarness() {
  const store = new MemoryRelayStore();
  return {
    store,
    events: new EventRepository(store),
    snapshots: new SnapshotRepository(store),
  };
}

const GRAPH_ID = "66666666-6666-4666-8666-666666666666";
const CIPHERTEXT = "AQIDBAUGBwgJCgsMDQ4PEA";
const NEXT_CIPHERTEXT = "ERITFBUWFxgZGhscHR4fIA";

function graphEnvelope(
  installationId = INSTALLATION_ID,
  sequence = 1,
  ciphertext = CIPHERTEXT,
): Record<string, unknown> {
  return {
    version: 1,
    algorithm: "A256GCM",
    installationId,
    keyId: "key-2026-07",
    sequence,
    createdAt: NOW.toISOString(),
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext,
  };
}

function snapshotInput(envelope = graphEnvelope()): GraphSnapshotInput {
  return {
    graphId: GRAPH_ID,
    // Legacy caller-supplied fields must not influence persisted metadata.
    keyId: "caller-controlled-key-id",
    byteLength: 1,
    createdAt: "2000-01-01T00:00:00.000Z",
    envelope,
  } as GraphSnapshotInput;
}

describe("relay repository contracts", () => {
  it("leases an event, requeues an expired lease, and acknowledges idempotently", async () => {
    const repo = repositoryHarness();
    await repo.events.enqueue(INSTALLATION_ID, EVENT, NOW);

    const first = await repo.events.claim(INSTALLATION_ID, "worker-a", NOW, 60);
    expect(first).toHaveLength(1);
    expect(await repo.events.claim(INSTALLATION_ID, "worker-b", plusSeconds(NOW, 30), 60)).toEqual([]);
    expect((await repo.events.claim(INSTALLATION_ID, "worker-b", plusSeconds(NOW, 61), 60))[0]?.id).toBe(EVENT.id);

    await repo.events.acknowledge(INSTALLATION_ID, EVENT.id, "worker-b", plusSeconds(NOW, 62));
    await repo.events.acknowledge(INSTALLATION_ID, EVENT.id, "worker-b", plusSeconds(NOW, 63));
  });

  it("deduplicates events within an installation without crossing installations", async () => {
    const repo = repositoryHarness();
    await expect(repo.events.enqueue(INSTALLATION_ID, EVENT, NOW)).resolves.toBe(true);
    await expect(repo.events.enqueue(INSTALLATION_ID, EVENT, plusSeconds(NOW, 1))).resolves.toBe(false);
    await expect(repo.events.enqueue(OTHER_INSTALLATION_ID, EVENT, NOW)).resolves.toBe(true);

    expect(await repo.events.claim(INSTALLATION_ID, "worker-a", NOW, 60)).toHaveLength(1);
    expect(await repo.events.claim(OTHER_INSTALLATION_ID, "worker-b", NOW, 60)).toHaveLength(1);
  });

  it("routes registered pages only inside their installation", async () => {
    const repo = repositoryHarness();
    await repo.events.registerPage(INSTALLATION_ID, NOTION_PAGE_ID, BRIDGE_ID);

    await expect(repo.events.routePage(INSTALLATION_ID, NOTION_PAGE_ID)).resolves.toBe(BRIDGE_ID);
    await expect(repo.events.routePage(OTHER_INSTALLATION_ID, NOTION_PAGE_ID)).resolves.toBeNull();
    await expect(repo.events.routePage(INSTALLATION_ID, "77777777-7777-4777-8777-777777777777")).resolves.toBeNull();
  });

  it("removes only consumed events older than the fixed 30-day retention period", async () => {
    const repo = repositoryHarness();
    await repo.events.enqueue(INSTALLATION_ID, EVENT, NOW);
    await repo.events.claim(INSTALLATION_ID, "worker-a", NOW, 60);
    await repo.events.acknowledge(INSTALLATION_ID, EVENT.id, "worker-a", NOW);
    await repo.events.enqueue(INSTALLATION_ID, { ...EVENT, id: "88888888-8888-4888-8888-888888888888" }, NOW);
    await repo.events.enqueue(OTHER_INSTALLATION_ID, EVENT, NOW);
    await repo.events.claim(OTHER_INSTALLATION_ID, "worker-b", NOW, 60);
    await repo.events.acknowledge(OTHER_INSTALLATION_ID, EVENT.id, "worker-b", NOW);

    expect(await repo.events.cleanupConsumed(INSTALLATION_ID, plusDays(NOW, 31))).toBe(1);
    expect(await repo.events.claim(INSTALLATION_ID, "worker-c", plusDays(NOW, 31), 60)).toHaveLength(1);
    expect(await repo.events.claim(OTHER_INSTALLATION_ID, "worker-d", plusDays(NOW, 31), 60)).toEqual([]);
  });

  it("uses sequence compare-and-set and returns the current installation snapshot", async () => {
    const repo = repositoryHarness();
    await expect(repo.snapshots.compareAndSet(INSTALLATION_ID, 0, snapshotInput())).resolves.toMatchObject({
      sequence: 1,
      keyId: "key-2026-07",
      byteLength: 16,
      createdAt: NOW.toISOString(),
    });
    await expect(repo.snapshots.compareAndSet(INSTALLATION_ID, 0, snapshotInput())).resolves.toBeNull();
    await expect(repo.snapshots.compareAndSet(INSTALLATION_ID, 1, snapshotInput(graphEnvelope(INSTALLATION_ID, 2, NEXT_CIPHERTEXT)))).resolves.toMatchObject({ sequence: 2 });
    await expect(repo.snapshots.current(INSTALLATION_ID)).resolves.toMatchObject({ sequence: 2, envelope: { ciphertext: NEXT_CIPHERTEXT } });
    await expect(repo.snapshots.current(OTHER_INSTALLATION_ID)).resolves.toBeNull();
  });

  it("rejects arbitrary body-like snapshot JSON before it reaches the store", async () => {
    const repo = repositoryHarness();
    await expect(repo.snapshots.compareAndSet(INSTALLATION_ID, 0, snapshotInput({ body: "PRIVATE BODY SENTINEL" }))).rejects.toThrow();
    expect(repo.store.snapshots.size).toBe(0);
  });

  it("rejects an oversized ciphertext envelope before it reaches the store", async () => {
    const repo = repositoryHarness();
    await expect(repo.snapshots.compareAndSet(
      INSTALLATION_ID,
      0,
      snapshotInput(graphEnvelope(INSTALLATION_ID, 1, "A".repeat(8 * 1024 * 1024 + 1))),
    )).rejects.toThrow();
    expect(repo.store.snapshots.size).toBe(0);
  });

  it("rejects an envelope belonging to another installation", async () => {
    const repo = repositoryHarness();
    await expect(repo.snapshots.compareAndSet(INSTALLATION_ID, 0, snapshotInput(graphEnvelope(OTHER_INSTALLATION_ID)))).rejects.toThrow(/installation/i);
    expect(repo.store.snapshots.size).toBe(0);
  });

  it("rejects an envelope whose sequence does not match the CAS request", async () => {
    const repo = repositoryHarness();
    await expect(repo.snapshots.compareAndSet(INSTALLATION_ID, 0, snapshotInput(graphEnvelope(INSTALLATION_ID, 2)))).rejects.toThrow(/sequence/i);
    expect(repo.store.snapshots.size).toBe(0);
  });

  it("revokes default execution privileges for future public-schema functions", async () => {
    const migration = await readFile(new URL("../supabase/migrations/20260714000100_bridge_relay.sql", import.meta.url), "utf8");
    expect(migration).toMatch(/alter default privileges in schema public revoke execute on functions from public;/i);
    expect(migration).toMatch(/alter default privileges in schema public revoke execute on functions from anon;/i);
    expect(migration).toMatch(/alter default privileges in schema public revoke execute on functions from authenticated;/i);
  });

  it("increments and resets aggregate rate counters atomically under concurrent requests", async () => {
    const repo = repositoryHarness();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => repo.events.incrementRateCounter(INSTALLATION_ID, "api", NOW, 10, 60)),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(results.filter((result) => !result.allowed)).toHaveLength(2);
    await expect(repo.events.incrementRateCounter(INSTALLATION_ID, "api", plusSeconds(NOW, 61), 10, 60)).resolves.toEqual({
      allowed: true,
      count: 1,
      windowStartedAt: plusSeconds(NOW, 61).toISOString(),
    });
  });

  it("rejects a non-aggregate rate counter name before any persistence operation", async () => {
    const repo = repositoryHarness();
    await expect(repo.events.incrementRateCounter(INSTALLATION_ID, "client-ip" as RateCounterName, NOW, 10, 60)).rejects.toThrow(/counter/i);
    expect(repo.store.counters.size).toBe(0);
  });
});
