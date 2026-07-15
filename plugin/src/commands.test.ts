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
});
