import { describe, expect, it } from "vitest";
import { NoteCommandError, changeNoteOptIn } from "./commands.js";

describe("note opt-in commands", () => {
  it("changes only notion_sync while preserving unrelated frontmatter and body", () => {
    const before = "---\ncustom: preserve\nnotion_sync: false\ntags: [manual]\n---\nBody stays byte-identical.\n";

    const optedIn = changeNoteOptIn({ path: "Research/Decision.md", bytes: before, optedIn: true });
    const optedOut = changeNoteOptIn({ path: "Research/Decision.md", bytes: optedIn, optedIn: false });

    expect(optedIn).toBe("---\ncustom: preserve\nnotion_sync: true\ntags: [manual]\n---\nBody stays byte-identical.\n");
    expect(optedOut).toBe(before);
  });

  it("adds a minimal frontmatter block when opting in a plain eligible Markdown note", () => {
    expect(changeNoteOptIn({ path: "Notes/Plain.md", bytes: "Private body\n", optedIn: true })).toBe(
      "---\nnotion_sync: true\n---\nPrivate body\n",
    );
  });

  it.each([
    [".obsidian/plugins/example.md", "---\nnotion_sync: false\n---\nprivate\n"],
    ["Templates/template.md", "---\nnotion_sync: false\n---\nprivate\n"],
    ["Bridge Conflicts/item.md", "---\nnotion_sync: false\n---\nprivate\n"],
    ["Notes/item.bridge-conflict.md", "---\nnotion_sync: false\n---\nprivate\n"],
    ["Grandbox Bridge.md", "---\nnotion_sync: false\n---\nprivate\n"],
    ["Repositories/generated.md", "---\nnotion_sync: false\n---\n<!-- dual-scribe-github:start:repository -->\nprivate\n<!-- dual-scribe-github:end:repository -->\n"],
  ])("rejects an excluded target: %s", (path, bytes) => {
    expect(() => changeNoteOptIn({ path, bytes, optedIn: true })).toThrow(NoteCommandError);
  });

  it("rejects a generated GitHub note identified only by a quoted YAML tag", () => {
    const before = "---\nnotion_sync: false\ntags: [\"dual-scribe/github/repository\"]\n---\nGenerated body\n";

    expect(() => changeNoteOptIn({ path: "Repositories/tag-only.md", bytes: before, optedIn: true })).toThrow(NoteCommandError);
    expect(before).toBe("---\nnotion_sync: false\ntags: [\"dual-scribe/github/repository\"]\n---\nGenerated body\n");
  });

  it.each([
    ["a nested owned key", "---\nmetadata:\n  notion_sync: false\n---\nBody\n"],
    ["a quoted root owned key", "---\n\"notion_sync\": false\n---\nBody\n"],
    ["quoted and plain duplicate owned keys", "---\n\"notion_sync\": false\nnotion_sync: false\n---\nBody\n"],
    ["an explicit-key mapping", "---\n? notion_sync\n: false\n---\nBody\n"],
    ["otherwise malformed YAML", "---\ntags: [unterminated\nnotion_sync: false\n---\nBody\n"],
  ])("fails closed without changing source for %s", (_description, before) => {
    expect(() => changeNoteOptIn({ path: "Notes/Unsafe.md", bytes: before, optedIn: true })).toThrow(NoteCommandError);
    expect(before).toBe(before);
  });
});
