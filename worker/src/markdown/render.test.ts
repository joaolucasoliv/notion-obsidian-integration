import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLocalNote } from "./frontmatter.js";
import { renderLocalNote } from "./render.js";

async function fixture(name: string): Promise<string> {
  return readFile(
    fileURLToPath(new URL(`../../../tests/fixtures/markdown/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("renderLocalNote", () => {
  it("surgically synchronizes tags and replaces only the body", async () => {
    const input = await fixture("render.input.md");
    const expected = await fixture("render.expected.md");
    const note = parseLocalNote("Research/Rendered.md", input);

    expect(
      renderLocalNote(note, {
        bodyMarkdown: "# Replacement\n\nNew body.\n",
        tags: ["zeta", "alpha", "zeta"],
      }),
    ).toBe(expected);
  });

  it("preserves CRLF in frontmatter and the replacement body", () => {
    const bytes =
      "---\r\n# keep\r\nnotion_sync: true\r\nbridge_id: 11111111-1111-4111-8111-111111111111\r\ntags: [old]\r\n---\r\nOld\r\n";
    const note = parseLocalNote("Research/CRLF.md", bytes);

    expect(renderLocalNote(note, { bodyMarkdown: "New\n\nBody\n", tags: ["next"] })).toBe(
      "---\r\n# keep\r\nnotion_sync: true\r\nbridge_id: 11111111-1111-4111-8111-111111111111\r\ntags: [next]\r\n---\r\nNew\r\n\r\nBody\r\n",
    );
  });

  it("writes synchronized tags in the semantic code-point canonical order", () => {
    const bytes =
      "---\nnotion_sync: true\nbridge_id: 11111111-1111-4111-8111-111111111111\ntags: [old]\n---\nBody\n";
    const note = parseLocalNote("Research/Canonical tags.md", bytes);

    expect(
      renderLocalNote(note, {
        bodyMarkdown: "Body\n",
        tags: ["😀", "\uE000", "alpha", "😀"],
      }),
    ).toBe(
      "---\nnotion_sync: true\nbridge_id: 11111111-1111-4111-8111-111111111111\ntags: [alpha, \uE000, 😀]\n---\nBody\n",
    );
  });

  it("never creates frontmatter or opts a note in", () => {
    const note = parseLocalNote("Research/Plain.md", "Body only");

    expect(() => renderLocalNote(note, { bodyMarkdown: "Changed\n", tags: [] })).toThrow();
  });
});
