import { describe, expect, it } from "vitest";
import { buildGraphModel } from "../src/graph/build-graph.ts";
import { createForceLayout } from "../src/graph/force-layout.ts";
import { GRAPH_FIXTURE } from "./fixtures.ts";

describe("createForceLayout", () => {
  it("creates the ForceAtlas worker only after first paint and stops it before killing", () => {
    const events: string[] = [];
    const paintCallbacks: Array<() => void> = [];
    const layout = createForceLayout({
      graph: buildGraphModel(GRAPH_FIXTURE).graph,
      reducedMotion: false,
      afterFirstPaint(callback) {
        paintCallbacks.push(callback);
      },
      createSupervisor() {
        events.push("create");
        return {
          start: () => events.push("start"),
          stop: () => events.push("stop"),
          kill: () => events.push("kill"),
        };
      },
    });

    layout.startAfterFirstPaint();
    expect(events).toEqual([]);
    paintCallbacks[0]!();
    layout.stop();
    layout.kill();

    expect(events).toEqual(["create", "start", "stop", "stop", "kill"]);
  });

  it("keeps deterministic positions static when reduced motion is preferred", () => {
    const events: string[] = [];
    const layout = createForceLayout({
      graph: buildGraphModel(GRAPH_FIXTURE).graph,
      reducedMotion: true,
      afterFirstPaint: (callback) => callback(),
      createSupervisor: () => ({ start: () => events.push("start"), stop: () => events.push("stop"), kill: () => events.push("kill") }),
    });

    layout.startAfterFirstPaint();
    expect(events).toEqual([]);
  });
});
