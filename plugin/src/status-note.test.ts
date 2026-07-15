import { describe, expect, it } from "vitest";
import { STATUS_REGION_END, STATUS_REGION_START, StatusNoteError, updateStatusNote } from "./status-note.js";

const view = {
  configuration: "ready" as const,
  service: "disabled" as const,
  summary: {
    mode: "apply" as const,
    outcome: "success" as const,
    planned: 2,
    writes: 1,
    pushed: 1,
    pulled: 0,
    conflicts: 0,
    errors: 0,
    graphUploads: 0,
    startedAt: "2026-07-15T12:00:00.000Z",
    completedAt: "2026-07-15T12:00:01.000Z",
  },
};

describe("Grandbox Bridge status note", () => {
  it("preserves all bytes outside one strict managed marker region", () => {
    const before = `# Private heading\n\nKeep this exact.\n${STATUS_REGION_START}\nold safe status\n${STATUS_REGION_END}\n\nDo not rewrite this.\n`;

    const after = updateStatusNote(before, view);

    expect(after).toMatch(/^# Private heading\n\nKeep this exact\.\n/u);
    expect(after).toMatch(/\nDo not rewrite this\.\n$/u);
    expect(after).toContain("Outcome: success");
    expect(after).toContain("Writes: 1");
    expect(after).not.toContain("old safe status");
  });

  it.each([
    `${STATUS_REGION_START}\nmissing end`,
    `${STATUS_REGION_END}\nmissing start`,
    `${STATUS_REGION_START}\nx\n${STATUS_REGION_END}\n${STATUS_REGION_START}\ny\n${STATUS_REGION_END}`,
  ])("fails closed for malformed marker input", (bytes) => {
    expect(() => updateStatusNote(bytes, view)).toThrow(StatusNoteError);
  });
});
