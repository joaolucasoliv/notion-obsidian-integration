export interface GraphStatus {
  readonly generatedAt: string;
  readonly nodes: number;
  readonly edges: number;
  readonly conflicts: number;
  readonly stale: boolean;
}

export interface StatusStrip {
  setStatus(status: GraphStatus): void;
}

export function createStatusStrip(root: HTMLElement): StatusStrip {
  const strip = document.createElement("footer");
  strip.className = "status-strip";
  strip.setAttribute("aria-live", "polite");
  root.append(strip);
  return {
    setStatus(status): void {
      const timestamp = new Date(status.generatedAt);
      const acceptedAt = Number.isNaN(timestamp.getTime()) ? "unknown time" : timestamp.toLocaleString();
      strip.textContent = `${status.nodes} nodes · ${status.edges} edges · ${status.conflicts} conflicts · accepted ${acceptedAt}${status.stale ? " · refresh needs attention" : ""} · End-to-end encrypted`;
    },
  };
}
