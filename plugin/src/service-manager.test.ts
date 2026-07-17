import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NodeServiceCommandRunner,
  RuntimeServiceManager,
  type ServiceProcessCommand,
} from "./service-manager.js";
import { deriveExternalLocator } from "./locator.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

async function serviceFixture(): Promise<ReturnType<typeof deriveExternalLocator>> {
  const homeDirectory = await realpath(await mkdtemp(join(tmpdir(), "grandbox-plugin-service-")));
  const nodeExecutable = join(homeDirectory, "node");
  const workerPath = join(homeDirectory, "bridge-worker.cjs");
  const locator = deriveExternalLocator({ installationId: INSTALLATION_ID, homeDirectory, vaultRoot: join(homeDirectory, "vault"), nodeExecutable, workerPath });
  await mkdir(dirname(locator.configPath), { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(nodeExecutable, "node", { mode: 0o700 }),
    writeFile(workerPath, "worker", { mode: 0o600 }),
    writeFile(locator.configPath, "{}", { mode: 0o600 }),
  ]);
  await Promise.all([chmod(nodeExecutable, 0o700), chmod(workerPath, 0o600), chmod(locator.configPath, 0o600)]);
  return locator;
}

describe("RuntimeServiceManager", () => {
  it("uses the hardened service boundary with absolute argv and an injected shell-free runner", async () => {
    const locator = await serviceFixture();
    const commands: ServiceProcessCommand[] = [];
    let enabled = false;
    const manager = new RuntimeServiceManager(() => 501, new NodeServiceCommandRunner({
      run: async (command: ServiceProcessCommand) => {
        commands.push(command);
        const action = command.args[0];
        if (action === "bootout") {
          const wasEnabled = enabled;
          enabled = false;
          return { code: wasEnabled ? 0 : 113 };
        }
        if (action === "bootstrap") {
          enabled = true;
          return { code: 0 };
        }
        if (action === "print") return { code: enabled ? 0 : 113 };
        throw new Error("unexpected service action");
      },
    }));

    await expect(manager.status(locator)).resolves.toEqual({ configuration: "ready", service: "disabled" });
    await expect(manager.install(locator)).resolves.toEqual({ enabled: true });
    await expect(manager.status(locator)).resolves.toEqual({ configuration: "ready", service: "enabled" });
    await expect(manager.disable(locator)).resolves.toEqual({ enabled: false });

    const label = `com.grandbox.bridge.${INSTALLATION_ID}`;
    const plistPath = join(locator.homeDirectory, "Library", "LaunchAgents", `${label}.plist`);
    expect(commands).toEqual([
      { executable: "/bin/launchctl", args: ["print", `gui/501/${label}`], shell: false },
      { executable: "/bin/launchctl", args: ["bootout", "gui/501", plistPath], shell: false },
      { executable: "/bin/launchctl", args: ["bootstrap", "gui/501", plistPath], shell: false },
      { executable: "/bin/launchctl", args: ["print", `gui/501/${label}`], shell: false },
      { executable: "/bin/launchctl", args: ["print", `gui/501/${label}`], shell: false },
      { executable: "/bin/launchctl", args: ["bootout", "gui/501", plistPath], shell: false },
      { executable: "/bin/launchctl", args: ["print", `gui/501/${label}`], shell: false },
    ]);
  });
});
