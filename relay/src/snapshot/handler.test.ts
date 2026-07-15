import { describe, expect, it } from "vitest";
import type { GraphEnvelopeV1 } from "@grandbox-bridge/shared";
import {
  SnapshotRepository,
  type GraphPublicRead,
  type GraphSnapshotRecord,
  type SnapshotRepositoryStore,
} from "./repository.js";
import {
  handleAuthenticatedSnapshotUpload,
  handlePublicGraphRead,
  type SnapshotApiDependencies,
} from "./handler.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const GRAPH_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-15T15:00:00.000Z");

class FixtureClock {
  constructor(private current = new Date(NOW)) {}

  now(): Date {
    return new Date(this.current);
  }

  set(value: Date): void {
    this.current = new Date(value);
  }
}

class MemorySnapshotStore implements SnapshotRepositoryStore {
  private readonly snapshotsByInstallation = new Map<string, GraphSnapshotRecord>();
  private readonly snapshotsByGraph = new Map<string, GraphSnapshotRecord>();
  private readonly graphRates = new Map<string, { readonly count: number; readonly windowStartedAt: string }>();

  async compareAndSetSnapshot(input: {
    readonly installationId: string;
    readonly expectedSequence: number;
    readonly next: GraphSnapshotRecord;
  }): Promise<boolean> {
    const existingForInstallation = this.snapshotsByInstallation.get(input.installationId);
    const existingForGraph = this.snapshotsByGraph.get(input.next.graphId);
    if (
      (existingForInstallation?.sequence ?? 0) !== input.expectedSequence ||
      (existingForGraph !== undefined && existingForGraph.installationId !== input.installationId)
    ) {
      return false;
    }
    this.snapshotsByInstallation.set(input.installationId, input.next);
    this.snapshotsByGraph.set(input.next.graphId, input.next);
    return true;
  }

  async storeSnapshotIfNewer(input: { readonly installationId: string; readonly next: GraphSnapshotRecord }): Promise<boolean> {
    const existingForInstallation = this.snapshotsByInstallation.get(input.installationId);
    const existingForGraph = this.snapshotsByGraph.get(input.next.graphId);
    if (
      (existingForInstallation?.sequence ?? 0) >= input.next.sequence ||
      (existingForGraph !== undefined && existingForGraph.installationId !== input.installationId)
    ) {
      return false;
    }
    this.snapshotsByInstallation.set(input.installationId, input.next);
    this.snapshotsByGraph.set(input.next.graphId, input.next);
    return true;
  }

  async readSnapshot(installationId: string): Promise<GraphSnapshotRecord | null> {
    return this.snapshotsByInstallation.get(installationId) ?? null;
  }

  async readPublicSnapshot(input: {
    readonly graphId: string;
    readonly now: Date;
    readonly limit: number;
    readonly windowSeconds: number;
  }): Promise<GraphPublicRead> {
    const snapshot = this.snapshotsByGraph.get(input.graphId) ?? null;
    const previous = this.graphRates.get(input.graphId);
    const previousTime = previous === undefined ? Number.NaN : new Date(previous.windowStartedAt).getTime();
    const windowExpired = !Number.isFinite(previousTime) || input.now.getTime() - previousTime >= input.windowSeconds * 1_000;
    const current = windowExpired
      ? { count: 0, windowStartedAt: input.now.toISOString() }
      : previous;
    if (current.count >= input.limit) {
      return { allowed: false, windowStartedAt: current.windowStartedAt, snapshot: null };
    }
    this.graphRates.set(input.graphId, { count: current.count + 1, windowStartedAt: current.windowStartedAt });
    return { allowed: true, windowStartedAt: current.windowStartedAt, snapshot };
  }
}

class StrictlyNewerOnlyStore implements SnapshotRepositoryStore {
  exactCompareCalls = 0;
  strictlyNewerCalls = 0;
  private snapshot: GraphSnapshotRecord | null = null;

  async compareAndSetSnapshot(): Promise<boolean> {
    this.exactCompareCalls += 1;
    return false;
  }

  async storeSnapshotIfNewer(input: { readonly installationId: string; readonly next: GraphSnapshotRecord }): Promise<boolean> {
    this.strictlyNewerCalls += 1;
    if (input.next.graphId !== GRAPH_ID || input.next.installationId !== input.installationId || (this.snapshot?.sequence ?? 0) >= input.next.sequence) {
      return false;
    }
    this.snapshot = input.next;
    return true;
  }

  async readSnapshot(): Promise<GraphSnapshotRecord | null> {
    return this.snapshot;
  }

  async readPublicSnapshot(input: {
    readonly graphId: string;
    readonly now: Date;
    readonly limit: number;
    readonly windowSeconds: number;
  }): Promise<GraphPublicRead> {
    return { allowed: true, windowStartedAt: input.now.toISOString(), snapshot: input.graphId === GRAPH_ID ? this.snapshot : null };
  }
}

function envelope(sequence: number): GraphEnvelopeV1 {
  return {
    version: 1,
    algorithm: "A256GCM",
    installationId: INSTALLATION_ID,
    keyId: "fixture-key",
    sequence,
    createdAt: NOW.toISOString(),
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AQIDBAUGBwgJCgsMDQ4PEA",
  };
}

function fixture(): { readonly deps: SnapshotApiDependencies; readonly clock: FixtureClock } {
  const clock = new FixtureClock();
  return {
    clock,
    deps: {
      snapshots: new SnapshotRepository(new MemorySnapshotStore()),
      clock,
      log: { write: () => undefined },
    },
  };
}

function uploadSnapshot(
  value: unknown,
  deps: SnapshotApiDependencies,
  options: { readonly contentLength?: string; readonly contentType?: string } = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": options.contentType ?? "application/json" });
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  return handleAuthenticatedSnapshotUpload(
    new Request("https://relay.fixture.invalid/v1/snapshot", {
      method: "PUT",
      headers,
      body: JSON.stringify(value),
    }),
    { installationId: INSTALLATION_ID, graphId: GRAPH_ID },
    deps,
  );
}

function readSnapshot(graphId: string, deps: SnapshotApiDependencies): Promise<Response> {
  return handlePublicGraphRead(new Request(`https://relay.fixture.invalid/v1/graph/${graphId}`), graphId, deps);
}

describe("graph snapshot API", () => {
  it("uses the strictly-newer atomic primitive for an initial high sequence", async () => {
    const store = new StrictlyNewerOnlyStore();
    const snapshots = new SnapshotRepository(store);

    await expect(snapshots.storeIfNewer(INSTALLATION_ID, { graphId: GRAPH_ID, envelope: envelope(7) })).resolves.toMatchObject({ sequence: 7 });
    expect(store.strictlyNewerCalls).toBe(1);
    expect(store.exactCompareCalls).toBe(0);
  });

  it("accepts only a strictly newer sequence and serves only the encrypted envelope", async () => {
    const { deps } = fixture();
    const envelope7 = envelope(7);

    expect((await uploadSnapshot(envelope7, deps)).status).toBe(201);
    expect((await uploadSnapshot(envelope7, deps)).status).toBe(409);
    expect((await uploadSnapshot({ ...envelope7, sequence: 6 }, deps)).status).toBe(409);

    const response = await readSnapshot(GRAPH_ID, deps);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(text).not.toMatch(/The Grandbox|Repositories|notion\.so/i);
    expect(JSON.parse(text)).toEqual(envelope7);
  });

  it("binds a snapshot envelope to the authenticated installation and rejects malformed or oversized input", async () => {
    const { deps } = fixture();

    expect((await uploadSnapshot({ ...envelope(1), installationId: "33333333-3333-4333-8333-333333333333" }, deps)).status).toBe(400);
    expect((await uploadSnapshot({ body: "private note body" }, deps)).status).toBe(400);
    expect((await uploadSnapshot(envelope(1), deps, { contentLength: String(8 * 1024 * 1024 + 1) })).status).toBe(413);
    expect((await uploadSnapshot(envelope(1), deps, { contentType: "text/plain" })).status).toBe(415);
  });

  it("limits public graph reads before returning ciphertext and recovers on the next fixed window", async () => {
    const { deps, clock } = fixture();
    expect((await uploadSnapshot(envelope(1), deps)).status).toBe(201);

    const reads = await Promise.all(Array.from({ length: 60 }, () => readSnapshot(GRAPH_ID, deps)));
    expect(reads.every((response) => response.status === 200)).toBe(true);
    const limited = await readSnapshot(GRAPH_ID, deps);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    const absent = await readSnapshot("33333333-3333-4333-8333-333333333333", deps);
    expect(absent.status).toBe(404);
    expect(absent.headers.get("cache-control")).toBe("no-store");

    clock.set(new Date(NOW.getTime() + 61_000));
    expect((await readSnapshot(GRAPH_ID, deps)).status).toBe(200);
  });
});
