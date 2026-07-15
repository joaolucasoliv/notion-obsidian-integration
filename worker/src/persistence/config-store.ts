import {
  parseBridgeConfig,
  type ParsedBridgeConfigV1,
} from "@grandbox-bridge/shared";
import {
  readStrictJson,
  writeAtomicPrivateJson,
  type JsonValue,
} from "../runtime/atomic-json.js";
import { assertValidInstallationId } from "../runtime/paths.js";

export interface ConfigStore {
  load(): Promise<Readonly<ParsedBridgeConfigV1>>;
  save(config: ParsedBridgeConfigV1): Promise<void>;
}

function configStoreError(): Error {
  return new Error("Config store failed");
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

export class FileConfigStore implements ConfigStore {
  public constructor(
    private readonly configPath: string,
    private readonly installationId: string,
  ) {
    try {
      assertValidInstallationId(installationId);
    } catch {
      throw configStoreError();
    }
  }

  public async load(): Promise<Readonly<ParsedBridgeConfigV1>> {
    try {
      const parsed = await readStrictJson(this.configPath, parseBridgeConfig);
      this.assertInstallation(parsed);
      return deepFreeze(parsed);
    } catch {
      throw configStoreError();
    }
  }

  public async save(config: ParsedBridgeConfigV1): Promise<void> {
    try {
      const parsed = parseBridgeConfig(config);
      this.assertInstallation(parsed);
      await writeAtomicPrivateJson(this.configPath, parsed as unknown as JsonValue);
    } catch {
      throw configStoreError();
    }
  }

  private assertInstallation(config: ParsedBridgeConfigV1): void {
    if (config.installationId !== this.installationId) {
      throw configStoreError();
    }
  }
}
