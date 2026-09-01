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
 *  2. Every dispatch is time-bounded on BOTH sides. The single slot means one
 *     hung request would otherwise wedge every subsequent write for the page's
 *     lifetime. An abort signal alone does not buy that: it bounds the request
 *     only if the transport underneath honors it, and `window.fetch` on this
 *     page is routinely wrapped by third-party instrumentation that does not.
 *     So the slot is released on a deadline this module owns, raced against the
 *     awaited response — see `withCollectorDeadline` and `CollectorFailure.raced`.
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
  /**
   * This module gave up on the write while the request was STILL OUTSTANDING.
   *
   * Only ever set on `kind: 'timeout'`, and only by the module-owned latch
   * deadline (see `withCollectorDeadline`). A `timeout` without this marker means the
   * transport observed our abort and settled, so nothing is left on the wire.
   * With it, the request was never cancelled — a wrapper that discarded
   * `init.signal` is still holding it, and it may yet commit.
   *
   * KNOWN LIMITATION: this is a timing inference, not a fact reported by the
   * transport. `LATCH_RELEASE_GRACE_MS` makes a false positive unlikely, not
   * impossible — and #6968 pauses the latch while the tab is hidden so a
   * frozen WebKit fetch is no longer the main source of that false positive.
   * A hidden tab under intensive timer throttling can still leave the abort
   * and the latch due in one wake-up if both fire after the tab returns, and
   * a cleanly-cancelled write would then be marked `raced` and lose both its
   * retry and its durable marker. The inverse (a genuinely outstanding
   * request NOT marked `raced`) cannot happen: only this module's deadline
   * sets the marker.
   *
   * A MARKER rather than a `kind`, for the same reason as `botFiltered`: the
   * delivery classification and the health cohorts keep treating it as the
   * timeout it is, so no `kind`-consuming arm has to be re-audited. Unlike
   * `botFiltered`, it is read in two categories of place, and both are
   * deliberate:
   *
   *  - RE-SEND (the reason the marker exists): `isRetryableCollectorFailure`
   *    and the durable checkout marker in `analytics.ts` both refuse to replay
   *    it, because re-sending an append-only conversion whose original may
   *    still commit double-counts it. `isRetryableIdentityFailure` still
   *    replays — an idempotent overwrite has no such hazard.
   *  - ALERTING: it is exempt from the environment-noise floors, skips the
   *    once-per-cohort noise latch, reports without waiting on the cross-user
   *    aggregate's verdict, and carries its own Sentry fingerprint segment.
   *    Not gold-plating — this fix REMOVES `queue-overflow`, the parked page's
   *    only other symptom, so without these the population goes dark exactly
   *    when the bug is fixed (#6288).
   */
  raced?: boolean;
  /**
   * This overflow happened while the page was INACTIVE — the #6968
   * visibility hold, not a parked transport.
   *
   * Only ever set on `kind: 'queue-overflow'`. `drainCollectorRequestQueue`
   * deliberately dispatches nothing while the page is hidden, so a page that
   * is hidden from install (session restore, prerender, a background-opened
   * tab) fills the queue with NOTHING in flight and rejects every later
   * write until it is focused or unloaded. That population is what kept
   * WORLDMONITOR-YD firing at its pre-fix rate after #6288 (#6947): the
   * module-owned deadline releases a parked transport, but here no transport
   * ever ran, so no deadline fix can drain the queue. The state is by
   * design and self-heals — visibilitychange→visible pumps the queue, and
   * pagehide flushes it — which is exactly why it must not share a Sentry
   * signature with the parked-latch incident that alarm exists to page on.
   *
   * A MARKER rather than a `kind`, like `raced` and `botFiltered`: every
   * delivery policy (retry refusal, durable markers, health cohorts) keeps
   * treating it as the dropped write it is; only the Sentry grouping and
   * tags read it.
   */
  hiddenHold?: boolean;
};

export type CollectorRequestType = 'event' | 'identify';

export type CollectorRequestClassification = {
  requestType: CollectorRequestType;
  eventName?: string;
  critical: boolean;
};

export type CollectorHealthCohort = 'event' | 'critical-event' | 'identify';

export type CollectorHealthFailureKind = 'network' | 'timeout' | 'missing-receipt' | 'none';

export type CollectorHealthReport = {
  cohort: CollectorHealthCohort;
  writes: number;
  /** Writes classified for the compatibility AbortController deadline path. */
  manualTimeoutWrites: number;
  failures: number;
  failureKind: CollectorHealthFailureKind;
  /** UTC minute bucket containing the client window represented by this delta. */
  bucket: number;
};

type CollectorHealthReporter = (report: CollectorHealthReport) => Promise<boolean>;

/**
 * Which request-side timeout branch bound this write.
 *
 * A MARKER, not a `kind`, for the same reason as `botFiltered`: it describes
 * the client environment, not the delivery outcome. Promoting it to its own
 * `kind` would fall through every `kind`-consuming arm that defaults to
 * actionable and page on a browser-capability gap.
 */
export type CollectorTimeoutMechanism = 'native' | 'manual';

export type CollectorOutcome = {
  requestType: CollectorRequestType;
  eventName?: string;
  requestBody?: string;
  failure: CollectorFailure | null;
  /** Which abort-binding branch produced this write's deadline signal. */
  timeoutMechanism: CollectorTimeoutMechanism;
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
 * Identity for the network-layer rejection handed back to the TRACKER.
 *
 * The tracker is third-party code served from abacus.worldmonitor.app and does
 * not handle its own rejection, so a failed beacon surfaced as an unhandled
 * `TypeError: Failed to fetch` — no host in the message, no caller in the stack,
 * and therefore indistinguishable in Sentry from a genuine api.worldmonitor.app
 * outage. Five rounds of chunk-name heuristics tried to tell them apart from the
 * stack instead (WORLDMONITOR-VC/VQ/Y4/Z6/ZG); each broke the next time Vite
 * re-partitioned the `window.fetch` trampolines into a different chunk, and the
 * chunk that carries them now also carries `runtime.ts`, so no widening of that
 * allowlist can stay safe. Naming the rejection at its source is the stable
 * form of the same intent: one exact string, from one line, for one condition.
 *
 * What this deliberately does NOT change is WHICH outcomes reject. An HTTP error
 * still resolves with the real Response (see `runCollectorRequest`) — only a
 * network-layer failure ever reaches this wrapper — so the native-fetch
 * semantics the tracker expects are preserved and only the rejection's identity
 * moves. Scope is bounded to classified collector writes: the pass-through
 * branches in `installCollectorFetchGate` hand app fetches the untouched
 * original promise, so no first-party request can acquire this wrapper.
 *
 * The original error is retained on `cause` so failure classification stays
 * exact — `collectorFailureFromError` unwraps it rather than flattening every
 * wrapped timeout into `network`.
 */
export class CollectorTransportError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Umami collector beacon transport rejected: ${detail}`);
    this.name = 'CollectorTransportError';
    this.cause = cause;
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
 * How long after the request-side deadline the module releases the latch anyway.
 *
 * The abort signal and the latch deadline must NOT expire on the same tick. A
 * transport that honors the abort still needs a moment to reject — in a browser
 * that rejection is queued as a task, and on the native path the platform's
 * `AbortSignal.timeout` timer is not ordered against this module's `setTimeout`
 * at all. Firing both at once would make the winner unspecified, so a perfectly
 * cooperative transport would intermittently be reclassified as `raced` and lose
 * the retry it is entitled to. The grace period buys determinism: the transport
 * always gets first refusal, and the module only steps in for a transport that
 * did not answer the abort at all.
 *
 * Sized well above the rejection itself because the two clocks can drift under
 * load: a long task, or a hidden tab under Chromium's intensive throttling
 * (setTimeout clamped to ~1/min after 5 minutes), can leave both timers due in
 * one wake-up. The extra latency lands ONLY on the already-anomalous stalled
 * tail — a healthy write settles in milliseconds and never sees this timer — so
 * widening it costs nothing on the happy path and buys margin against a false
 * `raced`, which would cost a legitimate write both its retry and its durable
 * marker. It is a hedge, not a guarantee: see the known limitation in the
 * `raced` docblock.
 */
const LATCH_RELEASE_GRACE_MS = 5_000;

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
  visibilityAtSend?: CollectorVisibilitySnapshot;
  sentAt?: number;
  timeoutMechanism: CollectorTimeoutMechanism;
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
let collectorOutcomeObserverForTesting: ((outcome: CollectorOutcome) => void) | null = null;
type CollectorSentryEnqueue = typeof enqueueSentryCall;
let collectorSentryEnqueue: CollectorSentryEnqueue = enqueueSentryCall;
const DEFAULT_COLLECTOR_HEALTH_ENDPOINT = '/api/analytics-health';
const COLLECTOR_HEALTH_REPORT_TIMEOUT_MS = 2_000;
let collectorHealthEndpoint = DEFAULT_COLLECTOR_HEALTH_ENDPOINT;

async function sendCollectorHealthReport(
  endpoint: string,
  report: CollectorHealthReport,
): Promise<boolean> {
  if (typeof globalThis.fetch !== 'function') return false;
  // Bound through the same compatibility path as the collector write itself
  // (#6086). The previous `if (AbortSignal.timeout) init.signal = ...` left this
  // POST with NO deadline on exactly the browsers withManualAbort exists for,
  // so a hung /api/analytics-health kept the reporting promise pending forever —
  // the same defect this module fixes one layer down. The race is here for the
  // same reason it is on the collector write (#6288): the same fetch wrappers
  // sit in front of this POST, and a promise that never settles would strand
  // the Sentry fallback that reads this result.
  let bound: TimeoutBoundInit | undefined;
  try {
    bound = withCollectorDeadline({
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    }, COLLECTOR_HEALTH_REPORT_TIMEOUT_MS);
    const response = await Promise.race([globalThis.fetch(endpoint, bound.init), bound.deadline]);
    return response.ok;
  } catch {
    return false;
  } finally {
    bound?.cleanup();
  }
}

let collectorHealthReporter: CollectorHealthReporter = (report) =>
  sendCollectorHealthReport(collectorHealthEndpoint, report);

const collectorRequestQueue: CollectorRequest[] = [];
let collectorRequestInFlight = false;
let collectorFetchOriginal: typeof window.fetch | null = null;
let collectorFetchWrapper: typeof window.fetch | null = null;
let collectorUnloadFlush: ((event?: Event) => void) | null = null;
let collectorVisibilityChangeHandler: (() => void) | null = null;
let collectorPageShowHandler: (() => void) | null = null;
let collectorPageActive = true;
let collectorTransportGeneration = 0;
type CollectorHealthCounters = {
  writes: number;
  manualTimeoutWrites: number;
  failures: number;
  environmentFailures: number;
  noiseReported: boolean;
};

type CollectorHealthWindow = {
  startedAt: number;
  writes: number;
  failures: number;
  raced: number;
  manualTimeoutWrites: number;
  noiseReported: boolean;
  reportedFailureSignatures: Set<string>;
  cohorts: Record<CollectorHealthCohort, CollectorHealthCounters>;
};

function emptyCollectorHealthCounters(): CollectorHealthCounters {
  return {
    writes: 0,
    manualTimeoutWrites: 0,
    failures: 0,
    environmentFailures: 0,
    noiseReported: false,
  };
}

function createCollectorHealthWindow(startedAt = 0): CollectorHealthWindow {
  return {
    startedAt,
    writes: 0,
    failures: 0,
    raced: 0,
    manualTimeoutWrites: 0,
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
  // `raced` is part of the signature because a parked transport and an honored
  // abort share `kind` AND `status`, so without it the two would collapse to one
  // entry and whichever landed first in the window would silence the other.
  // (What stops the cohort-level noise latch pre-empting a raced report is the
  // separate `!failure.raced` guard in emitCollectorFailureToSentry — this
  // segment only keeps the two apart once they reach the dedup.)
  return [
    failure.kind,
    failure.status ?? 'none',
    failure.prismaCode ?? 'none',
    failure.constraint ?? 'none',
    failure.raced ? 'raced' : 'settled',
  ].join('|');
}

let collectorHealthWindow = createCollectorHealthWindow();
let collectorHealthReportCursor: Record<CollectorHealthCohort, {
  writes: number;
  manualTimeoutWrites: number;
  failures: number;
}> = {
  event: { writes: 0, manualTimeoutWrites: 0, failures: 0 },
  'critical-event': { writes: 0, manualTimeoutWrites: 0, failures: 0 },
  identify: { writes: 0, manualTimeoutWrites: 0, failures: 0 },
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

export function _setCollectorSentryEnqueueForTesting(enqueue: CollectorSentryEnqueue): void {
  collectorSentryEnqueue = enqueue;
}

export function _setCollectorOutcomeObserverForTesting(
  observer: ((outcome: CollectorOutcome) => void) | null,
): void {
  collectorOutcomeObserverForTesting = observer;
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
  // Unwrap the tracker-facing wrapper first: without this, a wrapped
  // TimeoutError would miss the `TimeoutError` branch below and be recorded as
  // `network`, silently corrupting the timeout/raced split the health cohorts
  // are built on.
  if (error instanceof CollectorTransportError) return collectorFailureFromError(error.cause);
  if (error instanceof CollectorDeliveryError) return error.failure;
  if (error instanceof Error && error.name === 'TimeoutError') {
    // A platform abort and this module's latch deadline both arrive as
    // TimeoutError. Only the latter leaves the request outstanding.
    return (error as CollectorTimeoutError).collectorLatchRaced
      ? { kind: 'timeout', raced: true }
      : { kind: 'timeout' };
  }
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
  // The latch deadline abandoned this request; it was never cancelled and may
  // still commit. That is the same "committed, then we stopped listening"
  // ambiguity that rules out retrying a 500 or a gateway status, so it gets the
  // same answer. Releasing the queue must not be paid for in duplicate
  // conversions (#6288). #6968 keeps this door closed: hidden-tab writes are
  // held instead of raced, so the remaining `raced` population is still an
  // outstanding request. See docs/analytics-collector-operations.md.
  if (failure.raced) return false;
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
 *
 * A `raced` failure stays retryable here for the same reason, and deliberately:
 * idempotency is what lets the latch race (#6288) recover an identity write it
 * abandoned. If the abandoned request does commit, the replay writes the same
 * snapshot over it.
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
  // A raced timeout is NOT the ad-blocker baseline these floors exist to
  // silence — it is a specific, actionable client condition (a fetch wrapper
  // that discarded our abort), and it can never clear them anyway: the module
  // abandons at most one write per REQUEST_TIMEOUT_MS + LATCH_RELEASE_GRACE_MS,
  // so a parked page produces ~2 writes per 60s window against a 5-write floor.
  // Leaving it inside the noise branch would make the parked population go dark
  // exactly when this fix removes its `queue-overflow` symptom (#6288) — the
  // opposite of what the fix is for. Volume stays bounded: one Sentry event per
  // redacted signature per window, same as every other failure.
  if (failure.raced) return true;
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
  const bucketStart = Math.floor(startedAt / HEALTH_WINDOW_MS) * HEALTH_WINDOW_MS;
  collectorHealthWindow = createCollectorHealthWindow(bucketStart);
  collectorHealthReportCursor = {
    event: { writes: 0, manualTimeoutWrites: 0, failures: 0 },
    'critical-event': { writes: 0, manualTimeoutWrites: 0, failures: 0 },
    identify: { writes: 0, manualTimeoutWrites: 0, failures: 0 },
  };
}

function buildCollectorHealthReport(
  cohort: CollectorHealthCohort,
  failureKind: CollectorHealthFailureKind = 'none',
  allowZeroFailures = false,
): CollectorHealthReport | null {
  const current = collectorHealthWindow.cohorts[cohort];
  const previous = collectorHealthReportCursor[cohort];
  const bucket = Math.floor(collectorHealthWindow.startedAt / HEALTH_WINDOW_MS);
  const writes = Math.max(0, current.writes - previous.writes);
  const manualTimeoutWrites = Math.max(
    0,
    current.manualTimeoutWrites - previous.manualTimeoutWrites,
  );
  const failures = Math.max(0, current.environmentFailures - previous.failures);
  collectorHealthReportCursor[cohort] = {
    writes: current.writes,
    manualTimeoutWrites: current.manualTimeoutWrites,
    failures: current.environmentFailures,
  };
  if (writes < 1 || (!allowZeroFailures && failures < 1)) return null;
  return { cohort, writes, manualTimeoutWrites, failures, failureKind, bucket };
}

/**
 * Publish each cohort's unreported window delta. Rollover sends the completed
 * window; pagehide sends a short session's current window. Healthy deltas carry
 * failures=0, so the server baseline is not trained only by failing pages.
 */
function reportPendingCollectorHealthDeltas(): void {
  const cohorts: CollectorHealthCohort[] = ['event', 'critical-event', 'identify'];
  for (const cohort of cohorts) {
    const report = buildCollectorHealthReport(cohort, 'none', true);
    if (!report) continue;
    try {
      void Promise.resolve(collectorHealthReporter(report)).catch(() => {});
    } catch {
      // Best effort. The next window starts independently.
    }
  }
}

type CollectorVisibilitySnapshot = DocumentVisibilityState | 'unknown';

function collectorVisibilityState(): CollectorVisibilitySnapshot {
  try {
    if (typeof document === 'undefined' || typeof document.visibilityState !== 'string') {
      return 'unknown';
    }
    return document.visibilityState;
  } catch {
    return 'unknown';
  }
}

/**
 * Serialized drain runs only while the page is in the foreground.
 *
 * A non-DOM host (this module's unit tests, the sidecar) has no visibility
 * signal, so it stays active. Treating `hidden`/`prerender` as inactive is the
 * #6968 fix: WebKit freezes in-flight `fetch` on a backgrounded tab, and the
 * previous visibilitychange→hidden flush handed the whole backlog to that
 * freeze. `pagehide` with `persisted === false` still bypasses this and
 * dispatches concurrently; a persisted pagehide (bfcache) keeps the hold.
 */
function isCollectorPageActive(): boolean {
  const visibility = collectorVisibilityState();
  return visibility === 'unknown' || visibility === 'visible';
}

function emitCollectorFailureToSentry(
  request: CollectorRequest,
  failure: CollectorFailure,
  cohort: CollectorHealthCohort,
  diagnostics: Record<string, unknown>,
): void {
  // `!failure.raced` is load-bearing: this latch fires BEFORE the signature
  // check below, so an ordinary blocked request earlier in the window would
  // otherwise return here and suppress the raced report entirely — making the
  // per-signature split pointless for the one failure it was added for. A raced
  // timeout is deduped by signature alone (one per window), not by cohort.
  if (!failure.raced && isEnvironmentNoiseFailure(failure)) {
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
    collectorSentryEnqueue((s) => s.captureMessage('Umami collector write failed', {
      level: 'warning',
      // Tags do not split issues — without a fingerprint, Sentry groups on the
      // fixed message and folds all five `kind`s into one. That is how the
      // ad-blocker population (`network`, unactionable by design) buried a
      // `queue-overflow` count that was our own dropped writes, in a single
      // 2230-event issue nobody could read a cause out of (WORLDMONITOR-Y3).
      // Cardinality stays bounded: 5 kinds x the small status set, plus the one
      // extra group a raced timeout adds. That group is worth its own issue: a
      // parked transport and an honored abort are the same `kind` but different
      // incidents, and the parked one is the failure whose only other outward
      // symptom is a queue-overflow warning that looks like trivial volume.
      fingerprint: [
        'analytics-collector',
        'write-failed',
        failure.kind,
        String(failure.status ?? 'none'),
        ...(failure.raced ? ['raced'] : []),
        // A designed visibility hold (#6968) and a parked transport are the
        // same `kind` but different incidents (#6947) — same reasoning as
        // the raced segment above. The hold self-heals on focus/unload; the
        // parked latch is the incident WORLDMONITOR-YD exists to page on.
        ...(failure.hiddenHold ? ['hidden-hold'] : []),
      ],
      tags: {
        kind: 'analytics_collector_write_failed',
        failureKind: failure.kind,
        status: String(failure.status ?? 'none'),
        requestType: request.requestType,
        healthCohort: cohort,
        raced: String(failure.raced ?? false),
        hiddenHold: String(failure.hiddenHold ?? false),
        timeoutMechanism: request.timeoutMechanism,
        visibilityAtSend: request.visibilityAtSend ?? 'unknown',
        // Visibility when the failure was RECORDED. visibilityAtSend is set
        // at dispatch, which a queue-overflow never reaches — its absence is
        // why #6947 needed a forensic build_sha reconstruction instead of a
        // tag query.
        pageVisibility: collectorVisibilityState(),
      },
      extra: diagnostics,
    }));
  } catch { /* best-effort telemetry */ }
}

function recordCollectorOutcome(request: CollectorRequest, failure: CollectorFailure | null): void {
  const now = Date.now();
  const hasStartedWindow = collectorHealthWindow.startedAt !== 0 || collectorHealthWindow.writes > 0;
  if (!hasStartedWindow || now - collectorHealthWindow.startedAt >= HEALTH_WINDOW_MS) {
    if (hasStartedWindow) reportPendingCollectorHealthDeltas();
    resetCollectorHealthWindow(now);
  }
  collectorHealthWindow.writes += 1;
  const cohort = getCollectorHealthCohort(request);
  const cohortWindow = collectorHealthWindow.cohorts[cohort];
  cohortWindow.writes += 1;

  const timeoutMechanism = request.timeoutMechanism;
  if (timeoutMechanism === 'manual') {
    collectorHealthWindow.manualTimeoutWrites += 1;
    cohortWindow.manualTimeoutWrites += 1;
  }

  const outcome: CollectorOutcome = {
    requestType: request.requestType,
    eventName: request.eventName,
    requestBody: typeof request.init?.body === 'string' ? request.init.body : undefined,
    failure,
    timeoutMechanism,
  };
  onCollectorOutcome(outcome);
  collectorOutcomeObserverForTesting?.(outcome);
  if (!failure) return;

  collectorHealthWindow.failures += 1;
  cohortWindow.failures += 1;
  if (isEnvironmentNoiseFailure(failure)) cohortWindow.environmentFailures += 1;
  if (failure.botFiltered) {
    // Bot-filtered writes are expected drops, not evidence about the collector.
    cohortWindow.writes -= 1;
    cohortWindow.failures -= 1;
    if (timeoutMechanism === 'manual') cohortWindow.manualTimeoutWrites -= 1;
  }
  // Deliberately reports only delivery metadata. The event payload can contain
  // billing or identity data and must never be copied into diagnostics.
  const cohortFailureRate = cohortWindow.writes > 0
    ? cohortWindow.failures / cohortWindow.writes
    : 0;
  const environmentFailureRate = cohortWindow.writes > 0
    ? cohortWindow.environmentFailures / cohortWindow.writes
    : 0;
  if (failure.raced) collectorHealthWindow.raced += 1;
  const racedRate = collectorHealthWindow.writes > 0
    ? collectorHealthWindow.raced / collectorHealthWindow.writes
    : 0;
  const manualTimeoutRate = collectorHealthWindow.writes > 0
    ? collectorHealthWindow.manualTimeoutWrites / collectorHealthWindow.writes
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
    racedCount: collectorHealthWindow.raced,
    racedRate,
    cohortFailureCount: cohortWindow.failures,
    cohortWriteCount: cohortWindow.writes,
    prismaCode: failure.prismaCode ?? null,
    constraint: failure.constraint ?? null,
    // The console warning fires for suppressed failures too, so it has to say
    // WHY a receiptless 200 happened — otherwise a developer reading devtools
    // during a bot-filtered write starts debugging a write path that is fine.
    botFiltered: failure.botFiltered ?? false,
    visibilityAtSend: request.visibilityAtSend ?? 'unknown',
    visibilityAtDeadline: failure.kind === 'timeout' ? collectorVisibilityState() : null,
    elapsedAtDeadlineMs: failure.kind === 'timeout' && request.sentAt !== undefined
      ? Math.max(0, Date.now() - request.sentAt)
      : null,
    // True means the request is STILL OUTSTANDING — the queue was released
    // without it, so this page is behind a fetch wrapper that ignores aborts.
    raced: failure.raced ?? false,
    timeoutMechanism,
    manualTimeoutWrites: collectorHealthWindow.manualTimeoutWrites,
    manualTimeoutRate,
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
  // A raced write still counts toward the cross-user aggregate like any other
  // environment failure, but its Sentry event does NOT wait on the aggregate's
  // verdict. The ordinary path below emits only when the aggregate DECLINES the
  // report (`if (accepted || ...) return`), which on a healthy site is never —
  // so routing a raced timeout through it would silence the parked population
  // on exactly the deployments where the aggregate endpoint is working. This is
  // the one client condition whose only other symptom this fix deliberately
  // removes (#6288), so it reports on its own.
  if (failure.raced) {
    // `raced` is only ever set on a `timeout` (see CollectorFailure.raced),
    // which is an environment-noise kind. The guard proves that to the compiler
    // and keeps the aggregate correct if the marker's domain ever widens.
    const racedReport = isEnvironmentNoiseFailure(failure)
      ? buildCollectorHealthReport(cohort, failure.kind)
      : null;
    if (racedReport) {
      try {
        void Promise.resolve(collectorHealthReporter(racedReport)).catch(() => {});
      } catch {
        // Best effort — the Sentry event below is the signal that matters here.
      }
    }
    emitCollectorFailureToSentry(request, failure, cohort, diagnostics);
    return;
  }

  if (isEnvironmentNoiseFailure(failure)) {
    const localSnapshot: CollectorHealthSnapshot = {
      writes: cohortWindow.writes,
      failures: cohortWindow.environmentFailures,
      noiseReported: cohortWindow.noiseReported,
    };
    const report = buildCollectorHealthReport(cohort, failure.kind);
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

/** A request-side abort binding: the deadline we ASK the transport to observe. */
type AbortBoundInit = {
  init: RequestInit;
  cleanup: () => void;
  timeoutMechanism: CollectorTimeoutMechanism;
};

type TimeoutBoundInit = AbortBoundInit & {
  /**
   * The module-owned half of the deadline: rejects with a raced `TimeoutError`
   * once the transport has had the request bound plus `LATCH_RELEASE_GRACE_MS`
   * to answer. Race this against the awaited response so releasing the
   * serialized slot never depends on the callee honoring `init.signal`.
   */
  deadline: Promise<never>;
  /** Freeze the latch while the tab is backgrounded (#6968). */
  pause: () => void;
  /** Re-arm remaining latch time when the tab is foregrounded again. */
  resume: () => void;
};

/**
 * `raced` distinguishes the two failures that both surface as `TimeoutError`:
 * an abort the transport observed (nothing left on the wire) and a deadline
 * this module enforced unilaterally (the request is still outstanding).
 */
type CollectorTimeoutError = Error & { collectorLatchRaced?: true };

function createTimeoutError(timeoutMs: number = REQUEST_TIMEOUT_MS, raced = false): Error {
  const error: CollectorTimeoutError = new Error(
    raced
      ? `Umami collector request abandoned after ${timeoutMs}ms without the transport settling`
      : `Umami collector request timed out after ${timeoutMs}ms`,
  );
  error.name = 'TimeoutError';
  if (raced) error.collectorLatchRaced = true;
  return error;
}

function withManualAbort(
  init: RequestInit | undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): AbortBoundInit {
  if (typeof AbortController === 'undefined') throw createTimeoutError(timeoutMs);

  const controller = new AbortController();
  const existing = init?.signal;
  const forwardAbort = (): void => controller.abort(existing?.reason);
  if (existing?.aborted) forwardAbort();
  else existing?.addEventListener('abort', forwardAbort, { once: true });

  const timeoutId = setTimeout(
    () => controller.abort(createTimeoutError(timeoutMs)),
    timeoutMs,
  );
  return {
    init: { ...(init ?? {}), signal: controller.signal },
    cleanup: () => {
      clearTimeout(timeoutId);
      existing?.removeEventListener('abort', forwardAbort);
    },
    timeoutMechanism: 'manual',
  };
}

/**
 * Select the deadline branch without creating a signal or timer.
 *
 * Requests can be dropped before dispatch, so their outcome still needs the
 * marker that dispatch would have used. `withRequestAbort` remains the source
 * of the actual binding and overwrites this prediction once the write starts.
 */
function getIntendedCollectorTimeoutMechanism(
  init: RequestInit | undefined,
): CollectorTimeoutMechanism {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return 'manual';
  }
  return init?.signal && typeof AbortSignal.any !== 'function' ? 'manual' : 'native';
}

function withRequestAbort(
  init: RequestInit | undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): AbortBoundInit {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return withManualAbort(init, timeoutMs);
  }
  const existing = init?.signal;
  if (!existing) {
    return {
      init: { ...(init ?? {}), signal: AbortSignal.timeout(timeoutMs) },
      cleanup: () => {},
      timeoutMechanism: 'native',
    };
  }
  if (typeof AbortSignal.any === 'function') {
    return {
      init: { ...init, signal: AbortSignal.any([existing, AbortSignal.timeout(timeoutMs)]) },
      cleanup: () => {},
      timeoutMechanism: 'native',
    };
  }
  return withManualAbort(init, timeoutMs);
}

/**
 * Bind BOTH halves of the deadline (#6288).
 *
 * The abort signal above is request-side: an `AbortController` only settles a
 * fetch if the implementation underneath honors the signal, and nothing
 * verifies that it does. `src/bootstrap/sentry-init.ts` documents third-party
 * `window.fetch` wrapping as a live condition on this collector host, and two
 * wrapper shapes defeat an abort outright — one that rebuilds the request
 * (`orig(new Request(url, { method, headers, body }))`, the standard shape for
 * RUM SDKs that re-time requests) silently drops `init.signal`, and one that
 * re-wraps the promise without forwarding rejection never settles at all. On
 * the native branch the entire deadline lives inside the `AbortSignal.timeout`
 * object such a wrapper discards, so that path — which carries essentially all
 * real traffic — had strictly LESS module-side protection than the
 * compatibility path.
 *
 * `deadline` is the half nobody else can withhold. Keep sending the abort too:
 * cancelling a well-behaved transport is still correct, and the race only stops
 * a badly-behaved one from holding the single in-flight slot forever.
 */
function withCollectorDeadline(
  init: RequestInit | undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): TimeoutBoundInit {
  // First, because withManualAbort throws when AbortController is unavailable.
  const bound = withRequestAbort(init, timeoutMs);
  let remainingMs = timeoutMs + LATCH_RELEASE_GRACE_MS;
  let startedAt = Date.now();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  let settleGraceGranted = false;
  let settled = false;
  let rejectDeadline: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  // The transport wins the race in every healthy case, and the loser of a
  // Promise.race is still rejected. Keep that from surfacing as an unhandled
  // rejection on the page.
  void deadline.catch(() => {});

  const arm = (): void => {
    if (settled || paused) return;
    startedAt = Date.now();
    deadlineTimer = setTimeout(() => {
      if (settled || paused) return;
      settled = true;
      const fired = deadlineTimer;
      deadlineTimer = undefined;
      // Tests fire the callback directly; still mark the fake timer cancelled
      // so a later findLatchDeadline cannot pick up this spent deadline.
      if (fired !== undefined) clearTimeout(fired);
      rejectDeadline(createTimeoutError(timeoutMs, true));
    }, remainingMs);
  };
  const pause = (): void => {
    if (paused || settled || deadlineTimer === undefined) return;
    remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
    clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    paused = true;
  };
  const resume = (): void => {
    if (!paused || settled) return;
    paused = false;
    // Hidden time can leave a 1ms–Nms sliver. Firing that sliver on the first
    // visible tick would race a fetch that is only now unfreezing. Grant one
    // settle-grace per request, then consume the real remaining foreground
    // budget on later visibility cycles so a stalled wrapper stays bounded.
    if (!settleGraceGranted && remainingMs < LATCH_RELEASE_GRACE_MS) {
      remainingMs = LATCH_RELEASE_GRACE_MS;
      settleGraceGranted = true;
    }
    arm();
  };

  arm();
  return {
    init: bound.init,
    deadline,
    pause,
    resume,
    timeoutMechanism: bound.timeoutMechanism,
    cleanup: () => {
      settled = true;
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      bound.cleanup();
    },
  };
}

const pausableCollectorDeadlines = new Set<Pick<TimeoutBoundInit, 'pause' | 'resume'>>();

function pauseCollectorLatchDeadlines(): void {
  for (const handle of pausableCollectorDeadlines) handle.pause();
}

function resumeCollectorLatchDeadlines(): void {
  for (const handle of pausableCollectorDeadlines) handle.resume();
}

async function runCollectorRequest(request: CollectorRequest, generation: number): Promise<void> {
  let timeoutBoundInit: TimeoutBoundInit | undefined;
  try {
    // The re-entrancy guard must cover ONLY the synchronous call into the
    // underlying fetch — that is the window in which a foreign wrapper stacked
    // on top of us can delegate back down for this same request. Holding it
    // across the await would make every write issued while one is in flight
    // bypass the queue, which is the serialization this module exists for.
    let responsePromise: Promise<Response>;
    let deadline: Promise<never>;
    collectorDispatchDepth += 1;
    try {
      request.sentAt = Date.now();
      request.visibilityAtSend = collectorVisibilityState();
      timeoutBoundInit = withCollectorDeadline(request.init);
      request.timeoutMechanism = timeoutBoundInit.timeoutMechanism;
      pausableCollectorDeadlines.add(timeoutBoundInit);
      deadline = timeoutBoundInit.deadline;
      responsePromise = request.originalFetch(request.input, timeoutBoundInit.init);
    } finally {
      collectorDispatchDepth -= 1;
    }
    // Race, rather than trusting the callee to observe the abort (#6288). The
    // single in-flight slot means this `await` IS the latch: `drainCollectorRequestQueue`
    // releases `collectorRequestInFlight` from the `.finally()` on this call, so
    // a transport that never settles parks every subsequent write for the life
    // of the page. Losing the race abandons the request but cannot cancel it,
    // which is why the resulting failure is marked `raced` — see CollectorFailure.
    const response = await Promise.race([responsePromise, deadline]);
    // The body is a SEPARATE stream from the headers. `fetch` resolves the
    // moment response headers arrive, and `inspectCollectorResponse` then
    // awaits `response.text()` to read the write receipt. Racing only the
    // headers would leave a transport that answers headers and stalls the body
    // re-parking the latch HERE — the same #6288 wedge, one line past the
    // deadline that just guarded it. The timer is still live (had it expired,
    // it would have won the race above and we would be in the catch), so
    // extending the same deadline across the read costs nothing.
    const failure = generation === collectorTransportGeneration
      ? await Promise.race([inspectCollectorResponse(response), deadline])
      : null;
    if (generation === collectorTransportGeneration) recordCollectorOutcome(request, failure);
    // Resolve the TRACKER's promise with the real Response either way — Umami
    // expects native fetch semantics (only a network error rejects). The
    // delivery promise is the separate, honest signal.
    request.resolve(response);
    if (failure) request.rejectDelivery(new CollectorDeliveryError(failure));
    else request.resolveDelivery(response);
  } catch (error) {
    const failure = collectorFailureFromError(error);
    if (generation === collectorTransportGeneration) {
      recordCollectorOutcome(request, failure);
    }
    // Only the TRACKER-facing promise is renamed, and only for the failure shape
    // that arrives ANONYMOUS. The tracker leaks its rejection, so this is the
    // promise that reaches Sentry (see CollectorTransportError).
    //
    // Scoped to `network` because that is the whole ambiguity: the raw error
    // there is a bare `TypeError: Failed to fetch`, which carries no host and no
    // caller and is therefore indistinguishable from a first-party API outage.
    // A `timeout` already rejects with a distinctly-named `TimeoutError` that
    // Sentry groups on its own and our filters already recognise, so renaming it
    // would buy nothing while breaking the identity the timeout suite pins in a
    // dozen places (#6086 / #6288). Anything unrecognised classifies as
    // `network` and is therefore wrapped by default — the fail-safe direction,
    // since an unnamed rejection is exactly what must not reach Sentry
    // unattributed.
    //
    // A CALLER cancellation is never wrapped. When the caller aborts with its
    // own reason, that exact object propagates through the forwarded
    // AbortController and must come back identity-equal — a contract the
    // compatibility suite asserts with `error === reason`
    // (tests/analytics-beacon-rejection.test.mts). It also needs no attribution:
    // the caller already knows why it aborted. Detected by identity rather than
    // by shape, because a caller reason is an arbitrary value that classifies as
    // `network` like anything else unrecognised.
    //
    // `delivery` keeps the raw error either way: it is our own internal signal,
    // and the retry policy and health cohorts classify off it.
    const callerSignal = request.init?.signal;
    const isCallerCancellation = callerSignal?.aborted === true && callerSignal.reason === error;
    request.reject(
      failure.kind === 'network' && !isCallerCancellation
        ? new CollectorTransportError(error)
        : error,
    );
    request.rejectDelivery(error);
  } finally {
    if (timeoutBoundInit) pausableCollectorDeadlines.delete(timeoutBoundInit);
    timeoutBoundInit?.cleanup();
  }
}

function drainCollectorRequestQueue(): void {
  if (collectorRequestInFlight || collectorRequestQueue.length === 0) return;
  if (!collectorPageActive) return;
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
  const failure: CollectorFailure = {
    kind: 'queue-overflow',
    // While the page is inactive the queue holds by design (#6968) — see the
    // hiddenHold docblock. Read at rejection time: what matters is whether
    // dispatch was gated when this entry was turned away.
    ...(collectorPageActive ? {} : { hiddenHold: true }),
  };
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
    timeoutMechanism: getIntendedCollectorTimeoutMechanism(init),
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
  collectorPageActive = isCollectorPageActive();

  // pagehide flushes only for a real navigation. `event.persisted` means the
  // page is entering bfcache — the same freeze as visibilitychange→hidden —
  // so we keep the hold. visibilitychange→hidden used to flush too, as a
  // Safari-friendly unload analogue. That is the #6968 Apple-skew population:
  // WebKit freezes those concurrent fetches, the latch fires, and both
  // recovery doors close. Hold the serialized queue and pause in-flight
  // latches until the page is visible again.
  const onPageHide = (event?: Event): void => {
    const persisted = Boolean(
      event && 'persisted' in event && (event as PageTransitionEvent).persisted,
    );
    if (persisted) {
      collectorPageActive = false;
      pauseCollectorLatchDeadlines();
      return;
    }
    reportPendingCollectorHealthDeltas();
    resumeCollectorLatchDeadlines();
    flushCollectorQueueForUnload();
  };
  const onVisibilityChange = (): void => {
    const wasActive = collectorPageActive;
    collectorPageActive = isCollectorPageActive();
    if (collectorPageActive) {
      if (!wasActive) resumeCollectorLatchDeadlines();
      drainCollectorRequestQueue();
      return;
    }
    if (wasActive) pauseCollectorLatchDeadlines();
  };
  const onPageShow = (): void => {
    const wasActive = collectorPageActive;
    collectorPageActive = isCollectorPageActive();
    if (collectorPageActive) {
      if (!wasActive) resumeCollectorLatchDeadlines();
      drainCollectorRequestQueue();
    }
  };
  collectorUnloadFlush = onPageHide;
  collectorVisibilityChangeHandler = onVisibilityChange;
  collectorPageShowHandler = onPageShow;
  try {
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
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
      if (collectorPageShowHandler) {
        window.removeEventListener('pageshow', collectorPageShowHandler);
      }
      if (typeof document !== 'undefined' && collectorVisibilityChangeHandler) {
        document.removeEventListener('visibilitychange', collectorVisibilityChangeHandler);
      }
    } catch {
      // Listener teardown is best-effort.
    }
  }
  collectorUnloadFlush = null;
  collectorVisibilityChangeHandler = null;
  collectorPageShowHandler = null;
  collectorPageActive = true;
  collectorFetchOriginal = null;
  collectorFetchWrapper = null;
  pausableCollectorDeadlines.clear();
  collectorHealthEndpoint = DEFAULT_COLLECTOR_HEALTH_ENDPOINT;
  collectorHealthReporter = (report) => sendCollectorHealthReport(collectorHealthEndpoint, report);
  collectorSentryEnqueue = enqueueSentryCall;
  collectorOutcomeObserverForTesting = null;
  resetCollectorHealthWindow(0);
}

/** Test-only: current rolling health window. */
export function getCollectorHealthForTesting(): {
  writes: number;
  failures: number;
  raced: number;
  manualTimeoutWrites: number;
  noiseReported: boolean;
  reportedFailureSignatures: number;
  cohorts: Record<CollectorHealthCohort, CollectorHealthCounters>;
} {
  return {
    writes: collectorHealthWindow.writes,
    failures: collectorHealthWindow.failures,
    raced: collectorHealthWindow.raced,
    manualTimeoutWrites: collectorHealthWindow.manualTimeoutWrites,
    noiseReported: collectorHealthWindow.noiseReported,
    reportedFailureSignatures: collectorHealthWindow.reportedFailureSignatures.size,
    cohorts: {
      event: { ...collectorHealthWindow.cohorts.event },
      'critical-event': { ...collectorHealthWindow.cohorts['critical-event'] },
      identify: { ...collectorHealthWindow.cohorts.identify },
    },
  };
}
