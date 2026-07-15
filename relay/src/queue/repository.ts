const DAY_MILLISECONDS = 86_400_000;
const CONSUMED_EVENT_RETENTION_DAYS = 30;
const MAX_COMPARE_AND_SET_RETRIES = 64;
const RATE_COUNTER_NAMES = new Set(["api", "webhook", "graph"]);

export type RateCounterName = "api" | "webhook" | "graph";

export interface WebhookEventInput {
  readonly id: string;
  readonly type: string;
  readonly entityId: string;
  readonly eventAt: string;
}

export interface StoredWebhookEvent extends WebhookEventInput {
  readonly installationId: string;
  readonly receivedAt: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly consumedAt: string | null;
}

export interface RateCounterState {
  readonly windowStartedAt: string;
  readonly count: number;
}

export interface RateCounterResult extends RateCounterState {
  readonly allowed: boolean;
}

/**
 * Database primitives deliberately stay independent of a client framework.
 * A service-role Edge Function supplies a transactional/CAS implementation;
 * repository code never receives credentials or a request payload.
 */
export interface EventRepositoryStore {
  insertEventIfAbsent(event: StoredWebhookEvent): Promise<boolean>;
  listEvents(installationId: string): Promise<readonly StoredWebhookEvent[]>;
  compareAndSetLease(input: {
    readonly installationId: string;
    readonly eventId: string;
    readonly expectedLeaseExpiresAt: string | null;
    readonly leaseOwner: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean>;
  compareAndSetConsumed(input: {
    readonly installationId: string;
    readonly eventId: string;
    readonly expectedLeaseOwner: string;
    readonly consumedAt: string;
  }): Promise<boolean>;
  deleteConsumedBefore(installationId: string, cutoff: string): Promise<number>;
  putPageRegistration(input: {
    readonly installationId: string;
    readonly notionPageId: string;
    readonly bridgeId: string;
  }): Promise<void>;
  findBridgeId(installationId: string, notionPageId: string): Promise<string | null>;
  readRateCounter(installationId: string, counter: RateCounterName): Promise<RateCounterState>;
  compareAndSetRateCounter(input: {
    readonly installationId: string;
    readonly counter: RateCounterName;
    readonly expected: RateCounterState;
    readonly next: RateCounterState;
  }): Promise<boolean>;
}

function assertText(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${name}`);
  }
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid timestamp");
  }
  return value.toISOString();
}

function compareEvents(left: StoredWebhookEvent, right: StoredWebhookEvent): number {
  return left.receivedAt.localeCompare(right.receivedAt) || left.id.localeCompare(right.id);
}

function isAvailable(event: StoredWebhookEvent, now: string): boolean {
  return event.consumedAt === null && (event.leaseExpiresAt === null || event.leaseExpiresAt <= now);
}

export class EventRepository {
  constructor(private readonly store: EventRepositoryStore) {}

  async enqueue(installationId: string, event: WebhookEventInput, receivedAt: Date): Promise<boolean> {
    assertText(installationId, "installation ID");
    assertText(event.id, "event ID");
    assertText(event.type, "event type");
    assertText(event.entityId, "entity ID");
    assertText(event.eventAt, "event timestamp");
    return this.store.insertEventIfAbsent({
      installationId,
      id: event.id,
      type: event.type,
      entityId: event.entityId,
      eventAt: event.eventAt,
      receivedAt: timestamp(receivedAt),
      leaseOwner: null,
      leaseExpiresAt: null,
      consumedAt: null,
    });
  }

  async claim(installationId: string, worker: string, now: Date, leaseSeconds: number, limit = 1): Promise<StoredWebhookEvent[]> {
    assertText(installationId, "installation ID");
    assertText(worker, "worker");
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0 || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Invalid lease request");
    }

    const nowText = timestamp(now);
    const leaseExpiresAt = timestamp(new Date(now.getTime() + leaseSeconds * 1_000));
    const claimed: StoredWebhookEvent[] = [];
    const candidates = (await this.store.listEvents(installationId)).filter((event) => isAvailable(event, nowText)).sort(compareEvents);

    for (const candidate of candidates) {
      if (claimed.length === limit) {
        break;
      }
      const leased = await this.store.compareAndSetLease({
        installationId,
        eventId: candidate.id,
        expectedLeaseExpiresAt: candidate.leaseExpiresAt,
        leaseOwner: worker,
        leaseExpiresAt,
      });
      if (leased) {
        claimed.push({ ...candidate, leaseOwner: worker, leaseExpiresAt });
      }
    }
    return claimed;
  }

  async acknowledge(installationId: string, eventId: string, worker: string, consumedAt: Date): Promise<void> {
    assertText(installationId, "installation ID");
    assertText(eventId, "event ID");
    assertText(worker, "worker");
    const consumedAtText = timestamp(consumedAt);

    for (let attempt = 0; attempt < MAX_COMPARE_AND_SET_RETRIES; attempt += 1) {
      const current = (await this.store.listEvents(installationId)).find((event) => event.id === eventId);
      if (!current) {
        throw new Error("Webhook event was not found for this installation");
      }
      if (current.consumedAt !== null) {
        return;
      }
      if (current.leaseOwner !== worker) {
        throw new Error("Webhook event lease is not owned by this worker");
      }
      if (await this.store.compareAndSetConsumed({
        installationId,
        eventId,
        expectedLeaseOwner: worker,
        consumedAt: consumedAtText,
      })) {
        return;
      }
    }
    throw new Error("Webhook event acknowledgement conflicted repeatedly");
  }

  async cleanupConsumed(installationId: string, now: Date): Promise<number> {
    assertText(installationId, "installation ID");
    const cutoff = timestamp(new Date(now.getTime() - CONSUMED_EVENT_RETENTION_DAYS * DAY_MILLISECONDS));
    return this.store.deleteConsumedBefore(installationId, cutoff);
  }

  async registerPage(installationId: string, notionPageId: string, bridgeId: string): Promise<void> {
    assertText(installationId, "installation ID");
    assertText(notionPageId, "Notion page ID");
    assertText(bridgeId, "bridge ID");
    await this.store.putPageRegistration({ installationId, notionPageId, bridgeId });
  }

  async routePage(installationId: string, notionPageId: string): Promise<string | null> {
    assertText(installationId, "installation ID");
    assertText(notionPageId, "Notion page ID");
    return this.store.findBridgeId(installationId, notionPageId);
  }

  async incrementRateCounter(
    installationId: string,
    counter: RateCounterName,
    now: Date,
    limit: number,
    windowSeconds: number,
  ): Promise<RateCounterResult> {
    assertText(installationId, "installation ID");
    if (!RATE_COUNTER_NAMES.has(counter)) {
      throw new Error("Invalid aggregate rate counter");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) {
      throw new Error("Invalid rate limit");
    }
    const nowText = timestamp(now);
    const windowMilliseconds = windowSeconds * 1_000;

    for (let attempt = 0; attempt < MAX_COMPARE_AND_SET_RETRIES; attempt += 1) {
      const current = await this.store.readRateCounter(installationId, counter);
      const windowStartedAt = new Date(current.windowStartedAt).getTime();
      if (!Number.isFinite(windowStartedAt)) {
        throw new Error("Invalid stored rate counter timestamp");
      }
      const windowExpired = now.getTime() - windowStartedAt >= windowMilliseconds;
      if (!windowExpired && current.count >= limit) {
        return { allowed: false, ...current };
      }
      const next: RateCounterState = windowExpired
        ? { windowStartedAt: nowText, count: 1 }
        : { windowStartedAt: current.windowStartedAt, count: current.count + 1 };
      if (await this.store.compareAndSetRateCounter({ installationId, counter, expected: current, next })) {
        return { allowed: true, ...next };
      }
    }
    throw new Error("Rate counter conflicted repeatedly");
  }
}
