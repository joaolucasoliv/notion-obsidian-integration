import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalNoteParseError, parseLocalNote } from "../markdown/frontmatter.js";
import { classifyEligibility, type Eligibility } from "./eligibility.js";

function assertEligibilityContractIsWritable(value: Eligibility): void {
  value.eligible = value.eligible;
  if (!value.eligible) {
    value.reason = value.reason;
  }
}

const fixture = (relativePath: string): Promise<string> =>
  readFile(
    fileURLToPath(new URL(`../../../tests/fixtures/vault/${relativePath}`, import.meta.url)),
    "utf8",
  );

describe("classifyEligibility", () => {
  it("requires the exact YAML boolean opt-in", () => {
    const optedIn = parseLocalNote("Notes/opted-in.md", "---\nnotion_sync: true\n---\nBody");
    const optedOut = parseLocalNote("Notes/opted-out.md", "---\nnotion_sync: false\n---\nBody");
    const absent = parseLocalNote("Notes/absent.md", "Body");

    const eligible = classifyEligibility(optedIn);
    const optedOutEligibility = classifyEligibility(optedOut);
    const absentEligibility = classifyEligibility(absent);

    expect(eligible).toEqual({ eligible: true });
    expect(optedOutEligibility).toEqual({ eligible: false, reason: "not-opted-in" });
    expect(absentEligibility).toEqual({ eligible: false, reason: "not-opted-in" });
    expect(Object.keys(eligible)).toEqual(["eligible"]);
    expect(Object.keys(optedOutEligibility).sort()).toEqual(["eligible", "reason"]);
    expect(Object.isFrozen(eligible)).toBe(false);
    expect(Object.isFrozen(optedOutEligibility)).toBe(false);
    assertEligibilityContractIsWritable(eligible);
    assertEligibilityContractIsWritable(optedOutEligibility);
    expect(() =>
      parseLocalNote("Notes/string.md", "---\nnotion_sync: \"true\"\n---\nBody"),
    ).toThrow(LocalNoteParseError);
  });

  it.each([
    [".obsidian/plugins/note.md", "technical-path"],
    ["Notes/.cache/note.md", "technical-path"],
    [".hidden.md", "technical-path"],
    ["Templates/template.md", "technical-path"],
    ["templates/nested/template.md", "technical-path"],
    ["Bridge Conflicts/conflict.md", "conflict-artifact"],
    ["Notes/decision.bridge-conflict.md", "conflict-artifact"],
    ["Grandbox Bridge.md", "status-note"],
  ] as const)("excludes %s as %s before opt-in", (path, reason) => {
    const note = parseLocalNote(path, "---\nnotion_sync: false\n---\nBody");
    expect(classifyEligibility(note)).toEqual({ eligible: false, reason });
  });

  it("limits the exact status-note exclusion to the vault-root path", () => {
    const note = parseLocalNote(
      "Notes/Grandbox Bridge.md",
      "---\nnotion_sync: true\n---\nManual note with the same basename",
    );
    expect(classifyEligibility(note)).toEqual({ eligible: true });
  });

  it("excludes one exact paired GitHub-managed region even beneath Repositories", async () => {
    const note = parseLocalNote(
      "Repositories/generated.md",
      await fixture("Repositories/generated.md"),
    );

    expect(classifyEligibility(note)).toEqual({ eligible: false, reason: "generated-github" });
  });

  it("does not exclude a manual Repositories note solely by directory", async () => {
    const note = parseLocalNote("Repositories/manual.md", await fixture("Repositories/manual.md"));
    expect(classifyEligibility(note)).toEqual({ eligible: true });
  });

  it("excludes generated GitHub tags without requiring a managed region", () => {
    const note = parseLocalNote(
      "Notes/tagged.md",
      "---\nnotion_sync: true\ntags: [manual, dual-scribe/github/repository]\n---\nBody",
    );
    expect(classifyEligibility(note)).toEqual({ eligible: false, reason: "generated-github" });
  });

  it.each([
    "<!-- dual-scribe-github:start:repository -->\nBody",
    "<!-- dual-scribe-github:end:repository -->\nBody",
    "<!-- dual-scribe-github:start:repository -->\nBody\n<!-- dual-scribe-github:end:dashboard -->",
    "<!-- dual-scribe-github:start:repository -->\n<!-- dual-scribe-github:start:repository -->\n<!-- dual-scribe-github:end:repository -->\n<!-- dual-scribe-github:end:repository -->",
    "<!-- dual-scribe-github:end:repository -->\n<!-- dual-scribe-github:start:repository -->",
  ])("fails closed on mismatched, incomplete, reversed, or nested managed markers", (body) => {
    const note = parseLocalNote("Notes/markers.md", `---\nnotion_sync: true\n---\n${body}`);
    expect(classifyEligibility(note)).toEqual({ eligible: false, reason: "invalid-frontmatter" });
  });

  it("ignores unrelated HTML comments that are not tracker markers", () => {
    const note = parseLocalNote(
      "Repositories/manual.md",
      "---\nnotion_sync: true\n---\n<!-- dual-scribe-githubish:start:repository -->\nManual",
    );
    expect(classifyEligibility(note)).toEqual({ eligible: true });
  });
});
