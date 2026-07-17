import { describe, expect, it } from "vitest";
import { parseGraphRoute } from "../src/route.ts";

describe("parseGraphRoute", () => {
  it("accepts one canonical graph route and rejects every other pathname", () => {
    expect(parseGraphRoute("/g/844d93be-86f1-47ea-a98c-9c56ee81e027")).toEqual({
      graphId: "844d93be-86f1-47ea-a98c-9c56ee81e027",
    });
    expect(() => parseGraphRoute("/g/../admin")).toThrow(/route/i);
    expect(() => parseGraphRoute("/g/844d93be-86f1-47ea-a98c-9c56ee81e027/more")).toThrow(/route/i);
    expect(() => parseGraphRoute("/g/844D93BE-86F1-47EA-A98C-9C56EE81E027")).toThrow(/route/i);
  });
});
