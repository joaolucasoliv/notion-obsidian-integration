import { describe, expect, it } from "vitest";
import { cortexSemanticHash } from "./semantic.js";

describe("cortexSemanticHash", () => {
  it("normalizes Notion's adjacent plain-block representation", async () => {
    const collapsed = await cortexSemanticHash("First paragraph.\nSecond paragraph.\n");
    const separateBlocks = await cortexSemanticHash("First paragraph.\n\nSecond paragraph.\n");

    expect(collapsed).toBe(separateBlocks);
  });

  it("does not collapse a formatting-leading soft wrap into a separate block", async () => {
    const softWrap = await cortexSemanticHash("First\n**bold**\n");
    const separateBlocks = await cortexSemanticHash("First\n\n**bold**\n");

    expect(softWrap).not.toBe(separateBlocks);
  });

  it.each([
    ["wiki link", "First\n[[Target]]\n", "First\n\n[[Target]]\n"],
    ["embed", "First\n![[Target]]\n", "First\n\n![[Target]]\n"],
  ])("does not collapse a %s soft wrap into a separate block", async (_kind, softWrap, separateBlocks) => {
    expect(await cortexSemanticHash(softWrap)).not.toBe(await cortexSemanticHash(separateBlocks));
  });
});
