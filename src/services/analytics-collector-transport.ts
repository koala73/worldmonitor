/**
 * Transport layer for Umami collector writes (`POST /api/send`).
 *
 * Umami v3.1.0 has a race in `prisma.sessionData.updateMany()`
 * (umami-software/umami#4183) that returns HTTP 500 for a few percent of
 * requests when a page issues concurrent writes for one session. This module
 * serializes our writes through a single in-flight slot so we stop generating
 * that contention ourselves, and turns the tracker's swallowed failures into an
 * observable delivery signal.
 *
 * Two invariants keep this from becoming a worse failure than the one it fixes:
 *
 *  1. The gate is installed EXACTLY ONCE. It must never re-wrap `window.fetch`
 *     after some other instrumentation (Sentry's breadcrumbs/tracing
 *     integrations, the wm-session interceptor, the desktop runtime patch) has
 *     wrapped it. A second gate delegates through the first, and because both
 *     share this module's queue the inner call blocks on `inFlight` while the
 *     outer awaits it — a permanent deadlock that silently stops all analytics
 *     for the page. Installing once is safe: a later wrapper delegates down to
 *     us, so we still see every collector write.
 *  2. Every dispatch is time-bounded. The single slot means one hung request
 *     would otherwise wedge every subsequent write for the page's lifetime.
 */

import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import {
  extractCollectorFailureMetadata,
  isBotFilteredBody,
  isSessionDataConflict,
} from '../../shared/collector-failure-metadata';

export type CollectorFailure = {
  kind: 'http' | 'network' | 'timeout' | 'queue-overflow' | 'missing-receipt';
  status?: number;
  prismaCode?: string;
  constraint?: string;
  /**
   * The collector answered 200 with its bot-filter sentinel and stored nothing.
   *
   * This is a MARKER, not a `kind`, on purpose. The write really was dropped,
   * so every delivery policy — retry, and the durable checkout marker — must
   * keep treating it exactly like any other receiptless 200. Only the alerting
   * decision reads this flag. Promoting it to its own `kind` would silently
   * change `isRetryableCollectorFailure` and `isDurableMarkerResolved`, turning
   * an alert-noise fix into a conversion-accounting change.
   */
  botFiltered?: boolean;
};

export type CollectorRequestType = 'event' | 'identify';

export type CollectorRequestClassification = {
  requestType: CollectorRequestType;
  eventName?: string;
  critical: boolean;
};

export type CollectorHealthCohort = 'event' | 'critical-event' | 'identify';

export type CollectorHealthReport = {
  cohort: CollectorHealthCohort;
  writes: number;
  failures: number;
  failureKind: 'network' | 'timeout' | 'missing-receipt';
};

type CollectorHealthReporter = (report: CollectorHealthReport) => Promise<boolean>;

export type CollectorOutcome = {
  requestType: CollectorRequestType;
  eventName?: string;
  requestBody?: string;
  failure: CollectorFailure | null;
};

export class CollectorDeliveryError extends Error {
  readonly failure: CollectorFailure;

  constructor(failure: CollectorFailure) {
    super(`Umami collector write failed${failure.status ? ` with HTTP ${failure.status}` : ''}`);
    this.name = 'CollectorDeliveryError';
    this.failure = failure;
  }
}

/**
 * Depth of the serialization queue in front of the single in-flight slot.
 *
 * MUST stay >= `UMAMI_QUEUE_LIMIT` in `src/services/analytics.ts`. That buffer
 * holds calls made before the tracker script loads, and `flushPendingUmamiCalls`
 * splices and dispatches ALL of them in one synchronous loop — so the deferred
 * buffer's capacity is delivered to this queue as a single burst. While this was
 * 25 against a 50-deep buffer, a full flush shed ~half its events as
 * `queue-overflow` before they ever reached the network: not backpressure
 * against a slow collector, but a self-inflicted drop from two limits that were
 * never reconciled (WORLDMONITOR-Y3, 2230 events / 1747 users). Raising the
 * queue depth does NOT raise concurrency — writes still drain one at a time,
 * which is what keeps umami#4183 contention off the collector.
 * `tests/analytics-queue-capacity.test.mjs` fails if the two drift apart again.
 *
 * Exported so overflow tests can size their input from the real bound instead
 * of a literal — a hardcoded "fill past 25" silently stops overflowing the
 * moment this changes, and the test then passes while asserting nothing.
 */
export const COLLECTOR_QUEUE_LIMIT = 50;
const HEALTH_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Statuses safe to retry for an APPEND-ONLY event.
 *
 * Deliberately excludes 500 and every gateway status (502/504). The collector
 * sits behind Cloudflare in front of a Railway origin, so a gateway error
 * cannot distinguish "never reached the origin" from "committed, then the edge
 * gave up" — the same ambiguity that rules out retrying a 500. Retrying either
 * double-counts a conversion. 503 is excluded for the same reason: the origin
 * itself can emit it after partial work.
 *
 * Identity writes are idempotent latest-snapshot updates and use a broader
 * policy — see `isRetryableIdentityFailure`.
 */
const RETRYABLE_CRITICAL_EVENT_STATUSES = new Set([408, 425, 429]);

/**
 * Statuses safe to retry for an IDEMPOTENT identity snapshot. Replaying an
 * identify overwrites the same fields, so a duplicate is harmless and the
 * gateway/5xx ambiguity that blocks event retries does not apply.
 */
const RETRYABLE_IDENTITY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Fields Umami returns on a genuine write. Mirrors the CI monitor's receipt check. */
const WRITE_RECEIPT_FIELDS = ['cache', 'sessionId', 'visitId'] as const;

type CollectorRequest = {
  input: RequestInfo | URL;
  init?: RequestInit;
  originalFetch: typeof window.fetch;
  requestType: CollectorRequestType;
  eventName?: string;
  critical: boolean;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
  resolveDelivery: (response: Response) => void;
  rejectDelivery: (error: unknown) => void;
};

type ObservationSlot = {
  requestType: CollectorRequestType;
  delivery?: Promise<Response>;
};

let collectorEndpoint = '';
let isCriticalEventName: (name: string) => boolean = () => false;
let onCollectorOutcome: (outcome: CollectorOutcome) => void = () => {};
const DEFAULT_COLLECTOR_HEALTH_ENDPOINT = '/api/analytics-health';
const COLLECTOR_HEALTH_REPORT_TIMEOUT_MS = 2_000;
let collectorHealthEndpoint = DEFAULT_COLLECTOR_HEALTH_ENDPOINT;

async function sendCollectorHealthReport(
  endpoint: string,
  report: CollectorHealthReport,
): Promise<boolean> {
  if (typeof globalThis.fetch !== 'function') return false;
  try {
    const init: RequestInit = {
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(COLLECTOR_HEALTH_REPORT_TIMEOUT_MS);
    }
    const response = await globalThis.fetch(endpoint, init);
    return response.ok;
  } catch {
    return false;
  }
}

let collectorHealthReporter: CollectorHealthReporter = (report) =>
  sendCollectorHealthReport(collectorHealthEndpoint, report);

const collectorRequestQueue: CollectorRequest[] = [];
let collectorRequestInFlight = false;
let collectorFetchOriginal: typeof window.fetch | null = null;
let collectorFetchWrapper: typeof window.fetch | null = null;
let collectorUnloadFlush: (() => void) | null = null;
let collectorVisibilityFlush: (() => void) | null = null;
let collectorTransportGeneration = 0;
type CollectorHealthCounters = {
  writes: number;
  failures: number;
  environmentFailures: number;
  noiseReported: boolean;
};

type CollectorHealthWindow = {
  startedAt: number;
  writes: number;
  failures: number;
  noiseReported: boolean;
  reportedFailureSignatures: Set<string>;
  cohorts: Record<CollectorHealthCohort, CollectorHealthCounters>;
};

function emptyCollectorHealthCounters(): CollectorHealthCounters {
  return { writes: 0, failures: 0, environmentFailures: 0, noiseReported: false };
}

function createCollectorHealthWindow(startedAt = 0): CollectorHealthWindow {
  return {
    startedAt,
    writes: 0,
    failures: 0,
    noiseReported: false,
    reportedFailureSignatures: new Set(),
    cohorts: {
      event: emptyCollectorHealthCounters(),
      'critical-event': emptyCollectorHealthCounters(),
      identify: emptyCollectorHealthCounters(),
    },
  };
}

function collectorFailureSignature(failure: CollectorFailure): string {
  return [failure.kind, failure.status ?? 'none', failure.prismaCode ?? 'none', failure.constraint ?? 'none'].join('|');
}

let collectorHealthWindow = createCollectorHealthWindow();
let collectorHealthReportCursor: Record<CollectorHealthCohort, { writes: number; failures: number }> = {
  event: { writes: 0, failures: 0 },
  'critical-event': { writes: 0, failures: 0 },
  identify: { writes: 0, failures: 0 },
};
let pendingObservation: ObservationSlot | null = null;
/**
 * Non-zero while this module is dispatching. If a foreign wrapper installed on
 * top of us calls back down into the gate for the SAME request, re-queuing it
 * would deadlock against our own in-flight slot; passing it straight through is
 * correct because we are already serializing that write.
 */
let collectorDispatchDepth = 0;

export function configureCollectorTransport(options: {
  endpoint: string;
  isCriticalEvent: (name: string) => boolean;
  onOutcome: (outcome: CollectorOutcome) => void;
  healthEndpoint?: string;
  reportEnvironmentHealth?: CollectorHealthReporter;
}): void {
  collectorEndpoint = options.endpoint;
  isCriticalEventName = options.isCriticalEvent;
  onCollectorOutcome = options.onOutcome;
  collectorHealthEndpoint = options.healthEndpoint ?? DEFAULT_COLLECTOR_HEALTH_ENDPOINT;
  collectorHealthReporter = options.reportEnvironmentHealth
    ?? ((report) => sendCollectorHealthReport(collectorHealthEndpoint, report));
}

export function _setCollectorHealthReporterForTesting(reporter: CollectorHealthReporter): void {
  collectorHealthReporter = reporter;
}

function getCollectorHealthCohort(request: CollectorRequest): CollectorHealthCohort {
  if (request.requestType === 'identify') return 'identify';
  return request.critical ? 'critical-event' : 'event';
}

export function classifyCollectorRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): CollectorRequestClassification | null {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  const method = init?.method ?? (
    typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET'
  );
  if (url !== collectorEndpoint || method.toUpperCase() !== 'POST' || typeof init?.body !== 'string') {
    return null;
  }

  try {
    const body = JSON.parse(init.body) as { type?: unknown; payload?: unknown };
    if (body.type !== 'event' && body.type !== 'identify') return null;
    const payload = body.payload && typeof body.payload === 'object'
      ? body.payload as { name?: unknown }
      : {};
    const eventName = typeof payload.name === 'string' ? payload.name : undefined;
    return {
      requestType: body.type,
      eventName,
      critical: body.type === 'identify' || (eventName !== undefined && isCriticalEventName(eventName)),
    };
  } catch {
    return null;
  }
}

/**
 * Classify a completed response. A 2xx is NOT sufficient: Umami answers 200 to
 * a bot-filtered write it silently drops, and that response carries no receipt.
 * The CI monitor already refuses a receiptless 200; treating one as delivered
 * here would clear a durable conversion marker for an event that was never
 * stored.
 */
export async function inspectCollectorResponse(response: Response): Promise<CollectorFailure | null> {
  let body = '';
  try {
    const readable = typeof response.clone === 'function' ? response.clone() : response;
    if (typeof readable.text === 'function') body = await readable.text();
  } catch {
    // Status and transport type are still useful when a proxy body is unreadable.
  }

  if (!response.ok) {
    return { kind: 'http', status: response.status, ...extractCollectorFailureMetadata(body) };
  }

  let receipt: Record<string, unknown> | null = null;
  try {
    receipt = JSON.parse(body) as Record<string, unknown>;
  } catch {
    receipt = null;
  }
  const hasReceipt = receipt !== null && WRITE_RECEIPT_FIELDS.every(
    (field) => typeof receipt?.[field] === 'string' && (receipt[field] as string).trim() !== '',
  );
  if (!hasReceipt) {
    return {
      kind: 'missing-receipt',
      status: response.status,
      ...(isBotFilteredBody(body) ? { botFiltered: true } : {}),
    };
  }

  return null;
}

export function collectorFailureFromError(error: unknown): CollectorFailure {
  if (error instanceof CollectorDeliveryError) return error.failure;
  if (error instanceof Error && error.name === 'TimeoutError') return { kind: 'timeout' };
  return { kind: 'network' };
}

export function isKnownSessionDataConflict(failure: CollectorFailure): boolean {
  return isSessionDataConflict(failure);
}

/**
 * Retry policy for append-only critical events (conversions). Conservative by
 * design: anything that could have committed before failing is NOT retried.
 */
export function isRetryableCollectorFailure(failure: CollectorFailure): boolean {
  if (isKnownSessionDataConflict(failure)) return false;
  // A dropped request never reached the network, but re-queueing it just feeds
  // the same saturated queue.
  if (failure.kind === 'queue-overflow') return false;
  // A receiptless 200 means Umami accepted and discarded the write; a retry is
  // filtered identically.
  if (failure.kind === 'missing-receipt') return false;
  if (failure.kind === 'network' || failure.kind === 'timeout') return true;
  return failure.status !== undefined && RETRYABLE_CRITICAL_EVENT_STATUSES.has(failure.status);
}

/**
 * Retry policy for idempotent identity snapshots. Broader than the event policy
 * because replaying an identify overwrites the same fields — the
 * duplicate-conversion hazard does not exist. HTTP 500 stays retryable here:
 * that is the exact failure #5715 was opened for.
 */
export function isRetryableIdentityFailure(failure: CollectorFailure): boolean {
  if (isKnownSessionDataConflict(failure)) return false;
  if (failure.kind === 'queue-overflow' || failure.kind === 'missing-receipt') return false;
  if (failure.kind === 'network' || failure.kind === 'timeout') return true;
  return failure.status !== undefined && RETRYABLE_IDENTITY_STATUSES.has(failure.status);
}

/**
 * Failure kinds produced by the CLIENT's environment rather than the collector.
 *
 * A blocked request (uBlock/Brave/Pi-hole all block `abacus.`) and a dead
 * collector are indistinguishable from inside one browser: both fail 100% of
 * writes. The same holds for a non-bot-filtered receiptless 200: privacy
 * middleware that answers a faked 200 for a tracker endpoint, and a response
 * whose body cannot be read, both look exactly like a collector that accepted
 * and discarded the write. Verified in production 2026-08-01 (WORLDMONITOR-Y3):
 * receiptless-200 reports arrived at ~16/hour from diverse real browsers while
 * the Umami DB was ingesting 15-23k events/hour and every probe shape returned
 * a full receipt. Nothing computed on this page can separate them, so the
 * outage signal is the AGGREGATE volume of these events across users, not any
 * single one. The browser sends bounded deltas to the aggregate endpoint, with
 * a per-page floor retained as a fallback when that endpoint is unavailable.
 * (A bot-filtered 200 never reaches this set — it is suppressed outright
 * before the gate.)
 */
type EnvironmentNoiseKind = 'network' | 'timeout' | 'missing-receipt';
type EnvironmentNoiseFailure = CollectorFailure & { kind: EnvironmentNoiseKind };
const ENVIRONMENT_NOISE_KINDS = new Set<EnvironmentNoiseKind>(['network', 'timeout', 'missing-receipt']);

function isEnvironmentNoiseFailure(failure: CollectorFailure): failure is EnvironmentNoiseFailure {
  return ENVIRONMENT_NOISE_KINDS.has(failure.kind as EnvironmentNoiseKind) && !failure.botFiltered;
}

/**
 * Minimum writes in the health window before an environment failure can alert.
 *
 * A page that has issued one or two writes and failed them says nothing — a
 * single blocked beacon is the overwhelmingly common case. Requiring a real
 * sample is what removes the ad-blocker baseline.
 */
const ENVIRONMENT_NOISE_MIN_WRITES = 5;

/** Minimum in-window failure rate before an environment failure can alert. */
const ENVIRONMENT_NOISE_MIN_FAILURE_RATE = 0.5;

/**
 * As much of the rolling health window as the alert policy reads.
 *
 * `noiseReported` is optional so a caller reasoning about a hypothetical window
 * — every test in the policy suite — can omit the latch and get the
 * first-occurrence answer.
 */
type CollectorHealthSnapshot = {
  writes: number;
  failures: number;
  noiseReported?: boolean;
};

/**
 * Whether a failure is worth a Sentry event, as opposed to merely worth a
 * console warning.
 *
 * Extracted as a pure function of (failure, window) so the policy is testable
 * without standing up the fetch gate, the deferred Sentry queue, and a real
 * tracker — the wiring test then only has to prove this is the predicate the
 * reporting path consults.
 */
export function isAlertWorthyCollectorFailure(
  failure: CollectorFailure,
  window: CollectorHealthSnapshot,
): boolean {
  // The collector deliberately discarded a bot's write. Working as designed.
  if (failure.botFiltered) return false;
  if (ENVIRONMENT_NOISE_KINDS.has(failure.kind as EnvironmentNoiseKind)) {
    // The fallback emits at most one environment event per page per window.
    // Without this, crossing the rate floor makes EVERY remaining failure in the
    // window report, so one ad-blocked power user out-produces the incident the
    // floor exists to show.
    if (window.noiseReported) return false;
    if (window.writes < ENVIRONMENT_NOISE_MIN_WRITES) return false;
    return window.failures / window.writes >= ENVIRONMENT_NOISE_MIN_FAILURE_RATE;
  }
  // Everything left is actionable: a non-2xx from the origin, or a
  // queue-overflow drop that is our own bug.
  return true;
}

function resetCollectorHealthWindow(startedAt: number): void {
  collectorHealthWindow = createCollectorHealthWindow(startedAt);
  collectorHealthReportCursor = {
    event: { writes: 0, failures: 0 },
    'critical-event': { writes: 0, failures: 0 },
    identify: { writes: 0, failures: 0 },
  };
}

function buildCollectorHealthReport(
  cohort: CollectorHealthCohort,
  failure: EnvironmentNoiseFailure,
): CollectorHealthReport | null {
  const current = collectorHealthWindow.cohorts[cohort];
  const previous = collectorHealthReportCursor[cohort];
  const writes = Math.max(0, current.writes - previous.writes);
  const failures = Math.max(0, current.environmentFailures - previous.failures);
  collectorHealthReportCursor[cohort] = {
    writes: current.writes,
    failures: current.environmentFailures,
  };
  if (writes < 1 || failures < 1) return null;
  return { cohort, writes, failures, failureKind: failure.kind };
}

function emitCollectorFailureToSentry(
  request: CollectorRequest,
  failure: CollectorFailure,
  cohort: CollectorHealthCohort,
  diagnostics: Record<string, unknown>,
): void {
  if (isEnvironmentNoiseFailure(failure)) {
    const cohortWindow = collectorHealthWindow.cohorts[cohort];
    if (cohortWindow.noiseReported) return;
    cohortWindow.noiseReported = true;
    collectorHealthWindow.noiseReported = true;
  }

  // Keep every failure observable through the aggregate counters and console,
  // but emit at most one Sentry event per redacted failure signature per
  // minute. The upstream race can affect every concurrent write; one event
  // with the live rate and Prisma identifiers is enough to page on it.
  const signature = collectorFailureSignature(failure);
  if (collectorHealthWindow.reportedFailureSignatures.has(signature)) return;
  collectorHealthWindow.reportedFailureSignatures.add(signature);

  try {
    enqueueSentryCall((s) => s.captureMessage('Umami collector write failed', {
      level: 'warning',
      // Tags do not split issues — without a fingerprint, Sentry groups on the
      // fixed message and folds all five `kind`s into one. That is how the
      // ad-blocker population (`network`, unactionable by design) buried a
      // `queue-overflow` count that was our own dropped writes, in a single
      // 2230-event issue nobody could read a cause out of (WORLDMONITOR-Y3).
      // Cardinality stays bounded: 5 kinds x the small status set.
      fingerprint: [
        'analytics-collector',
        'write-failed',
        failure.kind,
        String(failure.status ?? 'none'),
      ],
      tags: {
        kind: 'analytics_collector_write_failed',
        failureKind: failure.kind,
        status: String(failure.status ?? 'none'),
        requestType: request.requestType,
        healthCohort: cohort,
      },
      extra: diagnostics,
    }));
  } catch { /* best-effort telemetry */ }
}

function recordCollectorOutcome(request: CollectorRequest, failure: CollectorFailure | null): void {
  const now = Date.now();
  if (collectorHealthWindow.startedAt === 0 || now - collectorHealthWindow.startedAt >= HEALTH_WINDOW_MS) {
    resetCollectorHealthWindow(now);
  }
  collectorHealthWindow.writes += 1;
  const cohort = getCollectorHealthCohort(request);
  const cohortWindow = collectorHealthWindow.cohorts[cohort];
  cohortWindow.writes += 1;

  const outcome: CollectorOutcome = {
    requestType: request.requestType,
    eventName: request.eventName,
    requestBody: typeof request.init?.body === 'string' ? request.init.body : undefined,
    failure,
  };
  onCollectorOutcome(outcome);
  if (!failure) return;

  collectorHealthWindow.failures += 1;
  cohortWindow.failures += 1;
  if (isEnvironmentNoiseFailure(failure)) cohortWindow.environmentFailures += 1;
  if (failure.botFiltered) {
    // Bot-filtered writes are expected drops, not evidence about the collector.
    cohortWindow.writes -= 1;
    cohortWindow.failures -= 1;
  }
  // Deliberately reports only delivery metadata. The event payload can contain
  // billing or identity data and must never be copied into diagnostics.
  const cohortFailureRate = cohortWindow.writes > 0
    ? cohortWindow.failures / cohortWindow.writes
    : 0;
  const environmentFailureRate = cohortWindow.writes > 0
    ? cohortWindow.environmentFailures / cohortWindow.writes
    : 0;
  const diagnostics = {
    requestType: request.requestType,
    healthCohort: cohort,
    status: failure.status ?? null,
    failureKind: failure.kind,
    failureRate: cohortFailureRate,
    environmentFailureRate,
    failureCount: collectorHealthWindow.failures,
    writeCount: collectorHealthWindow.writes,
    cohortFailureCount: cohortWindow.failures,
    cohortWriteCount: cohortWindow.writes,
    prismaCode: failure.prismaCode ?? null,
    constraint: failure.constraint ?? null,
    // The console warning fires for suppressed failures too, so it has to say
    // WHY a receiptless 200 happened — otherwise a developer reading devtools
    // during a bot-filtered write starts debugging a write path that is fine.
    botFiltered: failure.botFiltered ?? false,
  };
  console.warn('[Analytics] Umami collector write failed', diagnostics);

  // A console warning in a user's devtools is not observable, so genuine
  // failures are routed to Sentry the same way wm-session and checkout report
  // their degraded writes. But an alarm that fires on expected background
  // conditions trains everyone to ignore it — the alert-fatigue path straight
  // back to #5565, where a dead collector went unnoticed for four days. Only
  // actionable failures get an event. Environment failures first go through
  // the cross-user aggregate. If that path is unavailable, the original
  // per-page floor remains as a bounded fallback.
  if (isEnvironmentNoiseFailure(failure)) {
    const localSnapshot: CollectorHealthSnapshot = {
      writes: cohortWindow.writes,
      failures: cohortWindow.environmentFailures,
      noiseReported: cohortWindow.noiseReported,
    };
    const report = buildCollectorHealthReport(cohort, failure);
    if (!report) return;

    let reportPromise: Promise<boolean>;
    try {
      reportPromise = collectorHealthReporter(report);
    } catch {
      reportPromise = Promise.resolve(false);
    }
    void reportPromise.then((accepted) => {
      if (accepted || !isAlertWorthyCollectorFailure(failure, localSnapshot)) return;
      emitCollectorFailureToSentry(request, failure, cohort, diagnostics);
    }, () => {
      if (isAlertWorthyCollectorFailure(failure, localSnapshot)) {
        emitCollectorFailureToSentry(request, failure, cohort, diagnostics);
      }
    });
    return;
  }

  if (!isAlertWorthyCollectorFailure(failure, {
    writes: cohortWindow.writes,
    failures: cohortWindow.failures,
    noiseReported: cohortWindow.noiseReported,
  })) return;
  emitCollectorFailureToSentry(request, failure, cohort, diagnostics);
}

function withTimeout(init: RequestInit | undefined): RequestInit {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return init ?? {};
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const existing = init?.signal;
  if (!existing) return { ...(init ?? {}), signal: timeout };
  if (typeof AbortSignal.any === 'function') {
    return { ...init, signal: AbortSignal.any([existing, timeout]) };
  }
  return init;
}

async function runCollectorRequest(request: CollectorRequest, generation: number): Promise<void> {
  try {
    // The re-entrancy guard must cover ONLY the synchronous call into the
    // underlying fetch — that is the window in which a foreign wrapper stacked
    // on top of us can delegate back down for this same request. Holding it
    // across the await would make every write issued while one is in flight
    // bypass the queue, which is the serialization this module exists for.
    let responsePromise: Promise<Response>;
    collectorDispatchDepth += 1;
    try {
      responsePromise = request.originalFetch(request.input, withTimeout(request.init));
    } finally {
      collectorDispatchDepth -= 1;
    }
    const response = await responsePromise;
    const failure = generation === collectorTransportGeneration
      ? await inspectCollectorResponse(response)
      : null;
    if (generation === collectorTransportGeneration) recordCollectorOutcome(request, failure);
    // Resolve the TRACKER's promise with the real Response either way — Umami
    // expects native fetch semantics (only a network error rejects). The
    // delivery promise is the separate, honest signal.
    request.resolve(response);
    if (failure) request.rejectDelivery(new CollectorDeliveryError(failure));
    else request.resolveDelivery(response);
  } catch (error) {
    if (generation === collectorTransportGeneration) {
      recordCollectorOutcome(request, collectorFailureFromError(error));
    }
    request.reject(error);
    request.rejectDelivery(error);
  }
}

function drainCollectorRequestQueue(): void {
  if (collectorRequestInFlight || collectorRequestQueue.length === 0) return;
  const request = collectorRequestQueue.shift();
  if (!request) return;

  collectorRequestInFlight = true;
  const generation = collectorTransportGeneration;
  void runCollectorRequest(request, generation).finally(() => {
    if (generation !== collectorTransportGeneration) return;
    collectorRequestInFlight = false;
    drainCollectorRequestQueue();
  });
}

/**
 * Dispatch the whole backlog at once because the page is going away.
 *
 * The tracker issues every write with `keepalive: true` so an in-flight request
 * survives unload — but a request still sitting in this queue was never handed
 * to the network stack, so keepalive cannot protect it. Serialization exists to
 * avoid session_data contention, which stops mattering once the page is gone;
 * losing a queued checkout-start to a navigation does not.
 */
function flushCollectorQueueForUnload(): void {
  if (collectorRequestQueue.length === 0) return;
  const pending = collectorRequestQueue.splice(0, collectorRequestQueue.length);
  const generation = collectorTransportGeneration;
  for (const request of pending) {
    void runCollectorRequest(request, generation);
  }
}

function rejectOverflow(request: CollectorRequest): void {
  const failure: CollectorFailure = { kind: 'queue-overflow' };
  recordCollectorOutcome(request, failure);
  const error = new CollectorDeliveryError(failure);
  request.reject(error);
  request.rejectDelivery(error);
}

type Deferred = {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

function createDeferred(): Deferred {
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function enqueueCollectorRequest(
  classification: CollectorRequestClassification,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  originalFetch: typeof window.fetch,
): { transport: Promise<Response>; delivery: Promise<Response> } {
  const transportDeferred = createDeferred();
  const deliveryDeferred = createDeferred();
  // Nothing is required to consume the delivery promise; keep an unobserved
  // rejection from surfacing as an unhandled rejection.
  void deliveryDeferred.promise.catch(() => {});

  const request: CollectorRequest = {
    ...classification,
    input,
    init,
    originalFetch,
    resolve: transportDeferred.resolve,
    reject: transportDeferred.reject,
    resolveDelivery: deliveryDeferred.resolve,
    rejectDelivery: deliveryDeferred.reject,
  };
  const transport = transportDeferred.promise;
  const delivery = deliveryDeferred.promise;

  if (collectorRequestQueue.length >= COLLECTOR_QUEUE_LIMIT) {
    const dropIndex = collectorRequestQueue.findIndex((candidate) => !candidate.critical);
    if (dropIndex >= 0) {
      const [dropped] = collectorRequestQueue.splice(dropIndex, 1);
      if (dropped) rejectOverflow(dropped);
    } else if (!classification.critical) {
      rejectOverflow(request);
      return { transport, delivery };
    } else {
      const dropped = collectorRequestQueue.shift();
      if (dropped) rejectOverflow(dropped);
    }
  }

  collectorRequestQueue.push(request);
  drainCollectorRequestQueue();
  return { transport, delivery };
}

export function isCollectorGateInstalled(): boolean {
  return collectorFetchWrapper !== null;
}

/**
 * Install the serialization gate. Idempotent and install-ONCE: if `window.fetch`
 * has since been re-wrapped by other instrumentation, we deliberately do NOT
 * wrap again (see the module header — stacking deadlocks the shared queue).
 */
export function installCollectorFetchGate(): boolean {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return false;
  if (collectorFetchWrapper) return true;

  const originalFetch = window.fetch;
  const wrappedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    // Re-entered by a foreign wrapper for a write we are already dispatching.
    if (collectorDispatchDepth > 0) return originalFetch(input, init);
    const classification = classifyCollectorRequest(input, init);
    if (!classification) return originalFetch(input, init);
    const { transport, delivery } = enqueueCollectorRequest(classification, input, init, originalFetch);
    if (pendingObservation
      && pendingObservation.requestType === classification.requestType
      && !pendingObservation.delivery) {
      pendingObservation.delivery = delivery;
    }
    return transport;
  }) as typeof window.fetch;

  try {
    window.fetch = wrappedFetch;
  } catch {
    return false;
  }
  collectorFetchOriginal = originalFetch;
  collectorFetchWrapper = wrappedFetch;

  // pagehide ALWAYS flushes — the page is leaving whatever visibilityState says.
  // visibilitychange flushes only once actually hidden, since it also fires on
  // the way back to visible.
  const onPageHide = (): void => { flushCollectorQueueForUnload(); };
  const onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
    flushCollectorQueueForUnload();
  };
  collectorUnloadFlush = onPageHide;
  collectorVisibilityFlush = onVisibilityChange;
  try {
    window.addEventListener('pagehide', onPageHide);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  } catch {
    // No lifecycle events in this host (non-DOM test harness); the queue keeps
    // its normal drain behavior.
  }
  return true;
}

/**
 * Run a tracker call and capture the delivery outcome of the collector write it
 * issues, without wrapping `window.fetch` a second time — the installed gate
 * reports into `pendingObservation` instead.
 *
 * `observed` is false when no collector write was attributed to this call (the
 * gate is not installed, or the tracker deferred its beacon past the synchronous
 * window). Callers must treat an unobserved call as "no delivery signal" rather
 * than as success.
 */
export function observeCollectorDelivery<T>(
  invoke: () => T,
  requestType: CollectorRequestType,
): { observed: boolean; result: T | Promise<Response> } {
  if (!isCollectorGateInstalled()) return { observed: false, result: invoke() };

  const slot: ObservationSlot = { requestType };
  pendingObservation = slot;
  try {
    const result = invoke();
    return slot.delivery
      ? { observed: true, result: slot.delivery }
      : { observed: false, result };
  } finally {
    pendingObservation = null;
  }
}

export function resetCollectorTransportForTesting(): void {
  collectorTransportGeneration += 1;
  for (const request of collectorRequestQueue.splice(0, collectorRequestQueue.length)) {
    const error = new Error('Umami collector transport reset');
    request.reject(error);
    request.rejectDelivery(error);
  }
  collectorRequestInFlight = false;
  collectorDispatchDepth = 0;
  pendingObservation = null;
  if (typeof window !== 'undefined' && collectorFetchWrapper && window.fetch === collectorFetchWrapper && collectorFetchOriginal) {
    try {
      window.fetch = collectorFetchOriginal;
    } catch {
      // Test harnesses may expose a non-writable fetch property.
    }
  }
  if (typeof window !== 'undefined' && collectorUnloadFlush) {
    try {
      window.removeEventListener('pagehide', collectorUnloadFlush);
      if (typeof document !== 'undefined' && collectorVisibilityFlush) {
        document.removeEventListener('visibilitychange', collectorVisibilityFlush);
      }
    } catch {
      // Listener teardown is best-effort.
    }
  }
  collectorUnloadFlush = null;
  collectorVisibilityFlush = null;
  collectorFetchOriginal = null;
  collectorFetchWrapper = null;
  collectorHealthEndpoint = DEFAULT_COLLECTOR_HEALTH_ENDPOINT;
  collectorHealthReporter = (report) => sendCollectorHealthReport(collectorHealthEndpoint, report);
  resetCollectorHealthWindow(0);
}

/** Test-only: current rolling health window. */
export function getCollectorHealthForTesting(): {
  writes: number;
  failures: number;
  noiseReported: boolean;
  reportedFailureSignatures: number;
  cohorts: Record<CollectorHealthCohort, CollectorHealthCounters>;
} {
  return {
    writes: collectorHealthWindow.writes,
    failures: collectorHealthWindow.failures,
    noiseReported: collectorHealthWindow.noiseReported,
    reportedFailureSignatures: collectorHealthWindow.reportedFailureSignatures.size,
    cohorts: {
      event: { ...collectorHealthWindow.cohorts.event },
      'critical-event': { ...collectorHealthWindow.cohorts['critical-event'] },
      identify: { ...collectorHealthWindow.cohorts.identify },
    },
  };
}
