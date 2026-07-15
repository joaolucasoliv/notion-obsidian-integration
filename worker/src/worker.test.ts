import { describe, expect, it } from "vitest";
import { BridgeHarness, optedIn } from "../../tests/fakes/bridge-harness.js";

class MovingClock {
  private value = new Date("2026-07-14T12:34:56.000Z").getTime();

  public now(): Date {
    return new Date(this.value);
  }

  public advance(milliseconds: number): void {
    this.value += milliseconds;
  }

  public async sleep(): Promise<void> {}
}

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

  it("does not mutate durable state for scheduled no-ops across distinct clock readings", async () => {
    const clock = new MovingClock();
    const harness = await BridgeHarness.create({ clock });
    await harness.writeNote("Noop.md", optedIn("settled\n"));
    await harness.apply();
    const stateBeforeNoops = structuredClone(harness.state.value);
    const savesBeforeNoops = harness.state.saves;
    const uuidsBeforeNoops = harness.uuid.calls;
    const begunBeforeNoops = harness.journal.begun.length;
    const completedBeforeNoops = harness.journal.completed.length;

    clock.advance(60_000);
    const first = await harness.apply("schedule");
    clock.advance(60_000);
    const second = await harness.apply("schedule");

    expect(first).toMatchObject({ outcome: "noop", planned: 0, writes: 0, errors: 0 });
    expect(second).toMatchObject({ outcome: "noop", planned: 0, writes: 0, errors: 0 });
    expect(harness.state.value).toEqual(stateBeforeNoops);
    expect(harness.state.saves).toBe(savesBeforeNoops);
    expect(harness.uuid.calls).toBe(uuidsBeforeNoops);
    expect(harness.journal.begun).toHaveLength(begunBeforeNoops);
    expect(harness.journal.completed).toHaveLength(completedBeforeNoops);
  });
});
