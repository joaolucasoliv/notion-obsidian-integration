import { describe, expect, it } from "vitest";
import {
  DOMAIN_RULES,
  INSTALLATION_ID,
  PAIR_MAP,
  graphVaultFixture,
  idFor,
} from "../../../tests/fixtures/graph/graph-vault.js";
import { buildGraphProjection } from "./projection.js";

describe("buildGraphProjection", () => {
  it("resolves exact and unique links but never guesses an ambiguous basename", () => {
    const result = buildGraphProjection(graphVaultFixture(), PAIR_MAP, INSTALLATION_ID, DOMAIN_RULES);
    const homeId = idFor("Home.md");
    const researchId = idFor("Research/Index.md");

    expect(result.edges).toContainEqual(
      expect.objectContaining({ source: homeId, target: researchId, kind: "wikilink" }),
    );
    expect(result.edges).toContainEqual(
      expect.objectContaining({ source: homeId, target: researchId, kind: "markdown-link" }),
    );
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        source: idFor("Personal/Journal.md"),
        target: researchId,
        kind: "wikilink",
      }),
    );
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        source: idFor("Academics/Thesis.md"),
        target: homeId,
        kind: "wikilink",
      }),
    );
    expect(
      result.edges.some(
        (edge) =>
          edge.source === homeId &&
          (edge.target === idFor("A/Plan.md") || edge.target === idFor("B/Plan.md")),
      ),
    ).toBe(false);
  });

  it("contains graph metadata but no note bodies or excerpts", () => {
    const projection = buildGraphProjection(graphVaultFixture(), PAIR_MAP, INSTALLATION_ID, DOMAIN_RULES);
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain("PRIVATE BODY SENTINEL");
    expect(serialized).not.toMatch(/excerpt|bodyMarkdown|content/);
  });

  it("keeps graph-only conflict and GitHub tracker metadata while excluding technical paths", () => {
    const projection = buildGraphProjection(graphVaultFixture(), PAIR_MAP, INSTALLATION_ID, DOMAIN_RULES);
    const nodeForPath = (path: string) => projection.nodes.find((node) => node.path === path);

    expect(nodeForPath("Bridge Conflicts/Decision.bridge-conflict.md")).toMatchObject({
      kind: "note",
      domain: "other",
    });
    expect(nodeForPath("Repositories/generated.md")).toMatchObject({
      kind: "note",
      domain: "github",
      notionUrl: "https://www.notion.so/github-tracker",
    });
    expect(nodeForPath("Repositories/branch.md")).toMatchObject({ collapsed: true });
    expect(nodeForPath("Repositories/activity.md")).toMatchObject({ collapsed: true });
    expect(nodeForPath("Research/Index.md")?.tags).toEqual(["alpha", "research"]);
    expect(nodeForPath(".obsidian/plugins/private.md")).toBeUndefined();
    expect(nodeForPath("Templates/template.md")).toBeUndefined();
    expect(projection.conflicts).toBe(1);
    expect(projection.nodes).toContainEqual(
      expect.objectContaining({
        kind: "vault",
        id: "vault:root",
        label: "The Grandbox",
      }),
    );
    expect(projection.nodes).toContainEqual(
      expect.objectContaining({ kind: "cluster", domain: "github", collapsed: true }),
    );
    const githubCluster = projection.nodes.find(
      (node) => node.kind === "cluster" && node.domain === "github",
    );
    expect(githubCluster).toBeDefined();
    expect(projection.edges).toContainEqual(
      expect.objectContaining({ kind: "vault", source: "vault:root", target: githubCluster?.id }),
    );
    expect(projection.edges).toContainEqual(
      expect.objectContaining({
        kind: "cluster",
        source: githubCluster?.id,
        target: idFor("Repositories/generated.md"),
      }),
    );
  });

  it("attaches pairing and local Obsidian metadata without serializing source markdown", () => {
    const projection = buildGraphProjection(graphVaultFixture(), PAIR_MAP, INSTALLATION_ID, DOMAIN_RULES);
    const research = projection.nodes.find((node) => node.path === "Research/Index.md");
    const home = projection.nodes.find((node) => node.path === "Home.md");

    expect(research).toMatchObject({
      notionUrl: "https://www.notion.so/research-index",
      obsidianUrl: "obsidian://open?vault=The%20Grandbox&file=Research%2FIndex.md",
    });
    expect(home).toMatchObject({ notionUrl: null });
  });

  it("rejects duplicate normalized paths and emits a byte-identical canonical projection", () => {
    const fixture = graphVaultFixture();
    const first = buildGraphProjection(fixture, PAIR_MAP, INSTALLATION_ID, DOMAIN_RULES);
    const second = buildGraphProjection([...fixture].reverse(), new Map([...PAIR_MAP].reverse()), INSTALLATION_ID, DOMAIN_RULES);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(() =>
      buildGraphProjection(
        [...fixture, { ...fixture[1]!, path: "Research/./Index.md" }],
        PAIR_MAP,
        INSTALLATION_ID,
        DOMAIN_RULES,
      ),
    ).toThrow(/duplicate normalized path/i);
    const hidden = fixture.find((note) => note.path === ".obsidian/plugins/private.md");
    if (hidden === undefined) throw new Error("missing synthetic hidden fixture");
    expect(() =>
      buildGraphProjection(
        [...fixture, { ...hidden, path: ".obsidian/./plugins/private.md" }],
        PAIR_MAP,
        INSTALLATION_ID,
        DOMAIN_RULES,
      ),
    ).toThrow(/duplicate normalized path/i);
  });
});
