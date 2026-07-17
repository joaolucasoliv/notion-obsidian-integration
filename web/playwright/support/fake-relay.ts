import type { Page } from "@playwright/test";
import type { GraphEnvelopeV1 } from "@grandbox-bridge/shared";
import { GRAPH_ID } from "./encrypted-fixtures.ts";

export interface FakeRelay {
  readonly requests: () => number;
  setEnvelope(envelope: GraphEnvelopeV1): void;
}

/** The browser suite intercepts only local synthetic ciphertext. */
export async function attachFakeRelay(page: Page, initialEnvelope: GraphEnvelopeV1): Promise<FakeRelay> {
  let envelope = initialEnvelope;
  let count = 0;
  await page.route(`**/api/graph/${GRAPH_ID}`, async (route) => {
    count += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(envelope),
    });
  });
  return {
    requests: () => count,
    setEnvelope(next): void {
      envelope = next;
    },
  };
}
