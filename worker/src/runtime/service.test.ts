import { readFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  disableService,
  installService,
  readServiceStatus,
  renderLaunchAgentPlist,
  type ServiceCommand,
} from "./service.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const REDACTION_CANARY = readFileSync(
  new URL("../../../tests/fixtures/safe/credential-canary.txt", import.meta.url),
  "utf8",
).trim();

async function temporaryHome(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "grandbox-service-")));
}

function expectedLabel(): string {
  return `com.grandbox.bridge.${INSTALLATION_ID}`;
}

function expectedPlist(homeDirectory: string): string {
  return join(homeDirectory, "Library", "LaunchAgents", `${expectedLabel()}.plist`);
}

describe("renderLaunchAgentPlist", () => {
  it("renders a five-minute non-KeepAlive service without secrets", () => {
    const xml = renderLaunchAgentPlist({
      installationId: INSTALLATION_ID,
      nodePath: "/usr/local/bin/node",
      workerPath: "/opt/grandbox/bridge-worker.cjs",
      configPath: "/Users/jo/Library/Application Support/Grandbox Bridge/config.json",
      token: REDACTION_CANARY,
      relayToken: "relay-token-synthetic",
      graphKey: "graph-key-synthetic",
    } as never);

    expect(xml).toContain("<key>StartInterval</key><integer>300</integer>");
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>StandardOutPath</key><string>/dev/null</string>");
    expect(xml).toContain("<key>StandardErrorPath</key><string>/dev/null</string>");
    expect(xml).toContain("<string>--config</string>");
    expect(xml).toContain("<string>--reason</string><string>schedule</string><string>--json</string>");
    expect(xml).not.toContain("KeepAlive");
    expect(xml).not.toMatch(/ntn_|relay-token|graph-key/i);
  });

  it.each([
    ["nodePath", "relative/node"],
    ["workerPath", "/opt/grandbox/../bridge-worker.cjs"],
    ["configPath", "/tmp/config.json\0suffix"],
  ])("rejects an unsafe %s before rendering", (field, unsafePath) => {
    const input = {
      installationId: INSTALLATION_ID,
      nodePath: "/usr/local/bin/node",
      workerPath: "/opt/grandbox/bridge-worker.cjs",
      configPath: "/Users/jo/Library/Application Support/Grandbox Bridge/config.json",
      [field]: unsafePath,
    };

    expect(() => renderLaunchAgentPlist(input)).toThrow(/unsafe service path/i);
  });
});

describe("LaunchAgent service lifecycle", () => {
  it("reads a configured service state through one argv-only print without mutating launchd", async () => {
    const homeDirectory = await temporaryHome();
    const nodePath = join(homeDirectory, "node");
    const workerPath = join(homeDirectory, "bridge-worker.cjs");
    const configPath = join(homeDirectory, "config.json");
    await Promise.all([
      writeFile(nodePath, "node", { mode: 0o700 }),
      writeFile(workerPath, "worker", { mode: 0o600 }),
      writeFile(configPath, "{}", { mode: 0o600 }),
    ]);
    const commands: ServiceCommand[] = [];

    const status = await readServiceStatus({
      homeDirectory,
      installationId: INSTALLATION_ID,
      nodePath,
      workerPath,
      configPath,
      uid: 501,
      runner: {
        run: async (command: ServiceCommand) => {
          commands.push(command);
          return { code: 113 };
        },
      },
    });

    expect(status).toEqual({ label: expectedLabel(), plistPath: expectedPlist(homeDirectory), configured: true, enabled: false });
    expect(commands).toEqual([
      { executable: "/bin/launchctl", args: ["print", `gui/501/${expectedLabel()}`] },
    ]);
  });

  it("uses an injected launchctl runner with absolute bootstrap, bootout, and print paths", async () => {
    const homeDirectory = await temporaryHome();
    const nodePath = join(homeDirectory, "node");
    const workerPath = join(homeDirectory, "bridge-worker.cjs");
    const configPath = join(homeDirectory, "config.json");
    await Promise.all([
      writeFile(nodePath, "node", { mode: 0o700 }),
      writeFile(workerPath, "worker", { mode: 0o600 }),
      writeFile(configPath, "{}", { mode: 0o600 }),
    ]);
    const commands: ServiceCommand[] = [];
    let phase: "install" | "disable" = "install";
    const runner = {
      run: async (command: ServiceCommand) => {
        commands.push(command);
        return {
          code: command.args[0] === "bootout" || (phase === "disable" && command.args[0] === "print") ? 113 : 0,
        };
      },
    };

    const installed = await installService({
      homeDirectory,
      installationId: INSTALLATION_ID,
      nodePath,
      workerPath,
      configPath,
      uid: 501,
      runner,
    });

    const plistPath = expectedPlist(homeDirectory);
    expect(installed).toEqual({ label: expectedLabel(), plistPath, enabled: true });
    expect(commands).toEqual([
      { executable: "/bin/launchctl", args: ["bootout", "gui/501", plistPath] },
      { executable: "/bin/launchctl", args: ["bootstrap", "gui/501", plistPath] },
      { executable: "/bin/launchctl", args: ["print", `gui/501/${expectedLabel()}`] },
    ]);
    expect((await stat(plistPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(plistPath, "utf8")).not.toMatch(/ntn_|relay-token|graph-key/i);

    commands.length = 0;
    phase = "disable";
    const disabled = await disableService({ homeDirectory, installationId: INSTALLATION_ID, uid: 501, runner });

    expect(disabled).toEqual({ label: expectedLabel(), plistPath, enabled: false });
    expect(commands).toEqual([
      { executable: "/bin/launchctl", args: ["bootout", "gui/501", plistPath] },
      { executable: "/bin/launchctl", args: ["print", `gui/501/${expectedLabel()}`] },
    ]);
  });

  it("fails before writing a plist or invoking launchctl when an input path is unsafe", async () => {
    const homeDirectory = await temporaryHome();
    const commands: ServiceCommand[] = [];

    await expect(installService({
      homeDirectory,
      installationId: INSTALLATION_ID,
      nodePath: "relative-node",
      workerPath: join(homeDirectory, "bridge-worker.cjs"),
      configPath: join(homeDirectory, "config.json"),
      uid: 501,
      runner: { run: async (command: ServiceCommand) => { commands.push(command); return { code: 0 }; } },
    })).rejects.toThrow(/unsafe service path/i);

    await expect(lstat(expectedPlist(homeDirectory))).rejects.toMatchObject({ code: "ENOENT" });
    expect(commands).toEqual([]);
  });

  it("rejects symlinked executable input before it can enter a plist", async () => {
    const homeDirectory = await temporaryHome();
    const nodeTarget = join(homeDirectory, "node-target");
    const nodePath = join(homeDirectory, "node");
    const workerPath = join(homeDirectory, "bridge-worker.cjs");
    const configPath = join(homeDirectory, "config.json");
    await Promise.all([
      writeFile(nodeTarget, "node", { mode: 0o700 }),
      symlink(nodeTarget, nodePath),
      writeFile(workerPath, "worker", { mode: 0o600 }),
      writeFile(configPath, "{}", { mode: 0o600 }),
    ]);

    await expect(installService({
      homeDirectory,
      installationId: INSTALLATION_ID,
      nodePath,
      workerPath,
      configPath,
      uid: 501,
      runner: { run: async () => ({ code: 0 }) },
    })).rejects.toThrow(/unsafe service path/i);
    await expect(lstat(expectedPlist(homeDirectory))).rejects.toMatchObject({ code: "ENOENT" });
    await chmod(nodeTarget, 0o700);
  });

  it.each([
    ["bootstrap", 1],
    ["print", 1],
  ])("fails closed when launchctl %s cannot confirm service state", async (failingCommand, failingCode) => {
    const homeDirectory = await temporaryHome();
    const nodePath = join(homeDirectory, "node");
    const workerPath = join(homeDirectory, "bridge-worker.cjs");
    const configPath = join(homeDirectory, "config.json");
    await Promise.all([
      writeFile(nodePath, "node", { mode: 0o700 }),
      writeFile(workerPath, "worker", { mode: 0o600 }),
      writeFile(configPath, "{}", { mode: 0o600 }),
    ]);
    const commands: ServiceCommand[] = [];

    await expect(installService({
      homeDirectory,
      installationId: INSTALLATION_ID,
      nodePath,
      workerPath,
      configPath,
      uid: 501,
      runner: {
        run: async (command: ServiceCommand) => {
          commands.push(command);
          return { code: command.args[0] === failingCommand ? failingCode : 0 };
        },
      },
    })).rejects.toThrow(/service command failed/i);

    expect(commands.map((command) => command.args[0])).toEqual(
      failingCommand === "bootstrap" ? ["bootout", "bootstrap"] : ["bootout", "bootstrap", "print"],
    );
  });

  it.each([
    ["bootout", ["bootout"]],
    ["print", ["bootout", "print"]],
  ] as const)("does not treat an unexpected disable %s failure as service absence", async (failingCommand, expectedCalls) => {
    const homeDirectory = await temporaryHome();
    const commands: ServiceCommand[] = [];

    await expect(disableService({
      homeDirectory,
      installationId: INSTALLATION_ID,
      uid: 501,
      runner: {
        run: async (command: ServiceCommand) => {
          commands.push(command);
          return {
            code: command.args[0] === failingCommand ? 1 : command.args[0] === "print" ? 113 : 0,
          };
        },
      },
    })).rejects.toThrow(/service command failed/i);

    expect(commands.map((command) => command.args[0])).toEqual(expectedCalls);
  });
});
