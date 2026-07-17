import { describe, expect, it } from "vitest";
import {
  GraphRenderer,
  type GraphRendererSigma,
  type GraphRendererSigmaFactory,
} from "../src/graph/sigma-renderer.ts";
import { GRAPH_FIXTURE } from "./fixtures.ts";

function rendererHarness() {
  let clickNode: ((nodeId: string) => void) | null = null;
  const calls = { refresh: 0, kill: 0, open: [] as Array<{ url: string; target: string; features: string }> };
  const sigma: GraphRendererSigma = {
    onClickNode(listener) {
      clickNode = listener;
    },
    refresh() {
      calls.refresh += 1;
    },
    kill() {
      calls.kill += 1;
    },
    zoomIn() {},
    zoomOut() {},
    resetZoom() {},
  };
  const factory: GraphRendererSigmaFactory = { create: () => sigma };
  const renderer = new GraphRenderer({
    container: {} as HTMLElement,
    createSigma: factory,
    createLayout: () => ({ startAfterFirstPaint() {}, stop() {}, kill() {} }),
    openExternal(url, target, features) {
      calls.open.push({ url, target, features });
    },
  });
  return {
    renderer,
    calls,
    click(id: string) {
      clickNode?.(id);
    },
  };
}

describe("GraphRenderer", () => {
  it("never navigates on node click and opens only an explicitly selected safe action", () => {
    const h = rendererHarness();
    h.renderer.replace(GRAPH_FIXTURE);

    h.click("note:paired");
    expect(h.calls.open).toEqual([]);
    h.renderer.openSelected("notion");

    expect(h.calls.open).toEqual([
      {
        url: "https://www.notion.so/2fba54e969b84ab28bca9487f960834b",
        target: "_blank",
        features: "noopener,noreferrer",
      },
    ]);
  });

  it("updates GitHub visibility without deleting the source graph", () => {
    const h = rendererHarness();
    h.renderer.replace(GRAPH_FIXTURE);
    h.renderer.setGithubLevel("activities");

    expect(h.renderer.visibleNodeIds).toContain("github:branch:main");
    expect(h.renderer.document).toEqual(GRAPH_FIXTURE);
    expect(h.calls.refresh).toBeGreaterThan(0);
  });

  it("stops and kills a previous layout before replacing or locking a graph", () => {
    const events: string[] = [];
    const h = rendererHarness();
    const renderer = new GraphRenderer({
      container: {} as HTMLElement,
      createSigma: {
        create: () => ({
          onClickNode() {},
          refresh() {},
          kill() {},
          zoomIn() {},
          zoomOut() {},
          resetZoom() {},
        }),
      },
      createLayout: () => ({ startAfterFirstPaint() {}, stop: () => events.push("stop"), kill: () => events.push("kill") }),
    });
    renderer.replace(GRAPH_FIXTURE);
    renderer.replace(GRAPH_FIXTURE);
    renderer.destroy();

    expect(events).toEqual(["stop", "kill", "stop", "kill"]);
  });
});
