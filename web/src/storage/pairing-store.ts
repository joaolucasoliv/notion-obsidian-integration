export const PAIRING_DATABASE_NAME = "grandbox-bridge";
const PAIRING_DATABASE_VERSION = 1;
const PAIRINGS_STORE = "pairings";
const PREFERENCES_STORE = "preferences";
const THEME_KEY = "theme";

export interface StoredPairing {
  readonly graphId: string;
  readonly keyId: string;
  readonly keyBytes: Uint8Array;
  readonly highestAcceptedSequence: number;
  readonly verifiedAt: string;
}

export interface PairingStore {
  get(graphId: string): Promise<StoredPairing | null>;
  commitVerifiedPairing(record: StoredPairing): Promise<void>;
  acceptSequence(graphId: string, keyId: string, sequence: number): Promise<"accepted" | "same" | "rollback" | "rotated">;
  forget(graphId: string): Promise<void>;
  getTheme(): Promise<"light" | "dark" | null>;
  setTheme(theme: "light" | "dark"): Promise<void>;
}

interface PreferenceRecord {
  readonly name: typeof THEME_KEY;
  readonly value: "light" | "dark";
}

export class PairingStoreUnavailableError extends Error {
  public readonly code = "storage-unavailable" as const;

  public constructor() {
    super("Device storage is unavailable.");
  }
}

function copyPairing(record: StoredPairing): StoredPairing {
  return {
    graphId: record.graphId,
    keyId: record.keyId,
    keyBytes: new Uint8Array(record.keyBytes),
    highestAcceptedSequence: record.highestAcceptedSequence,
    verifiedAt: record.verifiedAt,
  };
}

function validatePairing(record: StoredPairing): void {
  if (
    record.graphId.length === 0 ||
    record.keyId.length === 0 ||
    record.keyBytes.byteLength !== 32 ||
    !Number.isSafeInteger(record.highestAcceptedSequence) ||
    record.highestAcceptedSequence < 0 ||
    Number.isNaN(Date.parse(record.verifiedAt))
  ) {
    throw new PairingStoreUnavailableError();
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(new PairingStoreUnavailableError()), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(new PairingStoreUnavailableError()), { once: true });
    transaction.addEventListener("error", () => reject(new PairingStoreUnavailableError()), { once: true });
  });
}

/** IndexedDB persists only pairing keys, monotonic sequence metadata, and a theme choice. */
export class IndexedDbPairingStore implements PairingStore {
  readonly #factory: IDBFactory;
  #database: Promise<IDBDatabase> | null = null;

  public constructor(factory: IDBFactory = globalThis.indexedDB) {
    this.#factory = factory;
  }

  public async get(graphId: string): Promise<StoredPairing | null> {
    const database = await this.#open();
    const transaction = database.transaction(PAIRINGS_STORE, "readonly");
    const done = transactionDone(transaction);
    try {
      const record = await requestResult(transaction.objectStore(PAIRINGS_STORE).get(graphId) as IDBRequest<StoredPairing | undefined>);
      await done;
      return record === undefined ? null : copyPairing(record);
    } catch {
      throw new PairingStoreUnavailableError();
    }
  }

  public async commitVerifiedPairing(record: StoredPairing): Promise<void> {
    validatePairing(record);
    const database = await this.#open();
    const transaction = database.transaction(PAIRINGS_STORE, "readwrite");
    const done = transactionDone(transaction);
    try {
      const store = transaction.objectStore(PAIRINGS_STORE);
      const existing = await requestResult(store.get(record.graphId) as IDBRequest<StoredPairing | undefined>);
      const next = existing !== undefined && existing.keyId === record.keyId
        ? { ...copyPairing(record), highestAcceptedSequence: Math.max(existing.highestAcceptedSequence, record.highestAcceptedSequence) }
        : copyPairing(record);
      await requestResult(store.put(next));
      await done;
    } catch {
      try {
        transaction.abort();
      } catch {
        // The transaction can already be complete when an IndexedDB implementation reports an error.
      }
      throw new PairingStoreUnavailableError();
    }
  }

  public async acceptSequence(
    graphId: string,
    keyId: string,
    sequence: number,
  ): Promise<"accepted" | "same" | "rollback" | "rotated"> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new PairingStoreUnavailableError();
    const database = await this.#open();
    const transaction = database.transaction(PAIRINGS_STORE, "readwrite");
    const done = transactionDone(transaction);
    try {
      const store = transaction.objectStore(PAIRINGS_STORE);
      const existing = await requestResult(store.get(graphId) as IDBRequest<StoredPairing | undefined>);
      if (existing === undefined) throw new PairingStoreUnavailableError();
      if (existing.keyId !== keyId) {
        await done;
        return "rotated";
      }
      if (sequence < existing.highestAcceptedSequence) {
        await done;
        return "rollback";
      }
      if (sequence === existing.highestAcceptedSequence) {
        await done;
        return "same";
      }

      await requestResult(store.put({ ...copyPairing(existing), highestAcceptedSequence: sequence }));
      await done;
      return "accepted";
    } catch (error) {
      if (error instanceof PairingStoreUnavailableError) throw error;
      try {
        transaction.abort();
      } catch {
        // The transaction can already be complete when an IndexedDB implementation reports an error.
      }
      throw new PairingStoreUnavailableError();
    }
  }

  public async forget(graphId: string): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(PAIRINGS_STORE, "readwrite");
    const done = transactionDone(transaction);
    try {
      await requestResult(transaction.objectStore(PAIRINGS_STORE).delete(graphId));
      await done;
    } catch {
      throw new PairingStoreUnavailableError();
    }
  }

  public async getTheme(): Promise<"light" | "dark" | null> {
    const database = await this.#open();
    const transaction = database.transaction(PREFERENCES_STORE, "readonly");
    const done = transactionDone(transaction);
    try {
      const preference = await requestResult(
        transaction.objectStore(PREFERENCES_STORE).get(THEME_KEY) as IDBRequest<PreferenceRecord | undefined>,
      );
      await done;
      return preference?.value ?? null;
    } catch {
      throw new PairingStoreUnavailableError();
    }
  }

  public async setTheme(theme: "light" | "dark"): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(PREFERENCES_STORE, "readwrite");
    const done = transactionDone(transaction);
    try {
      await requestResult(transaction.objectStore(PREFERENCES_STORE).put({ name: THEME_KEY, value: theme } satisfies PreferenceRecord));
      await done;
    } catch {
      throw new PairingStoreUnavailableError();
    }
  }

  async #open(): Promise<IDBDatabase> {
    if (this.#database === null) this.#database = this.#createDatabase();
    try {
      return await this.#database;
    } catch {
      this.#database = null;
      throw new PairingStoreUnavailableError();
    }
  }

  #createDatabase(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = this.#factory.open(PAIRING_DATABASE_NAME, PAIRING_DATABASE_VERSION);
      const fail = (): void => {
        if (settled) return;
        settled = true;
        reject(new PairingStoreUnavailableError());
      };
      request.addEventListener("blocked", fail, { once: true });
      request.addEventListener("error", fail, { once: true });
      request.addEventListener(
        "upgradeneeded",
        () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(PAIRINGS_STORE)) database.createObjectStore(PAIRINGS_STORE, { keyPath: "graphId" });
          if (!database.objectStoreNames.contains(PREFERENCES_STORE)) database.createObjectStore(PREFERENCES_STORE, { keyPath: "name" });
        },
        { once: true },
      );
      request.addEventListener(
        "success",
        () => {
          if (settled) {
            request.result.close();
            return;
          }
          settled = true;
          const database = request.result;
          database.addEventListener("versionchange", () => database.close(), { once: true });
          resolve(database);
        },
        { once: true },
      );
    });
  }
}
