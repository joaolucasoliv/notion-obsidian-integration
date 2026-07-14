import {
  closeSync,
  constants,
  chmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  type Stats,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { parseSafeLogEntry, type SafeLogEntry, type SafeLogger } from "@grandbox-bridge/shared";
import { assertCanonicalRuntimePathSync } from "./paths.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_LOG_LINE_BYTES = 8 * 1_024;
const MAX_LOG_FILE_BYTES = 5 * 1_024 * 1_024;

export interface SafeFileLoggerOptions {
  readonly now?: () => Date;
  readonly write?: (descriptor: number, buffer: Buffer, offset: number, length: number) => number;
}

function unsafeEntryError(): Error {
  return new Error("Unsafe log entry");
}

function unsafeFileError(): Error {
  return new Error("Unsafe log file");
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function ensurePrivateDirectory(directoryPath: string): void {
  assertCanonicalRuntimePathSync(directoryPath);
  mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  assertCanonicalRuntimePathSync(directoryPath);
  const before = lstatSync(directoryPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw unsafeFileError();
  }
  chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
  const after = lstatSync(directoryPath);
  if (!after.isDirectory() || after.isSymbolicLink() || (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw unsafeFileError();
  }
}

function privateExistingLogStats(logPath: string): Stats | null {
  try {
    const stats = lstatSync(logPath);
    if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw unsafeFileError();
    }
    return stats;
  } catch (caught) {
    if (isMissingFile(caught)) {
      return null;
    }
    throw unsafeFileError();
  }
}

function fsyncDirectory(directoryPath: string): void {
  const descriptor = openSync(directoryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

const SENSITIVE_JSON_FIELD = new RegExp(
  '("(?:[^"\\\\]|\\\\.)*(?:credential|token|sec(?:ret)|pairing|authorization|header|cookie|signature|password|graph[-_ ]?key|api[-_ ]?key)(?:[^"\\\\]|\\\\.)*"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"',
  "gi",
);
const COMMON_SENSITIVE_VALUES = [
  new RegExp(`${["sec", "ret_"].join("")}[A-Za-z0-9._~-]+`, "gi"),
  new RegExp(`${["nt", "n_"].join("")}[A-Za-z0-9._~-]+`, "gi"),
  new RegExp(`${["github", "_pat_"].join("")}[A-Za-z0-9_~-]+`, "gi"),
  /gh[opusr]_[A-Za-z0-9_~-]+/gi,
  /bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /pairing(?:[-_ ]?(?:code|string|key))?\s*[=:]\s*[A-Za-z0-9._~+/=-]+/gi,
] as const;

export function redactSensitiveOutput(input: string): string {
  let redacted = input.replace(SENSITIVE_JSON_FIELD, '$1"[REDACTED]"');
  for (const pattern of COMMON_SENSITIVE_VALUES) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

function serializeSafeLogEntry(input: unknown, timestamp = new Date()): string {
  try {
    const parsed = parseSafeLogEntry(input);
    if (!Number.isFinite(timestamp.getTime())) {
      throw unsafeEntryError();
    }
    const serialized = JSON.stringify({ timestamp: timestamp.toISOString(), ...parsed });
    const line = `${redactSensitiveOutput(serialized)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_LOG_LINE_BYTES) {
      throw unsafeEntryError();
    }
    return line;
  } catch {
    throw unsafeEntryError();
  }
}

export class SafeFileLogger implements SafeLogger {
  private readonly now: () => Date;
  private readonly writeBuffer: NonNullable<SafeFileLoggerOptions["write"]>;

  constructor(
    private readonly logPath: string,
    options: SafeFileLoggerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.writeBuffer = options.write ?? ((descriptor, buffer, offset, length) =>
      writeSync(descriptor, buffer, offset, length, null));
  }

  write(entry: SafeLogEntry): void {
    const line = serializeSafeLogEntry(entry, this.now());
    const directoryPath = dirname(this.logPath);

    try {
      assertCanonicalRuntimePathSync(this.logPath);
      ensurePrivateDirectory(directoryPath);
      assertCanonicalRuntimePathSync(this.logPath);
      const existing = privateExistingLogStats(this.logPath);
      if (existing !== null && existing.size > MAX_LOG_FILE_BYTES) {
        assertCanonicalRuntimePathSync(this.logPath);
        assertCanonicalRuntimePathSync(`${this.logPath}.1`);
        renameSync(this.logPath, `${this.logPath}.1`);
        fsyncDirectory(directoryPath);
      }

      assertCanonicalRuntimePathSync(this.logPath);
      const descriptor = openSync(
        this.logPath,
        constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      try {
        assertCanonicalRuntimePathSync(this.logPath);
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || (opened.mode & 0o777) !== PRIVATE_FILE_MODE) {
          throw unsafeFileError();
        }
        const buffer = Buffer.from(line, "utf8");
        let offset = 0;
        while (offset < buffer.byteLength) {
          const remaining = buffer.byteLength - offset;
          const written = this.writeBuffer(descriptor, buffer, offset, remaining);
          if (!Number.isInteger(written) || written <= 0 || written > remaining) {
            throw unsafeFileError();
          }
          offset += written;
        }
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } catch {
      throw unsafeFileError();
    }
  }
}
