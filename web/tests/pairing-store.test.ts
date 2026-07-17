import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbPairingStore, PAIRING_DATABASE_NAME, type StoredPairing } from "../src/storage/pairing-store.ts";

const GRAPH_ID = "844d93be-86f1-47ea-a98c-9c56ee81e027";
const KEY_ID = "fixture-key";
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

function pairingRecord(overrides: Partial<StoredPairing> = {}): StoredPairing {
  return {
    graphId: GRAPH_ID,
    keyId: KEY_ID,
    keyBytes: KEY,
    highestAcceptedSequence: 42,
    verifiedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function storeWithFactory(factory = new IDBFactory()): IndexedDbPairingStore {
  return new IndexedDbPairingStore(factory);
}

async function objectStoreNames(factory: IDBFactory): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = factory.open(PAIRING_DATABASE_NAME);
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("success", () => {
      const database = request.result;
      const names = Array.from(database.objectStoreNames).sort();
      database.close();
      resolve(names);
    });
  });
}

describe("IndexedDbPairingStore", () => {
  it("atomically rejects a lower sequence across concurrent tabs", async () => {
    const factory = new IDBFactory();
    const first = storeWithFactory(factory);
    const second = storeWithFactory(factory);
    await first.commitVerifiedPairing(pairingRecord());

    expect(
      await Promise.all([
        first.acceptSequence(GRAPH_ID, KEY_ID, 43),
        second.acceptSequence(GRAPH_ID, KEY_ID, 41),
      ]),
    ).toEqual(expect.arrayContaining(["accepted", "rollback"]));
    expect((await first.get(GRAPH_ID))?.highestAcceptedSequence).toBe(43);
  });

  it("persists only pairing metadata and theme across store instances", async () => {
    const factory = new IDBFactory();
    const first = storeWithFactory(factory);
    await first.commitVerifiedPairing(pairingRecord());
    await first.setTheme("dark");

    const reloaded = storeWithFactory(factory);
    expect(await reloaded.get(GRAPH_ID)).toEqual(pairingRecord());
    expect(await reloaded.getTheme()).toBe("dark");
    expect(await objectStoreNames(factory)).toEqual(["pairings", "preferences"]);
  });

  it("handles an equal sequence, key rotation, and explicit forget without retaining a graph", async () => {
    const factory = new IDBFactory();
    const store = storeWithFactory(factory);
    await store.commitVerifiedPairing(pairingRecord());

    expect(await store.acceptSequence(GRAPH_ID, KEY_ID, 42)).toBe("same");
    expect(await store.acceptSequence(GRAPH_ID, "rotated-key", 43)).toBe("rotated");
    await store.forget(GRAPH_ID);

    expect(await store.get(GRAPH_ID)).toBeNull();
    expect(await objectStoreNames(factory)).not.toContain("graphs");
    expect(await objectStoreNames(factory)).not.toContain("ciphertext");
  });
});
