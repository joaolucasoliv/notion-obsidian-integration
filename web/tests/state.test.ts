import { describe, expect, it } from "vitest";
import { initialAppState, reduceAppState } from "../src/app/state.ts";

describe("reduceAppState", () => {
  it("cannot enter ready before a verified graph is committed", () => {
    const initial = initialAppState();

    expect(initial).toEqual({ kind: "locked", reason: "unpaired" });
    expect(() => reduceAppState(initial, { type: "render-requested" })).toThrow(/verified/i);
  });

  it("returns to a locked state when a paired device is forgotten", () => {
    const pairing = reduceAppState(initialAppState(), { type: "pairing-requested", source: "paste" });

    expect(reduceAppState(pairing, { type: "forgotten" })).toEqual({ kind: "locked", reason: "forgotten" });
  });
});
