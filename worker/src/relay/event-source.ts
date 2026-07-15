import type { RelayClaim, RelayClientPort, RelayEvent } from "./client.js";

export type { RelayEvent } from "./client.js";

/** Typed event boundary so worker orchestration cannot see transport details. */
export class RelayEventSource {
  public constructor(private readonly client: RelayClientPort) {}

  public claim(workerId: string, limit: number): Promise<RelayClaim> {
    return this.client.claimEvents(workerId, limit);
  }

  public acknowledge(workerId: string, eventIds: readonly string[]): Promise<void> {
    return this.client.acknowledgeEvents(workerId, eventIds);
  }

  public register(pageId: string, bridgeId: string): Promise<void> {
    return this.client.registerPage(pageId, bridgeId);
  }

  public unregister(pageId: string, bridgeId: string): Promise<void> {
    return this.client.unregisterPage(pageId, bridgeId);
  }
}
