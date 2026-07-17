import { describe, expect, it } from "vitest";
import {
  CortexMarkdownError,
  renderCortexMarkdown,
  renderCortexParentBreadcrumb,
  stripCortexManagedMarkdown,
} from "./markdown.js";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

describe("Cortex Markdown codec", () => {
  it("renders and parses the exact visible parent breadcrumb with a real wiki-link", () => {
    const exact = "<!-- grandbox-cortex:parent -->\n> [!info]- Cortex parent\n> [[The Cortex]]";
    expect(renderCortexParentBreadcrumb("The Cortex.md")).toBe(exact);

    expect(stripCortexManagedMarkdown({
      markdown: `${exact}\n\nBody`,
      expectedParentWikiLink: "The Cortex",
      expectedChildPageIds: [],
    })).toBe("Body");
  });

  it("converts ordered Notion child pages to stable markers and restores them without changing the remote body", () => {
    const local = renderCortexMarkdown({
      bodyMarkdown: "Notion body",
      parentWikiLink: "The Cortex",
      directChildPageIds: [FIRST_ID, SECOND_ID],
    });
    const firstMarker = `<!-- grandbox-cortex:child-page:${FIRST_ID} -->`;
    const secondMarker = `<!-- grandbox-cortex:child-page:${SECOND_ID} -->`;

    expect(local).toBe(
      `<!-- grandbox-cortex:parent -->\n> [!info]- Cortex parent\n> [[The Cortex]]\n\nNotion body${firstMarker}${secondMarker}`,
    );
    expect(stripCortexManagedMarkdown({
      markdown: local,
      expectedParentWikiLink: "The Cortex",
      expectedChildPageIds: [FIRST_ID, SECOND_ID],
    })).toBe("Notion body");
    expect(renderCortexMarkdown({
      bodyMarkdown: stripCortexManagedMarkdown({
        markdown: local,
        expectedParentWikiLink: "The Cortex",
        expectedChildPageIds: [FIRST_ID, SECOND_ID],
      }),
      parentWikiLink: "The Cortex",
      directChildPageIds: [FIRST_ID, SECOND_ID],
    })).toBe(local);
  });

  it("fails closed when an owned marker is malformed instead of stripping user text", () => {
    expect(() => stripCortexManagedMarkdown({
      markdown: "Body<!-- grandbox-cortex:child-page:not-a-uuid -->",
      expectedParentWikiLink: null,
      expectedChildPageIds: [],
    })).toThrow(
      CortexMarkdownError,
    );
  });
});
