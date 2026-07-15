import {
  parseBridgeState,
  type ParsedBridgeStateV1,
} from "@grandbox-bridge/shared";
import {
  readStrictJson,
  writeAtomicPrivateJson,
  type JsonValue,
} from "../runtime/atomic-json.js";
import { assertValidInstallationId } from "../runtime/paths.js";

export interface StateStore {
  load(): Promise<Readonly<ParsedBridgeStateV1>>;
  save(state: ParsedBridgeStateV1): Promise<void>;
}

function stateStoreError(): Error {
  return new Error("State store failed");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

export class FileStateStore implements StateStore {
  public constructor(
    private readonly statePath: string,
    private readonly installationId: string,
  ) {
    try {
      assertValidInstallationId(installationId);
    } catch {
      throw stateStoreError();
    }
  }

  public async load(): Promise<Readonly<ParsedBridgeStateV1>> {
    try {
      const parsed = await readStrictJson(this.statePath, parseBridgeState);
      this.assertInstallation(parsed);
      return deepFreeze(parsed);
    } catch {
      throw stateStoreError();
    }
  }

  public async save(state: ParsedBridgeStateV1): Promise<void> {
    try {
      const parsed = parseBridgeState(state);
      this.assertInstallation(parsed);
      await writeAtomicPrivateJson(this.statePath, parsed as unknown as JsonValue);
    } catch {
      throw stateStoreError();
    }
  }

  private assertInstallation(state: ParsedBridgeStateV1): void {
    if (state.installationId !== this.installationId) {
      throw stateStoreError();
    }
  }
}
