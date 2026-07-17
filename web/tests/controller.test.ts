import { describe, expect, it } from "vitest";
import { encryptGraph, type GraphEnvelopeV1, type GraphProjectionV1 } from "@grandbox-bridge/shared";
import {
  GraphAppController,
  type AppView,
  type GraphRendererHandle,
  type GraphRendererFactory,
} from "../src/app/controller.ts";
import type { PairingCandidate } from "../src/pairing/controller.ts";
import type { SnapshotSource } from "../src/api/snapshot-client.ts";
import type { PairingStore, StoredPairing } from "../src/storage/pairing-store.ts";

const GRAPH_ID = "844d93be-86f1-47ea-a98c-9c56ee81e027";
const INSTALLATION_ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const CREATED_AT = "2026-07-15T12:00:00.000Z";

describe("GraphAppController", () => {
  it("renders a canonical route in its locked state without a graph", () => {
    const frames: Parameters<AppView["render"]>[] = [];
    const controller = new GraphAppController({ render: (...frame) => frames.push(frame) });

    controller.start("/g/844d93be-86f1-47ea-a98c-9c56ee81e027");

    expect(frames).toEqual([
      [
        { kind: "locked", reason: "unpaired" },
        { graphId: "844d93be-86f1-47ea-a98c-9c56ee81e027" },
      ],
    ]);
  });

  it("surfaces an invalid route as a bounded safe error", () => {
    const frames: Parameters<AppView["render"]>[] = [];
    const controller = new GraphAppController({ render: (...frame) => frames.push(frame) });

    controller.start("/g/../admin");

    expect(frames).toEqual([
      [
        { kind: "error", code: "invalid-route", retryable: false, retained: null },
        null,
      ],
    ]);
  });
});

function graphFixture(): GraphProjectionV1 {
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
        id: "note:paired",
        label: "Paired note",
        path: "Research/Paired.md",
        kind: "note",
        domain: "research",
        tags: ["research"],
        notionUrl: "https://www.notion.so/2fba54e969b84ab28bca9487f960834b",
        obsidianUrl: "obsidian://open?vault=The%20Grandbox&file=Research%2FPaired.md",
        collapsed: false,
      },
    ],
    edges: [{ id: "edge:vault:paired", source: "vault:root", target: "note:paired", kind: "vault" }],
    conflicts: 0,
  };
}

async function envelope(sequence = 42): Promise<GraphEnvelopeV1> {
  return encryptGraph({
    projection: graphFixture(),
    key: KEY,
    installationId: INSTALLATION_ID,
    keyId: "fixture-key",
    sequence,
    createdAt: CREATED_AT,
    nonce: Uint8Array.from({ length: 12 }, (_, index) => index + sequence),
  });
}

function candidate(): PairingCandidate {
  return { graphId: GRAPH_ID, keyId: "fixture-key", keyBytes: KEY };
}

class MemoryPairingStore implements PairingStore {
  public record: StoredPairing | null = null;

  public async get(): Promise<StoredPairing | null> {
    return this.record;
  }

  public async commitVerifiedPairing(record: StoredPairing): Promise<void> {
    this.record = record;
  }

  public async acceptSequence(_graphId: string, keyId: string, sequence: number): Promise<"accepted" | "same" | "rollback" | "rotated"> {
    if (this.record === null || this.record.keyId !== keyId) return "rotated";
    if (sequence < this.record.highestAcceptedSequence) return "rollback";
    if (sequence === this.record.highestAcceptedSequence) return "same";
    this.record = { ...this.record, highestAcceptedSequence: sequence };
    return "accepted";
  }

  public async forget(): Promise<void> {
    this.record = null;
  }

  public async getTheme(): Promise<"light" | "dark" | null> {
    return null;
  }

  public async setTheme(): Promise<void> {}
}

class QueuedSnapshotSource implements SnapshotSource {
  public constructor(private readonly envelopes: GraphEnvelopeV1[]) {}

  public async getLatest(): Promise<GraphEnvelopeV1> {
    const next = this.envelopes.shift();
    if (next === undefined) throw new Error("No fixture envelope available");
    return next;
  }
}

class RecordingRenderer implements GraphRendererHandle {
  public readonly replacements: string[] = [];
  public destroyCalls = 0;

  public replace(graph: { readonly nodes: readonly { readonly id: string }[] }): void {
    this.replacements.push(graph.nodes.map((node) => node.id).join(","));
  }

  public destroy(): void {
    this.destroyCalls += 1;
  }
}

describe("GraphAppController refresh lifecycle", () => {
  it("renders only a verified snapshot after pairing", async () => {
    const frames: Parameters<AppView["render"]>[] = [];
    const renderer = new RecordingRenderer();
    const rendererFactory: GraphRendererFactory = { create: () => renderer };
    const controller = new GraphAppController(
      { render: (...frame) => frames.push(frame) },
      { snapshotSource: new QueuedSnapshotSource([await envelope()]), pairingStore: new MemoryPairingStore(), rendererFactory },
    );
    controller.start(`/g/${GRAPH_ID}`);

    await controller.acceptPairing(candidate());

    expect(controller.state).toMatchObject({ kind: "ready", sequence: 42 });
    expect(renderer.replacements).toEqual(["note:paired,vault:root"]);
    expect(frames.at(-1)?.[0]).toMatchObject({ kind: "ready" });
  });

  it("retains an already verified graph after a rollback response", async () => {
    const renderer = new RecordingRenderer();
    const controller = new GraphAppController(
      { render: () => undefined },
      {
        snapshotSource: new QueuedSnapshotSource([await envelope(42), await envelope(41)]),
        pairingStore: new MemoryPairingStore(),
        rendererFactory: { create: () => renderer },
      },
    );
    controller.start(`/g/${GRAPH_ID}`);
    await controller.acceptPairing(candidate());
    await controller.refresh();

    expect(controller.state).toMatchObject({ kind: "error", code: "rollback-rejected", retained: expect.any(Object) });
    expect(renderer.replacements).toHaveLength(1);
    expect(renderer.destroyCalls).toBe(0);
  });

  it("forgets the pairing and destroys the plaintext renderer", async () => {
    const store = new MemoryPairingStore();
    const renderer = new RecordingRenderer();
    const controller = new GraphAppController(
      { render: () => undefined },
      {
        snapshotSource: new QueuedSnapshotSource([await envelope()]),
        pairingStore: store,
        rendererFactory: { create: () => renderer },
      },
    );
    controller.start(`/g/${GRAPH_ID}`);
    await controller.acceptPairing(candidate());
    await controller.forget();

    expect(store.record).toBeNull();
    expect(renderer.destroyCalls).toBe(1);
    expect(controller.state).toEqual({ kind: "locked", reason: "forgotten" });
  });
});
