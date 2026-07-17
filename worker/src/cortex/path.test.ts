import { describe, expect, it } from "vitest";
import {
  CortexPathError,
  projectCortexLocalPath,
  projectCortexTreePaths,
} from "./path.js";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const RESEARCH_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

describe("projectCortexTreePaths", () => {
  it("projects the root and descendants into the fixed reserved layout", () => {
    const paths = projectCortexTreePaths({
      rootPageId: ROOT_ID,
      pages: [
        { pageId: ROOT_ID, parentPageId: null, rootPageId: ROOT_ID, title: "The Cortex" },
        { pageId: RESEARCH_ID, parentPageId: ROOT_ID, rootPageId: ROOT_ID, title: "Research" },
        { pageId: PROJECT_ID, parentPageId: RESEARCH_ID, rootPageId: ROOT_ID, title: "Project" },
      ],
    });

    expect(paths.get(ROOT_ID)).toBe("The Cortex.md");
    expect(paths.get(RESEARCH_ID)).toBe("The Cortex/Research.md");
    expect(paths.get(PROJECT_ID)).toBe("The Cortex/Research/Project.md");
  });

  it("rejects case-insensitive local collisions and collisions with normal or legacy paths", () => {
    const base = {
      rootPageId: ROOT_ID,
      pages: [
        { pageId: ROOT_ID, parentPageId: null, rootPageId: ROOT_ID, title: "The Cortex" },
        { pageId: RESEARCH_ID, parentPageId: ROOT_ID, rootPageId: ROOT_ID, title: "Research" },
      ],
    } as const;

    expect(() => projectCortexTreePaths({
      ...base,
      pages: [...base.pages, { pageId: PROJECT_ID, parentPageId: ROOT_ID, rootPageId: ROOT_ID, title: "research" }],
    })).toThrow(CortexPathError);
    expect(() => projectCortexTreePaths({ ...base, occupiedPaths: ["The Cortex/Research.md"] })).toThrow(CortexPathError);
    expect(() => projectCortexTreePaths({ ...base, legacyPaths: ["The Cortex/Research.md"] })).toThrow(CortexPathError);
  });

  it.each(["", ".", "..", "../escape", "nested/name", "nested\\name", "bad\u0000name", "trailing."])(
    "rejects an unsafe title used as a Markdown filename: %j",
    (title) => {
      expect(() => projectCortexLocalPath({
        rootPageId: ROOT_ID,
        pageId: RESEARCH_ID,
        parentPageId: ROOT_ID,
        title,
        parentLocalPath: "The Cortex.md",
      })).toThrow(CortexPathError);
    },
  );

  it.each(["heading#anchor", "title|alias", "citation^block"])(
    "rejects wiki-link control punctuation in a projected title: %j",
    (title) => {
      expect(() => projectCortexLocalPath({
        rootPageId: ROOT_ID,
        pageId: RESEARCH_ID,
        parentPageId: ROOT_ID,
        title,
        parentLocalPath: "The Cortex.md",
      })).toThrow(CortexPathError);
    },
  );

  it("refuses an escaping parent projection even when supplied directly", () => {
    expect(() => projectCortexLocalPath({
      rootPageId: ROOT_ID,
      pageId: RESEARCH_ID,
      parentPageId: ROOT_ID,
      title: "Research",
      parentLocalPath: "../outside.md",
    })).toThrow(CortexPathError);
  });
});
