import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { assertCanonicalRuntimePath } from "./paths.js";

const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;
const MAX_CONFIGURABLE_JSON_BYTES = 16 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface ReadStrictJsonOptions {
  readonly maxBytes?: number;
}

export interface AtomicJsonOptions {
  readonly uniqueSuffix?: () => string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type StrictParser<T> = (input: unknown) => T;

function strictJsonError(): Error {
  return new Error("Strict JSON read failed");
}

function atomicJsonError(): Error {
  return new Error("Atomic JSON write failed");
}

class JsonLexicalScanner {
  private index = 0;

  constructor(private readonly input: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue(0);
    this.skipWhitespace();
    if (this.index !== this.input.length) {
      throw strictJsonError();
    }
  }

  private scanValue(depth: number): void {
    if (depth > 100) {
      throw strictJsonError();
    }
    this.skipWhitespace();
    const token = this.input[this.index];
    if (token === "{") {
      this.scanObject(depth + 1);
      return;
    }
    if (token === "[") {
      this.scanArray(depth + 1);
      return;
    }
    if (token === '"') {
      this.scanString();
      return;
    }
    if (token === "t") {
      this.consumeLiteral("true");
      return;
    }
    if (token === "f") {
      this.consumeLiteral("false");
      return;
    }
    if (token === "n") {
      this.consumeLiteral("null");
      return;
    }
    const numberMatch = this.input.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numberMatch === null) {
      throw strictJsonError();
    }
    this.index += numberMatch[0].length;
  }

  private scanObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.input[this.index] === "}") {
      this.index += 1;
      return;
    }
    while (true) {
      if (this.input[this.index] !== '"') {
        throw strictJsonError();
      }
      const key = this.scanString();
      if (keys.has(key)) {
        throw strictJsonError();
      }
      keys.add(key);
      this.skipWhitespace();
      this.consume(":");
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.input[this.index] === "}") {
        this.index += 1;
        return;
      }
      this.consume(",");
      this.skipWhitespace();
    }
  }

  private scanArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.input[this.index] === "]") {
      this.index += 1;
      return;
    }
    while (true) {
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.input[this.index] === "]") {
        this.index += 1;
        return;
      }
      this.consume(",");
      this.skipWhitespace();
    }
  }

  private scanString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.input.length) {
      const character = this.input[this.index] as string;
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.input.slice(start, this.index)) as string;
      }
      if (character === "\\") {
        this.index += 1;
        const escape = this.input[this.index];
        if (escape === "u") {
          const hex = this.input.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw strictJsonError();
          }
          this.index += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          throw strictJsonError();
        }
        this.index += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) {
        throw strictJsonError();
      }
      this.index += 1;
    }
    throw strictJsonError();
  }

  private consumeLiteral(literal: string): void {
    if (this.input.slice(this.index, this.index + literal.length) !== literal) {
      throw strictJsonError();
    }
    this.index += literal.length;
  }

  private consume(character: string): void {
    if (this.input[this.index] !== character) {
      throw strictJsonError();
    }
    this.index += 1;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.input[this.index] ?? "") && this.input[this.index] !== undefined) {
      const character = this.input[this.index];
      if (character !== " " && character !== "\n" && character !== "\r" && character !== "\t") {
        throw strictJsonError();
      }
      this.index += 1;
    }
  }
}

interface JsonValidationBudget {
  nodes: number;
}

function assertJsonValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
  depth = 0,
  budget: JsonValidationBudget = { nodes: 0 },
): asserts value is JsonValue {
  budget.nodes += 1;
  if (depth > 100 || budget.nodes > 100_000) {
    throw atomicJsonError();
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw atomicJsonError();
    }
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw atomicJsonError();
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || value.length > 100_000) {
      throw atomicJsonError();
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) {
      throw atomicJsonError();
    }
    ancestors.add(value);
    try {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw atomicJsonError();
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw atomicJsonError();
        }
        assertJsonValue(descriptor.value, ancestors, depth + 1, budget);
      }
    } finally {
      ancestors.delete(value);
    }
    return;
  }

  if (prototype !== Object.prototype && prototype !== null) {
    throw atomicJsonError();
  }
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw atomicJsonError();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw atomicJsonError();
      }
      assertJsonValue(descriptor.value, ancestors, depth + 1, budget);
    }
  } finally {
    ancestors.delete(value);
  }
}

function validatedMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? DEFAULT_MAX_JSON_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CONFIGURABLE_JSON_BYTES) {
    throw strictJsonError();
  }
  return maxBytes;
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const before = await lstat(directoryPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw atomicJsonError();
  }
  await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  const after = await lstat(directoryPath);
  if (!after.isDirectory() || after.isSymbolicLink() || (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw atomicJsonError();
  }
}

export async function readStrictJson<T>(
  filePath: string,
  parser: StrictParser<T>,
  options: ReadStrictJsonOptions = {},
): Promise<T> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    const maxBytes = validatedMaxBytes(options.maxBytes);
    await assertCanonicalRuntimePath(filePath);
    const entry = await lstat(filePath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw strictJsonError();
    }

    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    await assertCanonicalRuntimePath(filePath);
    const opened = await handle.stat();
    if (!opened.isFile() || (opened.mode & 0o777) !== PRIVATE_FILE_MODE || opened.size > maxBytes) {
      throw strictJsonError();
    }

    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    if (offset > maxBytes) {
      throw strictJsonError();
    }

    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    new JsonLexicalScanner(raw).scan();
    const parsed: unknown = JSON.parse(raw);
    const validated = parser(parsed);
    await handle.close();
    handle = undefined;
    return validated;
  } catch {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    throw strictJsonError();
  }
}

export async function writeAtomicPrivateJson(
  filePath: string,
  value: JsonValue,
  options: AtomicJsonOptions = {},
): Promise<void> {
  let serialized: string;
  try {
    assertJsonValue(value);
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw atomicJsonError();
    }
    serialized = `${encoded}\n`;
    if (Buffer.byteLength(serialized, "utf8") > DEFAULT_MAX_JSON_BYTES) {
      throw atomicJsonError();
    }
  } catch {
    throw atomicJsonError();
  }

  if (!isAbsolute(filePath) || filePath.includes("\0")) {
    throw atomicJsonError();
  }

  const parent = dirname(filePath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let ownsTemporary = false;
  let temporaryPath = "";

  try {
    await assertCanonicalRuntimePath(filePath);
    await ensurePrivateDirectory(parent);
    await assertCanonicalRuntimePath(filePath);
    try {
      const destination = await lstat(filePath);
      if (destination.isSymbolicLink()) {
        throw atomicJsonError();
      }
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "ENOENT") {
        throw caught;
      }
    }
    const suffix = (options.uniqueSuffix ?? randomUUID)();
    if (!/^[A-Za-z0-9-]{1,128}$/.test(suffix)) {
      throw atomicJsonError();
    }
    temporaryPath = join(parent, `.${basename(filePath)}.${suffix}.tmp`);

    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    ownsTemporary = true;
    const opened = await handle.stat();
    if (!opened.isFile() || (opened.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw atomicJsonError();
    }
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;

    await assertCanonicalRuntimePath(filePath);
    await assertCanonicalRuntimePath(temporaryPath);
    await rename(temporaryPath, filePath);
    ownsTemporary = false;

    const directoryHandle = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (ownsTemporary) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    throw atomicJsonError();
  }
}
