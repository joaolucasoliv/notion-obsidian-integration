import { encryptGraph, type GraphProjectionV1 } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import { decryptAndValidateGraph, GRAPH_LIMITS, GraphAcceptanceError } from "../src/crypto/decrypt.ts";
import type { PairingCandidate } from "../src/pairing/controller.ts";
import type { PairingStore, StoredPairing } from "../src/storage/pairing-store.ts";

const GRAPH_ID = "844d93be-86f1-47ea-a98c-9c56ee81e027";
const INSTALLATION_ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const WRONG_KEY = Uint8Array.from({ length: 32 }, (_, index) => 32 - index);
const NEXT_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const CREATED_AT = "2026-07-15T12:00:00.000Z";

function graphFixture(overrides: Partial<GraphProjectionV1> = {}): GraphProjectionV1 {
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
    ...overrides,
  };
}

function pairing(keyBytes = KEY): PairingCandidate {
  return { graphId: GRAPH_ID, keyId: "fixture-key", keyBytes };
}

async function envelope(
  projection = graphFixture(),
  sequence = 42,
  options: { readonly key?: Uint8Array; readonly keyId?: string } = {},
) {
  return encryptGraph({
    projection,
    key: options.key ?? KEY,
    installationId: INSTALLATION_ID,
    keyId: options.keyId ?? "fixture-key",
    sequence,
    createdAt: CREATED_AT,
    nonce: Uint8Array.from({ length: 12 }, (_, index) => index + sequence),
  });
}

class MemoryPairingStore implements PairingStore {
  public record: StoredPairing | null = null;
  public commits: StoredPairing[] = [];
  public acceptCalls: number[] = [];

  public async get(): Promise<StoredPairing | null> {
    return this.record;
  }

  public async commitVerifiedPairing(record: StoredPairing): Promise<void> {
    this.commits.push(record);
    this.record = record;
  }

  public async acceptSequence(_graphId: string, keyId: string, sequence: number): Promise<"accepted" | "same" | "rollback" | "rotated"> {
    this.acceptCalls.push(sequence);
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

describe("decryptAndValidateGraph", () => {
  it("accepts an authenticated graph before persisting its pairing sequence", async () => {
    const store = new MemoryPairingStore();

    const result = await decryptAndValidateGraph({
      envelopeInput: await envelope(),
      pairing: pairing(),
      expectedGraphId: GRAPH_ID,
      limits: GRAPH_LIMITS,
      store,
    });

    expect(result.sequence).toBe(42);
    expect(result.graph.nodes.map((node) => node.label)).toEqual(["Paired note", "The Grandbox"]);
    expect(store.commits).toEqual([
      expect.objectContaining({ graphId: GRAPH_ID, keyId: "fixture-key", highestAcceptedSequence: 42 }),
    ]);
  });

  it("renders nothing and persists nothing when authentication fails", async () => {
    const store = new MemoryPairingStore();

    await expect(
      decryptAndValidateGraph({
        envelopeInput: await envelope(),
        pairing: pairing(WRONG_KEY),
        expectedGraphId: GRAPH_ID,
        limits: GRAPH_LIMITS,
        store,
      }),
    ).rejects.toMatchObject({ safeCode: "decryption-failed" } satisfies Partial<GraphAcceptanceError>);
    expect(store.commits).toEqual([]);
    expect(store.acceptCalls).toEqual([]);
  });

  it("rejects a dangling edge before a graph can be accepted", async () => {
    const store = new MemoryPairingStore();
    const projection = graphFixture({
      edges: [{ id: "edge:dangling", source: "vault:root", target: "missing", kind: "vault" }],
    });

    await expect(
      decryptAndValidateGraph({
        envelopeInput: await envelope(projection),
        pairing: pairing(),
        expectedGraphId: GRAPH_ID,
        limits: GRAPH_LIMITS,
        store,
      }),
    ).rejects.toMatchObject({ safeCode: "invalid-graph" } satisfies Partial<GraphAcceptanceError>);
    expect(store.commits).toEqual([]);
  });

  it("rejects a lower sequence before it can replace a verified snapshot", async () => {
    const store = new MemoryPairingStore();
    store.record = {
      graphId: GRAPH_ID,
      keyId: "fixture-key",
      keyBytes: KEY,
      highestAcceptedSequence: 42,
      verifiedAt: CREATED_AT,
    };

    await expect(
      decryptAndValidateGraph({
        envelopeInput: await envelope(graphFixture(), 41),
        pairing: store.record,
        expectedGraphId: GRAPH_ID,
        limits: GRAPH_LIMITS,
        store,
      }),
    ).rejects.toMatchObject({ safeCode: "rollback-rejected" } satisfies Partial<GraphAcceptanceError>);
    expect(store.acceptCalls).toEqual([]);
  });

  it("rejects an otherwise authenticated graph with an unsafe navigation URL", async () => {
    const store = new MemoryPairingStore();
    const projection = graphFixture({
      nodes: graphFixture().nodes.map((node) => node.id === "note:paired" ? { ...node, notionUrl: "https://evil.example/secret" } : node),
    });

    await expect(
      decryptAndValidateGraph({
        envelopeInput: await envelope(projection),
        pairing: pairing(),
        expectedGraphId: GRAPH_ID,
        limits: GRAPH_LIMITS,
        store,
      }),
    ).rejects.toMatchObject({ safeCode: "invalid-graph" } satisfies Partial<GraphAcceptanceError>);
  });

  it("allows an explicit new pairing to replace a rotated local key only after verification", async () => {
    const store = new MemoryPairingStore();
    store.record = {
      graphId: GRAPH_ID,
      keyId: "fixture-key",
      keyBytes: KEY,
      highestAcceptedSequence: 42,
      verifiedAt: CREATED_AT,
    };

    await expect(
      decryptAndValidateGraph({
        envelopeInput: await envelope(graphFixture(), 1, { key: NEXT_KEY, keyId: "next-key" }),
        pairing: { graphId: GRAPH_ID, keyId: "next-key", keyBytes: NEXT_KEY },
        expectedGraphId: GRAPH_ID,
        limits: GRAPH_LIMITS,
        store,
      }),
    ).resolves.toMatchObject({ sequence: 1 });
    expect(store.record).toMatchObject({ keyId: "next-key", highestAcceptedSequence: 1 });
  });
});
