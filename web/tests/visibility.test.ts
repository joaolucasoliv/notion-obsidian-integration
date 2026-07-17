import { describe, expect, it } from "vitest";
import { buildGraphModel } from "../src/graph/build-graph.ts";
import { defaultGraphVisibility, visibleGraph } from "../src/graph/visibility.ts";
import { GRAPH_FIXTURE } from "./fixtures.ts";

describe("visibleGraph", () => {
  it("reveals GitHub repositories and activities in their explicit hierarchy", () => {
    const model = buildGraphModel(GRAPH_FIXTURE);

    const repositories = visibleGraph(model.document, { ...defaultGraphVisibility(), githubLevel: "repositories" });
    const activities = visibleGraph(model.document, { ...defaultGraphVisibility(), githubLevel: "activities" });

    expect(repositories.nodeIds).toContain("github:repository:nodal");
    expect(repositories.nodeIds).not.toContain("github:branch:main");
    expect(activities.nodeIds).toContain("github:branch:main");
    expect(activities.edgeIds).toContain("edge:repository:branch");
  });

  it("filters by domain, search, and focus without mutating the source document", () => {
    const document = structuredClone(GRAPH_FIXTURE);
    const visible = visibleGraph(document, {
      ...defaultGraphVisibility(),
      githubLevel: "activities",
      domains: new Set(["research"]),
      search: "paired",
      focusNodeId: "note:paired",
    });

    expect(visible.nodeIds).toEqual(new Set(["note:paired", "cluster:research", "vault:root"]));
    expect(document).toEqual(GRAPH_FIXTURE);
  });
});
