import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readInstallationIdFromVault } from "./vault-locator.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

describe("readInstallationIdFromVault", () => {
  it("reads only the plugin-created opaque installation ID from the canonical vault locator", async () => {
    const vault = await realpath(await mkdtemp(join(tmpdir(), "grandbox-locator-vault-")));
    const pluginDirectory = join(vault, ".obsidian", "plugins", "grandbox-bridge");
    await mkdir(pluginDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(pluginDirectory, "data.json"), JSON.stringify({ installationId: INSTALLATION_ID }), { mode: 0o600 });

    await expect(readInstallationIdFromVault(vault)).resolves.toBe(INSTALLATION_ID);
  });
});
