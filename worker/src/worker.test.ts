import { describe, expect, it } from "vitest";
import { BridgeHarness, optedIn } from "../../tests/fakes/bridge-harness.js";

describe("GrandboxBridgeWorker", () => {
  it("keeps preview side-effect-free while still performing the read-only provider preflight", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Worker.md", optedIn("worker preview\n"));

    const result = await harness.preview();

    expect(result).toMatchObject({ mode: "preview", outcome: "success", planned: 2, writes: 0, errors: 0 });
    expect(harness.notion.verifies).toBe(1);
    expect(harness.journal.begun).toEqual([]);
    expect(harness.state.saves).toBe(0);
    expect(harness.uuid.calls).toBe(0);
  });
});
