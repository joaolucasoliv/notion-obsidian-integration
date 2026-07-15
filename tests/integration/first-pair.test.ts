import { describe, expect, it } from "vitest";
import { BridgeHarness, optedIn } from "../fakes/bridge-harness.js";

describe("first opt-in pairing", () => {
  it("allocates only during apply, creates one remote page, and reaches a zero-write repeat", async () => {
    const harness = await BridgeHarness.create();
    await harness.writeNote("Note.md", optedIn("local v1\n"));

    const first = await harness.apply();
    const paired = await harness.note("Note.md");
    const repeat = await harness.apply();

    expect(first).toMatchObject({ mode: "apply", outcome: "success", pushed: 1, errors: 0 });
    expect(first.writes).toBeGreaterThanOrEqual(2);
    expect(paired).toContain("bridge_id:");
    expect(harness.notion.creates).toBe(1);
    expect(Object.keys(harness.state.value.pairs)).toHaveLength(1);
    expect(repeat).toMatchObject({ outcome: "noop", writes: 0, errors: 0 });
  });
});
