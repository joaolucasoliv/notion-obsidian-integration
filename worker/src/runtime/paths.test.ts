import { chmod, mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseBridgeState } from "@grandbox-bridge/shared";
import { describe, expect, it } from "vitest";
import { readStrictJson } from "./atomic-json.js";
import { deriveRuntimePaths } from "./paths.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

function validState(): unknown {
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    pairs: {},
    graph: null,
    lastFullReconciliationAt: null,
    lastRun: null,
  };
}

async function temporaryDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "grandbox-paths-")));
}

describe("deriveRuntimePaths", () => {
  it("derives external state from installation ID, not vault name", () => {
    const paths = deriveRuntimePaths("/Users/jo", INSTALLATION_ID);

    expect(paths).toEqual({
      root: `/Users/jo/Library/Application Support/Grandbox Bridge/${INSTALLATION_ID}`,
      configPath: `/Users/jo/Library/Application Support/Grandbox Bridge/${INSTALLATION_ID}/config.json`,
      statePath: `/Users/jo/Library/Application Support/Grandbox Bridge/${INSTALLATION_ID}/state.json`,
      lockPath: `/Users/jo/Library/Application Support/Grandbox Bridge/${INSTALLATION_ID}/sync.lock`,
      journalDir: `/Users/jo/Library/Application Support/Grandbox Bridge/${INSTALLATION_ID}/journal`,
      logPath: "/Users/jo/Library/Logs/GrandboxBridge/bridge.log",
    });
  });

  it.each([
    "../../Library",
    "/absolute/path",
    "C:\\absolute",
    "11111111-1111-4111-8111-111111111111/escape",
    "11111111-1111-4111-8111-11111111111z",
    "11111111-1111-4111-8111-111111111111\0suffix",
  ])("rejects an unsafe installation identity: %s", (installationId) => {
    expect(() => deriveRuntimePaths("/Users/jo", installationId)).toThrow(/installation identity/i);
  });

  it("requires an absolute home directory", () => {
    expect(() => deriveRuntimePaths("relative-home", INSTALLATION_ID)).toThrow(/home directory/i);
  });
});

describe("readStrictJson", () => {
  it("reads a bounded private regular file through the injected strict parser", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "state.json");
    await writeFile(filePath, JSON.stringify(validState()), { mode: 0o600 });

    const parsed = await readStrictJson(filePath, parseBridgeState);

    expect(parsed.installationId).toBe(INSTALLATION_ID);
  });

  it("rejects malformed JSON without reflecting raw provider text", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "state.json");
    const providerText = "fixture-provider-secret-malformed";
    await writeFile(filePath, `{\"providerText\":\"${providerText}`, { mode: 0o600 });

    const error = await readStrictJson(filePath, parseBridgeState).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/strict json/i);
    expect(String(error)).not.toContain(providerText);
  });

  it("rejects an unknown schema field without reflecting its name or value", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "state.json");
    const providerText = "fixture-provider-secret-schema";
    await writeFile(
      filePath,
      JSON.stringify({ ...validState(), providerText }),
      { mode: 0o600 },
    );

    const error = await readStrictJson(filePath, parseBridgeState).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("providerText");
    expect(String(error)).not.toContain(providerText);
  });

  it("rejects a symbolic link even when its target is private", async () => {
    const directory = await temporaryDirectory();
    const targetPath = join(directory, "target.json");
    const linkPath = join(directory, "state.json");
    await writeFile(targetPath, JSON.stringify(validState()), { mode: 0o600 });
    await symlink(targetPath, linkPath);

    await expect(readStrictJson(linkPath, parseBridgeState)).rejects.toThrow(/strict json/i);
  });

  it("rejects an existing symlink component before reading through it", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const linkedRoot = join(directory, "anchor", "linked");
    const targetPath = join(outside, "runtime", "state.json");
    await mkdir(join(directory, "anchor"));
    await mkdir(join(outside, "runtime"));
    await writeFile(targetPath, JSON.stringify(validState()), { mode: 0o600 });
    await symlink(outside, linkedRoot);

    await expect(
      readStrictJson(join(linkedRoot, "runtime", "state.json"), parseBridgeState),
    ).rejects.toThrow(/strict json/i);
  });

  it("rejects a relative file path before reading it", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "state.json");
    await writeFile(filePath, JSON.stringify(validState()), { mode: 0o600 });

    await expect(readStrictJson(relative(process.cwd(), filePath), parseBridgeState)).rejects.toThrow(
      /strict json/i,
    );
  });

  it("rejects non-regular files", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "state.json");
    await mkdir(filePath);

    await expect(readStrictJson(filePath, parseBridgeState)).rejects.toThrow(/strict json/i);
  });

  it("rejects files readable by group or other users", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "state.json");
    await writeFile(filePath, JSON.stringify(validState()), { mode: 0o600 });
    await chmod(filePath, 0o644);

    await expect(readStrictJson(filePath, parseBridgeState)).rejects.toThrow(/strict json/i);
  });

  it("rejects content beyond the configured byte bound without returning it", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "state.json");
    const rawContent = "fixture-provider-over-limit".repeat(10);
    await writeFile(filePath, rawContent, { mode: 0o600 });

    const error = await readStrictJson(filePath, (input) => input, { maxBytes: 32 }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(rawContent);
    expect(await readFile(filePath, "utf8")).toBe(rawContent);
  });

  it("rejects invalid UTF-8 before JSON parsing", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "state.json");
    await writeFile(filePath, Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]), { mode: 0o600 });

    await expect(readStrictJson(filePath, (input) => input)).rejects.toThrow(/strict json/i);
  });

  it.each([
    '{"schemaVersion":999,"schemaVersion":1}',
    '{"outer":{"value":1,"v\\u0061lue":2}}',
  ])("rejects duplicate object keys before schema validation", async (rawJson) => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "state.json");
    await writeFile(filePath, rawJson, { mode: 0o600 });

    await expect(readStrictJson(filePath, (input) => input)).rejects.toThrow(/strict json/i);
  });
});
