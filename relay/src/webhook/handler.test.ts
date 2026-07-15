import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { signNotionBody, utf8 } from "../auth/hmac.js";
import {
  handleNotionWebhook,
  type Clock,
  type EventRepository,
  type InstallationRepository,
  type PageRegistry,
  type SafeLogger,
  type WebhookDependencies,
  type WebhookInstallation,
} from "./handler.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_INSTALLATION_ID = "12121212-1212-4121-8121-121212121212";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const BLOCK_ID = "33333333-3333-4333-8333-333333333333";
const FIXTURE_BEARER = "fixture-local-bearer-value";
const SECOND_FIXTURE_BEARER = "fixture-second-local-bearer-value";
const FIXTURE_VERIFICATION_TOKEN = "fixture-notion-verification-value";
const SECOND_FIXTURE_VERIFICATION_TOKEN = "fixture-second-notion-verification-value";
const NOW = new Date("2026-07-15T12:00:00.000Z");

class FixtureClock implements Clock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  set(value: Date): void {
    this.value = new Date(value);
  }
}

class FixtureInstallations implements InstallationRepository {
  readonly pendingCiphertexts: string[] = [];
  private readonly id: string;
  private bootstrapPublicJwk: JsonWebKey | null;

  constructor(
    installation: WebhookInstallation = {
      id: INSTALLATION_ID,
      bootstrapPublicJwk: null,
    },
  ) {
    this.id = installation.id;
    this.bootstrapPublicJwk = installation.bootstrapPublicJwk;
  }

  async authenticate(bearer: string): Promise<WebhookInstallation | null> {
    return bearer === FIXTURE_BEARER ? { id: this.id, bootstrapPublicJwk: this.bootstrapPublicJwk } : null;
  }

  async consumeBootstrapPublicJwkAndStorePendingWebhookTokenCiphertext(
    installationId: string,
    ciphertext: string,
  ): Promise<boolean> {
    if (installationId !== this.id || this.bootstrapPublicJwk === null) {
      return false;
    }
    this.pendingCiphertexts.push(ciphertext);
    this.bootstrapPublicJwk = null;
    return true;
  }
}

class TwoInstallationFixture implements InstallationRepository {
  constructor(
    private readonly first: WebhookInstallation,
    private readonly second: WebhookInstallation,
  ) {}

  async authenticate(bearer: string): Promise<WebhookInstallation | null> {
    if (bearer === FIXTURE_BEARER) {
      return this.first;
    }
    if (bearer === SECOND_FIXTURE_BEARER) {
      return this.second;
    }
    return null;
  }

  async consumeBootstrapPublicJwkAndStorePendingWebhookTokenCiphertext(): Promise<boolean> {
    return false;
  }
}

class FixturePages implements PageRegistry {
  readonly routeCalls: string[] = [];

  constructor(private readonly registered = new Set<string>([PAGE_ID])) {}

  async routePage(installationId: string, notionPageId: string): Promise<string | null> {
    this.routeCalls.push(installationId + ":" + notionPageId);
    return this.registered.has(notionPageId) ? "44444444-4444-4444-8444-444444444444" : null;
  }
}

interface EnqueuedEvent {
  readonly installationId: string;
  readonly id: string;
  readonly type: string;
  readonly entityId: string;
  readonly eventAt: string;
}

class FixtureEvents implements EventRepository {
  readonly enqueueCalls: EnqueuedEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly counters = new Map<string, { readonly windowStartedAt: string; readonly count: number }>();

  async enqueue(installationId: string, event: Omit<EnqueuedEvent, "installationId">, _receivedAt: Date): Promise<boolean> {
    const key = installationId + ":" + event.id;
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    this.enqueueCalls.push({ installationId, ...event });
    return true;
  }

  async incrementRateCounter(
    installationId: string,
    _counter: "webhook",
    now: Date,
    limit: number,
    windowSeconds: number,
  ): Promise<{ readonly allowed: boolean; readonly windowStartedAt: string; readonly count: number }> {
    const current = this.counters.get(installationId) ?? { windowStartedAt: now.toISOString(), count: 0 };
    const elapsed = now.getTime() - new Date(current.windowStartedAt).getTime();
    if (elapsed >= windowSeconds * 1_000) {
      const reset = { windowStartedAt: now.toISOString(), count: 1 };
      this.counters.set(installationId, reset);
      return { allowed: true, ...reset };
    }
    if (current.count >= limit) {
      return { allowed: false, ...current };
    }
    const next = { windowStartedAt: current.windowStartedAt, count: current.count + 1 };
    this.counters.set(installationId, next);
    return { allowed: true, ...next };
  }

  seedRateWindow(installationId: string, windowStartedAt: Date, count: number): void {
    this.counters.set(installationId, { windowStartedAt: windowStartedAt.toISOString(), count });
  }
}

class FixtureLogger implements SafeLogger {
  readonly entries: string[] = [];

  write(code: string): void {
    this.entries.push(code);
  }
}

function eventPayload(options: {
  readonly id?: string;
  readonly type?: string;
  readonly eventAt?: string;
  readonly entityId?: string;
  readonly entityType?: string;
} = {}): Record<string, unknown> {
  return {
    id: options.id ?? "55555555-5555-4555-8555-555555555555",
    type: options.type ?? "page.updated",
    eventAt: options.eventAt ?? NOW.toISOString(),
    entity: {
      id: options.entityId ?? PAGE_ID,
      type: options.entityType ?? "page",
    },
    title: "fixture-sensitive-title",
    content: "fixture-sensitive-content",
  };
}

function activeRequest(
  raw: Uint8Array,
  signature: string | null,
  options: {
    readonly authorization?: string;
    readonly contentType?: string;
    readonly method?: string;
  } = {},
): Request {
  const headers = new Headers({
    authorization: options.authorization ?? "Bearer " + FIXTURE_BEARER,
    "content-type": options.contentType ?? "application/json",
  });
  if (signature !== null) {
    headers.set("x-notion-signature", signature);
  }
  return new Request("https://fixture.invalid/webhook", {
    method: options.method ?? "POST",
    headers,
    body: raw,
  });
}

function activeHarness(): {
  readonly clock: FixtureClock;
  readonly installations: FixtureInstallations;
  readonly pages: FixturePages;
  readonly events: FixtureEvents;
  readonly logs: FixtureLogger;
  readonly deps: WebhookDependencies;
} {
  const clock = new FixtureClock(NOW);
  const installations = new FixtureInstallations();
  const pages = new FixturePages();
  const events = new FixtureEvents();
  const logs = new FixtureLogger();
  return {
    clock,
    installations,
    pages,
    events,
    logs,
    deps: {
      verificationToken: async () => FIXTURE_VERIFICATION_TOKEN,
      installation: installations,
      pages,
      events,
      clock,
      crypto: globalThis.crypto,
      log: logs,
    },
  };
}

function decodeBase64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

describe("handleNotionWebhook", () => {
  it("verifies the exact raw body and rejects replayed or stale events", async () => {
    const harness = activeHarness();
    const raw = utf8(JSON.stringify(eventPayload()));
    const signature = await signNotionBody(raw, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto);

    expect((await handleNotionWebhook(activeRequest(raw, signature), harness.deps)).status).toBe(204);
    expect((await handleNotionWebhook(activeRequest(raw, signature), harness.deps)).status).toBe(204);
    expect(harness.events.enqueueCalls).toHaveLength(1);
    expect((await handleNotionWebhook(activeRequest(utf8("{}"), signature), harness.deps)).status).toBe(401);

    const stale = utf8(
      JSON.stringify(eventPayload({ id: "66666666-6666-4666-8666-666666666666", eventAt: "2026-07-15T11:49:59.999Z" })),
    );
    const staleSignature = await signNotionBody(stale, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto);
    expect((await handleNotionWebhook(activeRequest(stale, staleSignature), harness.deps)).status).toBe(204);
    expect(harness.events.enqueueCalls).toHaveLength(1);
  });

  it("binds HMAC verification to the authenticated installation", async () => {
    const installationLookups: Array<string | undefined> = [];
    const installations = new TwoInstallationFixture(
      { id: INSTALLATION_ID, bootstrapPublicJwk: null },
      { id: SECOND_INSTALLATION_ID, bootstrapPublicJwk: null },
    );
    const events = new FixtureEvents();
    const deps: WebhookDependencies = {
      verificationToken: async (installationId?: string) => {
        installationLookups.push(installationId);
        return installationId === SECOND_INSTALLATION_ID
          ? SECOND_FIXTURE_VERIFICATION_TOKEN
          : FIXTURE_VERIFICATION_TOKEN;
      },
      installation: installations,
      pages: new FixturePages(),
      events,
      clock: new FixtureClock(NOW),
      crypto: globalThis.crypto,
      log: new FixtureLogger(),
    };
    const raw = utf8(JSON.stringify(eventPayload()));
    const firstSignature = await signNotionBody(raw, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto);

    expect((await handleNotionWebhook(activeRequest(raw, firstSignature), deps)).status).toBe(204);
    expect(
      (
        await handleNotionWebhook(
          activeRequest(raw, firstSignature, { authorization: "Bearer " + SECOND_FIXTURE_BEARER }),
          deps,
        )
      ).status,
    ).toBe(401);
    expect(installationLookups).toEqual([INSTALLATION_ID, SECOND_INSTALLATION_ID]);
    expect(events.enqueueCalls).toHaveLength(1);
    expect(events.enqueueCalls[0]?.installationId).toBe(INSTALLATION_ID);
  });

  it("encrypts the one-time verification token without logging or storing plaintext", async () => {
    const keyPair = (await globalThis.crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"],
    )) as CryptoKeyPair;
    const publicJwk = await globalThis.crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const installations = new FixtureInstallations({ id: INSTALLATION_ID, bootstrapPublicJwk: publicJwk });
    const pages = new FixturePages();
    const events = new FixtureEvents();
    const logs = new FixtureLogger();
    const deps: WebhookDependencies = {
      verificationToken: async () => null,
      installation: installations,
      pages,
      events,
      clock: new FixtureClock(NOW),
      crypto: globalThis.crypto,
      log: logs,
    };
    const bootstrapValue = "fixture-verification-value";
    const raw = utf8(JSON.stringify({ verification_token: bootstrapValue }));

    const result = await handleNotionWebhook(activeRequest(raw, null), deps);

    expect(result.status).toBe(204);
    expect(installations.pendingCiphertexts).toHaveLength(1);
    expect(installations.pendingCiphertexts[0]).not.toContain(bootstrapValue);
    expect(logs.entries.join(" ")).not.toContain(bootstrapValue);
    const decrypted = await globalThis.crypto.subtle.decrypt({ name: "RSA-OAEP" }, keyPair.privateKey, decodeBase64url(installations.pendingCiphertexts[0] ?? ""));
    expect(new TextDecoder().decode(decrypted)).toBe(bootstrapValue);
  });

  it("atomically consumes a bootstrap JWK so a second bootstrap cannot persist another ciphertext", async () => {
    const keyPair = (await globalThis.crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"],
    )) as CryptoKeyPair;
    const publicJwk = await globalThis.crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const installations = new FixtureInstallations({ id: INSTALLATION_ID, bootstrapPublicJwk: publicJwk });
    const deps: WebhookDependencies = {
      verificationToken: async () => null,
      installation: installations,
      pages: new FixturePages(),
      events: new FixtureEvents(),
      clock: new FixtureClock(NOW),
      crypto: globalThis.crypto,
      log: new FixtureLogger(),
    };
    const raw = utf8(JSON.stringify({ verification_token: "fixture-verification-value" }));

    const statuses = await Promise.all([
      handleNotionWebhook(activeRequest(raw, null), deps).then((response) => response.status),
      handleNotionWebhook(activeRequest(raw, null), deps).then((response) => response.status),
    ]);
    expect(statuses.sort()).toEqual([204, 400]);
    expect(installations.pendingCiphertexts).toHaveLength(1);
    expect((await handleNotionWebhook(activeRequest(raw, null), deps)).status).toBe(400);
  });

  it("accepts only strict bootstrap bodies and never consumes a bootstrap body as a webhook event", async () => {
    const keyPair = (await globalThis.crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"],
    )) as CryptoKeyPair;
    const publicJwk = await globalThis.crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const installations = new FixtureInstallations({ id: INSTALLATION_ID, bootstrapPublicJwk: publicJwk });
    const events = new FixtureEvents();
    const deps: WebhookDependencies = {
      verificationToken: async () => null,
      installation: installations,
      pages: new FixturePages(),
      events,
      clock: new FixtureClock(NOW),
      crypto: globalThis.crypto,
      log: new FixtureLogger(),
    };

    const raw = utf8(JSON.stringify({ verification_token: "fixture-verification-value", title: "fixture-sensitive-title" }));
    expect((await handleNotionWebhook(activeRequest(raw, null), deps)).status).toBe(400);
    const duplicate = utf8(
      '{"verification_token":"fixture-first-verification-value","verification_token":"fixture-second-verification-value"}',
    );
    expect((await handleNotionWebhook(activeRequest(duplicate, null), deps)).status).toBe(400);
    const nonJsonWhitespace = utf8('{\u00a0"verification_token":"fixture-verification-value"}');
    expect((await handleNotionWebhook(activeRequest(nonJsonWhitespace, null), deps)).status).toBe(400);
    const validBootstrap = utf8('{"verification_token":"fixture-verification-value"}');
    const bomPrefixedBootstrap = new Uint8Array(validBootstrap.byteLength + 3);
    bomPrefixedBootstrap.set([0xef, 0xbb, 0xbf]);
    bomPrefixedBootstrap.set(validBootstrap, 3);
    expect((await handleNotionWebhook(activeRequest(bomPrefixedBootstrap, null), deps)).status).toBe(400);
    expect(installations.pendingCiphertexts).toEqual([]);
    expect(events.enqueueCalls).toEqual([]);
  });

  it("rate-limits valid bootstrap attempts with the installation-scoped counter and recovers next window", async () => {
    const keyPair = (await globalThis.crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"],
    )) as CryptoKeyPair;
    const publicJwk = await globalThis.crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const clock = new FixtureClock(NOW);
    const installations = new FixtureInstallations({ id: INSTALLATION_ID, bootstrapPublicJwk: publicJwk });
    const events = new FixtureEvents();
    events.seedRateWindow(INSTALLATION_ID, NOW, 120);
    const deps: WebhookDependencies = {
      verificationToken: async () => null,
      installation: installations,
      pages: new FixturePages(),
      events,
      clock,
      crypto: globalThis.crypto,
      log: new FixtureLogger(),
    };
    const raw = utf8(JSON.stringify({ verification_token: "fixture-verification-value" }));

    const throttled = await handleNotionWebhook(activeRequest(raw, null), deps);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("60");
    expect(installations.pendingCiphertexts).toEqual([]);

    clock.set(new Date("2026-07-15T12:01:01.000Z"));
    expect((await handleNotionWebhook(activeRequest(raw, null), deps)).status).toBe(204);
    expect(installations.pendingCiphertexts).toHaveLength(1);
  });

  it("queues registered pages and safe blocks without guessing a block parent", async () => {
    const harness = activeHarness();
    const unregistered = utf8(
      JSON.stringify(eventPayload({ id: "77777777-7777-4777-8777-777777777777", entityId: "88888888-8888-4888-8888-888888888888" })),
    );
    const unregisteredSignature = await signNotionBody(unregistered, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto);
    expect((await handleNotionWebhook(activeRequest(unregistered, unregisteredSignature), harness.deps)).status).toBe(204);
    expect(harness.events.enqueueCalls).toEqual([]);

    const block = utf8(
      JSON.stringify(eventPayload({ id: "99999999-9999-4999-8999-999999999999", type: "block.updated", entityId: BLOCK_ID, entityType: "block" })),
    );
    const blockSignature = await signNotionBody(block, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto);
    expect((await handleNotionWebhook(activeRequest(block, blockSignature), harness.deps)).status).toBe(204);
    expect(harness.events.enqueueCalls).toEqual([
      {
        installationId: INSTALLATION_ID,
        id: "99999999-9999-4999-8999-999999999999",
        type: "block.updated",
        entityId: BLOCK_ID,
        eventAt: NOW.toISOString(),
      },
    ]);
    expect(harness.pages.routeCalls).toHaveLength(1);

    const unsupported = utf8(
      JSON.stringify(eventPayload({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "database.updated", entityType: "database" })),
    );
    const unsupportedSignature = await signNotionBody(unsupported, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto);
    expect((await handleNotionWebhook(activeRequest(unsupported, unsupportedSignature), harness.deps)).status).toBe(204);
    expect(harness.events.enqueueCalls).toHaveLength(1);
  });

  it("enforces POST JSON and the 64 KiB raw body boundary before parsing", async () => {
    const harness = activeHarness();
    const raw = utf8(JSON.stringify(eventPayload()));
    const signature = await signNotionBody(raw, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto);

    expect((await handleNotionWebhook(activeRequest(raw, signature, { contentType: "text/plain" }), harness.deps)).status).toBe(415);
    expect((await handleNotionWebhook(activeRequest(raw, signature, { method: "PUT" }), harness.deps)).status).toBe(405);

    const oversized = new Uint8Array(65_537);
    expect((await handleNotionWebhook(activeRequest(oversized, "not-a-valid-signature"), harness.deps)).status).toBe(413);
    expect(
      (
        await handleNotionWebhook(
          activeRequest(oversized, "not-a-valid-signature", { authorization: "Bearer fixture-wrong-value" }),
          harness.deps,
        )
      ).status,
    ).toBe(413);
    expect(harness.events.enqueueCalls).toEqual([]);
  });

  it("enforces a 120-per-minute installation-scoped ceiling and recovers in the next fixed window", async () => {
    const harness = activeHarness();
    const statuses = await Promise.all(
      Array.from({ length: 121 }, async (_, index) => {
        const suffix = String(index + 1).padStart(12, "0");
        const raw = utf8(
          JSON.stringify(eventPayload({ id: "bbbbbbbb-bbbb-4bbb-8bbb-" + suffix })),
        );
        const signature = await signNotionBody(raw, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto);
        return (await handleNotionWebhook(activeRequest(raw, signature), harness.deps)).status;
      }),
    );

    expect(statuses.filter((status) => status === 204)).toHaveLength(120);
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);

    const throttledRaw = utf8(JSON.stringify(eventPayload({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })));
    const throttledSignature = await signNotionBody(throttledRaw, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto);
    const throttled = await handleNotionWebhook(activeRequest(throttledRaw, throttledSignature), harness.deps);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("60");

    harness.clock.set(new Date("2026-07-15T12:01:01.000Z"));
    const recoveredRaw = utf8(JSON.stringify(eventPayload({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })));
    const recoveredSignature = await signNotionBody(recoveredRaw, FIXTURE_VERIFICATION_TOKEN, globalThis.crypto);
    expect((await handleNotionWebhook(activeRequest(recoveredRaw, recoveredSignature), harness.deps)).status).toBe(204);
  });

  it("never places request body, token, signature, title, or content in diagnostic logs", async () => {
    const harness = activeHarness();
    const raw = utf8(JSON.stringify(eventPayload()));
    const signature = "fixture-sensitive-signature";

    expect((await handleNotionWebhook(activeRequest(raw, signature), harness.deps)).status).toBe(401);
    const observed = harness.logs.entries.join(" ");
    expect(observed).not.toContain(FIXTURE_VERIFICATION_TOKEN);
    expect(observed).not.toContain(FIXTURE_BEARER);
    expect(observed).not.toContain(signature);
    expect(observed).not.toContain("fixture-sensitive-title");
    expect(observed).not.toContain("fixture-sensitive-content");
    expect(observed).not.toContain(new TextDecoder().decode(raw));
  });
});
