import ForceAtlas2Layout from "graphology-layout-forceatlas2/worker";
import type Graph from "graphology";

export interface ForceLayoutSupervisor {
  start(): void;
  stop(): void;
  kill(): void;
}

export interface ForceLayoutHandle {
  startAfterFirstPaint(): void;
  stop(): void;
  kill(): void;
}

export interface ForceLayoutInput {
  readonly graph: Graph;
  readonly reducedMotion: boolean;
  readonly createSupervisor: (graph: Graph) => ForceLayoutSupervisor;
  readonly afterFirstPaint: (callback: () => void) => void;
}

/** Defers worker creation until the renderer has painted deterministic positions once. */
export function createForceLayout(input: ForceLayoutInput): ForceLayoutHandle {
  let supervisor: ForceLayoutSupervisor | null = null;
  let killed = false;
  let startScheduled = false;

  return {
    startAfterFirstPaint(): void {
      if (killed || input.reducedMotion || startScheduled) return;
      startScheduled = true;
      input.afterFirstPaint(() => {
        if (killed || input.reducedMotion) return;
        supervisor ??= input.createSupervisor(input.graph);
        supervisor.start();
      });
    },
    stop(): void {
      supervisor?.stop();
    },
    kill(): void {
      if (killed) return;
      killed = true;
      supervisor?.stop();
      supervisor?.kill();
      supervisor = null;
    },
  };
}

export function createBrowserForceLayout(graph: Graph, reducedMotion: boolean): ForceLayoutHandle {
  return createForceLayout({
    graph,
    reducedMotion,
    createSupervisor: (source) => new ForceAtlas2Layout(source, { settings: { gravity: 1, scalingRatio: 4 } }),
    afterFirstPaint: (callback) => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => callback());
      else queueMicrotask(callback);
    },
  });
}
