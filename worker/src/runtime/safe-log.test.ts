import { writeSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { redactSensitiveOutput, SafeFileLogger } from "./safe-log.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-14T12:00:00.000Z");

async function temporaryLogPath(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "grandbox-log-")));
  return join(root, "GrandboxBridge", "bridge.log");
}

function logger(logPath: string): SafeFileLogger {
  return new SafeFileLogger(logPath, { now: () => NOW });
}

describe("SafeFileLogger", () => {
  it("writes only a parsed event-specific entry to a private file", async () => {
    const logPath = await temporaryLogPath();

    logger(logPath).write({
      level: "info",
      event: "run-completed",
      fields: {
        runId: RUN_ID,
        installationId: INSTALLATION_ID,
        mode: "apply",
        outcome: "success",
        writes: 2,
        errors: 0,
        durationMs: 25,
      },
    });

    const rawLine = await readFile(logPath, "utf8");
    expect(JSON.parse(rawLine)).toEqual({
      timestamp: NOW.toISOString(),
      level: "info",
      event: "run-completed",
      fields: {
        runId: RUN_ID,
        installationId: INSTALLATION_ID,
        mode: "apply",
        outcome: "success",
        writes: 2,
        errors: 0,
        durationMs: 25,
      },
    });
    expect(Buffer.byteLength(rawLine)).toBeLessThanOrEqual(8 * 1_024);
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(logPath))).mode & 0o777).toBe(0o700);
  });

  it("retries short buffer writes until the complete UTF-8 line is durable", async () => {
    const logPath = await temporaryLogPath();
    const injectedTimestamp = new Date(NOW);
    const expectedTimestamp = `${NOW.toISOString()}-é`;
    Object.defineProperty(injectedTimestamp, "toISOString", { value: () => expectedTimestamp });
    let writeCalls = 0;

    new SafeFileLogger(logPath, {
      now: () => injectedTimestamp,
      write: (descriptor: number, buffer: Buffer, offset: number, length: number) => {
        writeCalls += 1;
        return writeSync(descriptor, buffer, offset, Math.min(3, length), null);
      },
    }).write({ level: "info", event: "run-started" });

    expect(writeCalls).toBeGreaterThan(1);
    const raw = await readFile(logPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toMatchObject({ timestamp: expectedTimestamp, event: "run-started" });
  });

  it.each([
    ["zero progress", () => 0],
    ["negative progress", () => -1],
    ["writer failure", () => { throw new Error("injected writer failure"); }],
  ])("fails safely on %s from the write boundary", async (_label, injectedWrite) => {
    const logPath = await temporaryLogPath();
    const safeLogger = new SafeFileLogger(logPath, {
      now: () => NOW,
      write: injectedWrite,
    });

    expect(() => safeLogger.write({ level: "info", event: "run-started" })).toThrow(/unsafe log file/i);
  });

  it("calls the event-specific parser and rejects a field allowed only on another event", async () => {
    const logPath = await temporaryLogPath();

    expect(() =>
      logger(logPath).write({
        level: "info",
        event: "run-started",
        fields: { errorCode: "internal-error" },
      } as never),
    ).toThrow(/unsafe log entry/i);
    await expect(lstat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["noteBody", "fixture private note body"],
    ["path", "Research/fixture-private-note.md"],
    ["credential", "fixture-notion-credential"],
    ["pairingCode", "fixture-pairing-code"],
    ["authorization", "fixture-header-value"],
    ["cookie", "session=fixture-cookie-value"],
    ["providerText", "fixture provider response"],
  ])("fails closed before writing arbitrary %s text", async (field, sensitiveText) => {
    const logPath = await temporaryLogPath();
    const safeLogger = logger(logPath);
    safeLogger.write({ level: "info", event: "run-started", fields: { runId: RUN_ID } });
    const before = await readFile(logPath, "utf8");

    const error = (() => {
      try {
        safeLogger.write({
          level: "error",
          event: "run-failed",
          fields: { runId: RUN_ID, [field]: sensitiveText },
        } as never);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(sensitiveText);
    expect(await readFile(logPath, "utf8")).toBe(before);
    expect(await readFile(logPath, "utf8")).not.toContain(sensitiveText);
  });

  it("rejects arbitrary and overlong log input before creating the log", async () => {
    const logPath = await temporaryLogPath();
    const overlong = "fixture-note-body".repeat(1_000);

    expect(() => logger(logPath).write(overlong as never)).toThrow(/unsafe log entry/i);
    expect(() =>
      logger(logPath).write({ level: "info", event: "run-started", fields: { noteBody: overlong } } as never),
    ).toThrow(/unsafe log entry/i);
    await expect(lstat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an existing log with unsafe permissions without appending", async () => {
    const logPath = await temporaryLogPath();
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    await writeFile(logPath, "existing-private-boundary\n", { mode: 0o600 });
    await chmod(logPath, 0o644);

    expect(() => logger(logPath).write({ level: "info", event: "run-started" })).toThrow(/unsafe log file/i);

    expect(await readFile(logPath, "utf8")).toBe("existing-private-boundary\n");
    expect((await stat(logPath)).mode & 0o777).toBe(0o644);
  });

  it("rejects a symlinked log without modifying the target", async () => {
    const logPath = await temporaryLogPath();
    const targetPath = join(dirname(logPath), "target.log");
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    await writeFile(targetPath, "target-content", { mode: 0o600 });
    await symlink(targetPath, logPath);

    expect(() => logger(logPath).write({ level: "info", event: "run-started" })).toThrow(/unsafe log file/i);

    expect(await readFile(targetPath, "utf8")).toBe("target-content");
    expect((await lstat(logPath)).isSymbolicLink()).toBe(true);
  });

  it("rejects relative and NUL-containing log paths before filesystem mutation", async () => {
    const logPath = await temporaryLogPath();
    const relativePath = relative(process.cwd(), logPath);

    expect(() => new SafeFileLogger(relativePath).write({ level: "info", event: "run-started" })).toThrow(
      /unsafe log file/i,
    );
    expect(() => new SafeFileLogger(`${logPath}\0suffix`).write({ level: "info", event: "run-started" })).toThrow(
      /unsafe log file/i,
    );
    await expect(lstat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an existing symlink component before creating or chmodding through it", async () => {
    const logPath = await temporaryLogPath();
    const root = dirname(dirname(logPath));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "grandbox-log-outside-")));
    await mkdir(join(root, "anchor"));
    await mkdir(join(outside, "logs"));
    await chmod(join(outside, "logs"), 0o755);
    await symlink(outside, join(root, "anchor", "linked"));
    const escapedPath = join(root, "anchor", "linked", "logs", "bridge.log");

    expect(() => new SafeFileLogger(escapedPath).write({ level: "info", event: "run-started" })).toThrow(
      /unsafe log file/i,
    );

    await expect(lstat(join(outside, "logs", "bridge.log"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(outside, "logs"))).mode & 0o777).toBe(0o755);
  });

  it("redacts synthetic credential, pairing, authorization, header, and cookie canaries", () => {
    const canaries = [
      ["sec", "ret_fixture-credential"].join(""),
      ["nt", "n_fixture-notion"].join(""),
      ["github", "pat_fixture-source"].join("_"),
      ["gh", "o_fixture-cli"].join(""),
      ["Bear", "er fixture-authorization"].join(""),
      ["pairing", "fixture-code"].join("="),
      ["session", "fixture-cookie"].join("="),
    ];
    const serialized = JSON.stringify({
      credential: canaries[0],
      providerToken: canaries[1],
      sourceHeader: canaries[2],
      cliHeader: canaries[3],
      authorization: canaries[4],
      pairingCode: canaries[5],
      cookie: canaries[6],
    });

    const redacted = redactSensitiveOutput(serialized);

    for (const canary of canaries) {
      expect(redacted).not.toContain(canary);
    }
    expect(redacted).toContain("[REDACTED]");
  });

  it("passes the serialized safe line through the redactor before writing", async () => {
    const logPath = await temporaryLogPath();
    const timestampCanary = ["sec", "ret_fixture-timestamp"].join("");
    const injectedTimestamp = new Date(NOW);
    Object.defineProperty(injectedTimestamp, "toISOString", {
      value: () => `2026-07-14T12:00:00.000Z-${timestampCanary}`,
    });

    new SafeFileLogger(logPath, { now: () => injectedTimestamp }).write({
      level: "info",
      event: "run-started",
    });

    const raw = await readFile(logPath, "utf8");
    expect(raw).not.toContain(timestampCanary);
    expect(raw).toContain("[REDACTED]");
  });

  it("enforces the 8 KiB cap in UTF-8 bytes after safe parsing and redaction", async () => {
    const logPath = await temporaryLogPath();
    const injectedTimestamp = new Date(NOW);
    Object.defineProperty(injectedTimestamp, "toISOString", {
      value: () => "é".repeat(5_000),
    });

    expect(() =>
      new SafeFileLogger(logPath, { now: () => injectedTimestamp }).write({
        level: "info",
        event: "run-started",
      }),
    ).toThrow(/unsafe log entry/i);
    await expect(lstat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rotates a log over 5 MiB to exactly one private sibling backup before writing", async () => {
    const logPath = await temporaryLogPath();
    const backupPath = `${logPath}.1`;
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    await writeFile(logPath, Buffer.alloc(5 * 1_024 * 1_024 + 1, "x"), { mode: 0o600 });
    await writeFile(backupPath, "previous-backup", { mode: 0o600 });

    logger(logPath).write({ level: "warn", event: "credential-unavailable", fields: { slot: "notion-token" } });

    expect((await stat(backupPath)).size).toBe(5 * 1_024 * 1_024 + 1);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    const current = await readFile(logPath, "utf8");
    expect(JSON.parse(current)).toMatchObject({ event: "credential-unavailable" });
    expect(Buffer.byteLength(current)).toBeLessThanOrEqual(8 * 1_024);
  });
});
