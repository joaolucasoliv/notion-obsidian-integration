import { describe, expect, it } from "vitest";
import { parseNotionParentPageId } from "./onboarding.js";

const PAGE_ID = "22222222-2222-4222-8222-222222222222";

describe("parseNotionParentPageId", () => {
  it("accepts a canonical page ID or a Notion page URL without retaining the URL", () => {
    expect(parseNotionParentPageId(PAGE_ID)).toBe(PAGE_ID);
    expect(parseNotionParentPageId(`https://www.notion.so/Grandbox-${PAGE_ID.replaceAll("-", "")}`)).toBe(PAGE_ID);
  });

  it("accepts the current app.notion.com page link copied by Notion", () => {
    expect(parseNotionParentPageId(
      `https://app.notion.com/p/Grandbox-Bridge-${PAGE_ID.replaceAll("-", "")}?source=copy_link`,
    )).toBe(PAGE_ID);
  });

  it("rejects a non-Notion URL or ambiguous page reference", () => {
    expect(() => parseNotionParentPageId("https://example.com/page-22222222222222222222222222222222")).toThrow(/Notion page/i);
    expect(() => parseNotionParentPageId("not-a-page-id")).toThrow(/Notion page/i);
  });
});
