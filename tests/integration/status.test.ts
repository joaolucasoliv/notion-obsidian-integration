import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BridgeHarness, optedIn } from "../fakes/bridge-harness.js";

describe("detached and missing sides", () => {
  it("preserves the pair and safely marks a note detached when the owner opts it out", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Detached.md", optedIn("stay local\n"));
    await harness.apply();
    await harness.writeNote("Detached.md", (await harness.note("Detached.md")).replace("notion_sync: true", "notion_sync: false"));

    const result = await harness.apply();

    expect(result).toMatchObject({ outcome: "success", writes: 1, errors: 0 });
    expect(Object.values(harness.state.value.pairs)[0]?.status).toBe("detached");
  });

  it("marks only the stored state when the local file or exact remote page disappears", async () => {
    const localMissing = await BridgeHarness.create();
    await localMissing.writeNote("MissingLocal.md", optedIn("local\n"));
    await localMissing.apply();
    await rm(`${localMissing.root.canonicalRealPath}/MissingLocal.md`);

    const localResult = await localMissing.apply();

    expect(localResult).toMatchObject({ outcome: "success", errors: 0 });
    expect(Object.values(localMissing.state.value.pairs)[0]?.status).toBe("missing-local");

    const remoteMissing = await BridgeHarness.create();
    await remoteMissing.writeNote("MissingRemote.md", optedIn("remote\n"));
    await remoteMissing.apply();
    remoteMissing.removeRemoteFor("MissingRemote.md");

    const remoteResult = await remoteMissing.apply();

    expect(remoteResult).toMatchObject({ outcome: "noop", writes: 0, errors: 0 });
    expect(Object.values(remoteMissing.state.value.pairs)[0]?.status).toBe("missing-notion");
  });
});
