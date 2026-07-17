import Sigma from "sigma";
import type { GraphEdgeAttributes, GraphModel, GraphNodeAttributes } from "./build-graph.ts";
import type { GraphRendererSigma, GraphRendererSigmaFactory } from "./sigma-renderer.ts";
import type { Theme } from "../ui/theme.ts";

/** Browser-only Sigma adapter. Keeping it separate avoids WebGL evaluation in non-browser tests. */
export function createBrowserSigmaFactory(getTheme: () => Theme): GraphRendererSigmaFactory {
  return {
    create(graph: GraphModel["graph"], container: HTMLElement): GraphRendererSigma {
      const sigma = new Sigma<GraphNodeAttributes, GraphEdgeAttributes>(graph, container, {
        renderEdgeLabels: false,
        labelRenderedSizeThreshold: 7,
        labelColor: { color: getTheme() === "dark" ? "#d7dde4" : "#24303a" },
        labelFont: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        zIndex: true,
      });
      return {
        onClickNode(listener): void {
          sigma.on("clickNode", ({ node }) => listener(node));
        },
        refresh: () => sigma.refresh(),
        kill: () => sigma.kill(),
        zoomIn: () => void sigma.getCamera().animatedZoom(1.5),
        zoomOut: () => void sigma.getCamera().animatedUnzoom(1.5),
        resetZoom: () => void sigma.getCamera().animatedReset(),
      };
    },
  };
}
