import type { BridgeRunSummary } from "@grandbox-bridge/shared";
import type { BridgeConfiguration, BridgeServiceState } from "./controller.js";

export const STATUS_NOTE_PATH = "Grandbox Bridge.md";
export const STATUS_REGION_START = "<!-- grandbox-bridge:status:start -->";
export const STATUS_REGION_END = "<!-- grandbox-bridge:status:end -->";

export interface StatusNoteView {
  readonly configuration: BridgeConfiguration;
  readonly service: BridgeServiceState;
  readonly summary: BridgeRunSummary | null;
}

export class StatusNoteError extends Error {
  public constructor() {
    super("Bridge status note unavailable");
    this.name = "StatusNoteError";
  }
}

function count(value: string, needle: string): number {
  let matches = 0;
  let index = 0;
  while (true) {
    const next = value.indexOf(needle, index);
    if (next === -1) return matches;
    matches += 1;
    index = next + needle.length;
  }
}

function statusRegion(view: StatusNoteView): string {
  const lines = [
    STATUS_REGION_START,
    "## Managed bridge status",
    `Configuration: ${view.configuration}`,
    `Background service: ${view.service}`,
  ];
  if (view.summary === null) {
    lines.push("Last run: none");
  } else {
    lines.push(
      `Outcome: ${view.summary.outcome}`,
      `Planned: ${view.summary.planned}`,
      `Writes: ${view.summary.writes}`,
      `Conflicts: ${view.summary.conflicts}`,
      `Errors: ${view.summary.errors}`,
    );
  }
  lines.push(STATUS_REGION_END);
  return lines.join("\n");
}

/** Replaces exactly one existing status region, or creates the fixed root note. */
export function updateStatusNote(existing: string | null, view: StatusNoteView): string {
  const next = statusRegion(view);
  if (existing === null) return `# Grandbox Bridge\n\n${next}\n`;
  if (typeof existing !== "string") throw new StatusNoteError();
  if (count(existing, STATUS_REGION_START) !== 1 || count(existing, STATUS_REGION_END) !== 1) {
    throw new StatusNoteError();
  }
  const start = existing.indexOf(STATUS_REGION_START);
  const endMarker = existing.indexOf(STATUS_REGION_END);
  if (start < 0 || endMarker < start) throw new StatusNoteError();
  const end = endMarker + STATUS_REGION_END.length;
  return `${existing.slice(0, start)}${next}${existing.slice(end)}`;
}
