import { authenticateRequestBearer, type BearerAuthenticator } from "../auth/bearer.js";
import {
  MAX_WEBHOOK_BODY_BYTES,
  WEBHOOK_RATE_LIMIT,
  WEBHOOK_RATE_WINDOW_SECONDS,
  boundedRetryAfterSeconds,
  isJsonContentType,
  readBodyAtMost,
} from "../auth/limits.js";
import { verifyNotionBody } from "../auth/hmac.js";
import {
  badRequest,
  internalServerError,
  methodNotAllowed,
  noContent,
  payloadTooLarge,
  tooManyRequests,
  unauthorized,
  unsupportedMediaType,
} from "../http/response.js";
import type { RateCounterResult, WebhookEventInput } from "../queue/repository.js";
import { encryptBootstrapVerificationToken, parseBootstrapVerificationToken } from "./bootstrap.js";

const EVENT_WINDOW_MILLISECONDS = 10 * 60 * 1_000;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const DEFAULT_ALLOWED_EVENT_TYPES = new Set([
  "page.created",
  "page.updated",
  "page.deleted",
  "block.created",
  "block.updated",
  "block.deleted",
]);

export type SafeWebhookLogCode =
  | "webhook_unauthorized"
  | "webhook_malformed"
  | "webhook_rate_limited"
  | "webhook_internal_error";

export interface Clock {
  now(): Date;
}

export interface WebhookInstallation {
  readonly id: string;
  readonly bootstrapPublicJwk: JsonWebKey | null;
}

export interface InstallationRepository extends BearerAuthenticator<WebhookInstallation> {
  /**
   * Atomically persists ciphertext and consumes the corresponding bootstrap
   * public JWK only while that installation is still eligible to bootstrap.
   */
  consumeBootstrapPublicJwkAndStorePendingWebhookTokenCiphertext(
    installationId: string,
    ciphertext: string,
  ): Promise<boolean>;
}

export interface PageRegistry {
  routePage(installationId: string, notionPageId: string): Promise<string | null>;
}

export interface EventRepository {
  enqueue(installationId: string, event: WebhookEventInput, receivedAt: Date): Promise<boolean>;
  incrementRateCounter(
    installationId: string,
    counter: "webhook",
    now: Date,
    limit: number,
    windowSeconds: number,
  ): Promise<RateCounterResult>;
}

export interface SafeLogger {
  write(code: SafeWebhookLogCode): void;
}

export interface WebhookDependencies {
  verificationToken(installationId: string): Promise<string | null>;
  installation: InstallationRepository;
  pages: PageRegistry;
  events: EventRepository;
  clock: Clock;
  crypto: Crypto;
  log: SafeLogger;
  allowedEventTypes?: ReadonlySet<string>;
}

interface ParsedWebhookEvent extends WebhookEventInput {
  readonly entityType: string;
}

function logSafely(log: SafeLogger, code: SafeWebhookLogCode): void {
  try {
    log.write(code);
  } catch {
    // Logging must never affect a webhook response or expose request details.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringProperty(record: Record<string, unknown>, name: string): string | null {
  return typeof record[name] === "string" ? record[name] : null;
}

function parseActiveWebhookEvent(rawBody: Uint8Array): ParsedWebhookEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.entity)) {
    return null;
  }

  const id = stringProperty(value, "id");
  const type = stringProperty(value, "type");
  const eventAt = stringProperty(value, "eventAt");
  const entityId = stringProperty(value.entity, "id");
  const entityType = stringProperty(value.entity, "type");
  const timestamp = eventAt === null ? Number.NaN : new Date(eventAt).getTime();
  if (
    id === null ||
    type === null ||
    eventAt === null ||
    entityId === null ||
    entityType === null ||
    !UUID.test(id) ||
    !UUID.test(entityId) ||
    !Number.isFinite(timestamp)
  ) {
    return null;
  }
  return {
    id,
    type,
    entityId,
    entityType,
    eventAt: new Date(timestamp).toISOString(),
  };
}

function isStale(eventAt: string, now: Date): boolean {
  return Math.abs(now.getTime() - new Date(eventAt).getTime()) > EVENT_WINDOW_MILLISECONDS;
}

function isAllowedEvent(event: ParsedWebhookEvent, allowedTypes: ReadonlySet<string>): boolean {
  return (
    (event.entityType === "page" || event.entityType === "block") &&
    allowedTypes.has(event.type) &&
    event.type.startsWith(event.entityType + ".")
  );
}

async function enforceInstallationWebhookLimit(
  installation: WebhookInstallation,
  now: Date,
  deps: WebhookDependencies,
): Promise<Response | null> {
  const rate = await deps.events.incrementRateCounter(
    installation.id,
    "webhook",
    now,
    WEBHOOK_RATE_LIMIT,
    WEBHOOK_RATE_WINDOW_SECONDS,
  );
  if (rate.allowed) {
    return null;
  }
  logSafely(deps.log, "webhook_rate_limited");
  return tooManyRequests(boundedRetryAfterSeconds(rate.windowStartedAt, now, WEBHOOK_RATE_WINDOW_SECONDS));
}

async function handleBootstrap(
  rawBody: Uint8Array,
  installation: WebhookInstallation,
  now: Date,
  deps: WebhookDependencies,
): Promise<Response> {
  const verificationToken = parseBootstrapVerificationToken(rawBody);
  if (verificationToken === null || installation.bootstrapPublicJwk === null) {
    logSafely(deps.log, "webhook_malformed");
    return badRequest();
  }
  const rateLimited = await enforceInstallationWebhookLimit(installation, now, deps);
  if (rateLimited !== null) {
    return rateLimited;
  }
  try {
    const ciphertext = await encryptBootstrapVerificationToken(verificationToken, installation.bootstrapPublicJwk, deps.crypto);
    if (await deps.installation.consumeBootstrapPublicJwkAndStorePendingWebhookTokenCiphertext(installation.id, ciphertext)) {
      return noContent();
    }
    logSafely(deps.log, "webhook_malformed");
    return badRequest();
  } catch {
    logSafely(deps.log, "webhook_malformed");
    return badRequest();
  }
}

/**
 * Receives a bounded, locally authenticated webhook request. It never calls
 * Notion, derives a block parent, or emits request-derived data to logs.
 */
export async function handleNotionWebhook(request: Request, deps: WebhookDependencies): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return unsupportedMediaType();
    }

    const rawBody = await readBodyAtMost(request, MAX_WEBHOOK_BODY_BYTES);
    if (rawBody === null) {
      logSafely(deps.log, "webhook_malformed");
      return payloadTooLarge();
    }

    const installation = await authenticateRequestBearer(request, deps.installation);
    if (installation === null) {
      logSafely(deps.log, "webhook_unauthorized");
      return unauthorized();
    }

    const now = deps.clock.now();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Invalid injected clock");
    }
    const verificationToken = await deps.verificationToken(installation.id);
    if (verificationToken === null) {
      return handleBootstrap(rawBody, installation, now, deps);
    }

    if (!(await verifyNotionBody(rawBody, request.headers.get("x-notion-signature"), verificationToken, deps.crypto))) {
      logSafely(deps.log, "webhook_unauthorized");
      return unauthorized();
    }

    const event = parseActiveWebhookEvent(rawBody);
    if (event === null) {
      logSafely(deps.log, "webhook_malformed");
      return badRequest();
    }
    if (isStale(event.eventAt, now) || !isAllowedEvent(event, deps.allowedEventTypes ?? DEFAULT_ALLOWED_EVENT_TYPES)) {
      return noContent();
    }
    if (event.entityType === "page" && (await deps.pages.routePage(installation.id, event.entityId)) === null) {
      return noContent();
    }

    const rateLimited = await enforceInstallationWebhookLimit(installation, now, deps);
    if (rateLimited !== null) {
      return rateLimited;
    }
    await deps.events.enqueue(
      installation.id,
      {
        id: event.id,
        type: event.type,
        entityId: event.entityId,
        eventAt: event.eventAt,
      },
      now,
    );
    return noContent();
  } catch {
    logSafely(deps.log, "webhook_internal_error");
    return internalServerError();
  }
}
