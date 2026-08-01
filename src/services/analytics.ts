/**
 * Analytics facade — wired to Umami.
 *
 * Dashboard analytics load after first paint; calls made before the script
 * arrives are kept in a small bounded queue and replayed on script load.
 */

import { scheduleAfterFirstPaint } from '@/utils/after-paint';
import { subscribeAuthState, type AuthSession } from './auth-state';
import { onSubscriptionChange, type SubscriptionInfo } from './billing';
import { getClerkUserCreatedAt } from './clerk';
import { DODO_PRODUCT_IDS } from '@/config/product-ids.generated';
import type { ActivationEventName, ActivationStepId } from './pro-activation-state';
import {
  collectorFailureFromError,
  configureCollectorTransport,
  installCollectorFetchGate,
  isRetryableCollectorFailure,
  isRetryableIdentityFailure,
  observeCollectorDelivery,
  resetCollectorTransportForTesting,
  type CollectorOutcome,
} from './analytics-collector-transport';
import {
  getContentAttributionAnalyticsFields,
  getContentAttributionForAnalytics,
  withContentAttribution,
} from '../../shared/content-attribution';

const UMAMI_SCRIPT_SRC = 'https://abacus.worldmonitor.app/script.js';
const UMAMI_COLLECTOR_ENDPOINT = new URL('/api/send', UMAMI_SCRIPT_SRC).href;
const UMAMI_WEBSITE_ID = 'e8800335-c853-46a8-8497-c993ed2f58bc';
// data-domains is temporarily reduced to the worldmonitor.app hosts + happy
// while upstream Umami issue #4183 (https://github.com/umami-software/umami/issues/4183)
// is open — v3.1.0 has a race in prisma.sessionData.updateMany() that returns HTTP 500
// from /api/send for 4-8% of requests across all listed hosts. Self-hosted Umami has no
// fix tag yet (master since 2026-04-17 has 22 commits but none touch sessionData). The
// tracker self-disables when the current hostname isn't in data-domains — the same
// mechanism that keeps energy.worldmonitor.app silent. Restore tech, finance, and
// commodity once #4183 ships in a tagged release.
//
// www.worldmonitor.app MUST be listed alongside the apex (#4931): the apex 301s
// to www in production, and the tracker's data-domains check is an EXACT
// hostname match (`!domains.includes(hostname)` → disabled) — with only the
// apex listed, every event from the canonical host was silently dropped.
const UMAMI_DOMAINS = 'worldmonitor.app,www.worldmonitor.app,happy.worldmonitor.app';
const UMAMI_QUEUE_LIMIT = 50;
const UMAMI_LOAD_ATTEMPT_LIMIT = 2;
const UMAMI_LOAD_RETRY_DELAY_MS = 5_000;
const UMAMI_IDENTIFY_RETRY_LIMIT = 2;
const UMAMI_IDENTIFY_RETRY_BASE_DELAY_MS = 1_000;
const UMAMI_TRACK_RETRY_LIMIT = 2;
const CRITICAL_TRACK_EVENTS = new Set<UmamiEvent>([
  'checkout-start',
  'checkout-success',
  'checkout-failed',
]);

type QueuedUmamiCall =
  | { kind: 'track'; event: UmamiEvent; data?: Record<string, unknown>; retryAttempt?: number }
  | {
      kind: 'identify';
      data: Record<string, unknown>;
      revision: number;
      retryAttempt: number;
    };
type IdentifyCall = Extract<QueuedUmamiCall, { kind: 'identify' }>;

const pendingUmamiCalls: QueuedUmamiCall[] = [];
let umamiLoadScheduled = false;
let umamiLoadStarted = false;
let umamiLoadAttempts = 0;
let latestIdentityRevision = 0;
let identifyRetryTimer: ReturnType<typeof setTimeout> | null = null;
let identifyInFlight = false;
let pendingIdentityCall: IdentifyCall | null = null;
let identifyDeliveryGeneration = 0;
let trackRetryGeneration = 0;

// ---------------------------------------------------------------------------
// Type-safe event catalog — every event name lives here.
// Typo in an event string = compile error.
// ---------------------------------------------------------------------------

const EVENTS = {
  // Search
  'search-open': true,
  'search-used': true,
  'search-result-selected': true,
  // Country / map
  'country-selected': true,
  'country-brief-opened': true,
  'map-layer-toggle': true,
  // Panels
  'panel-toggle': true,
  // Settings
  'settings-open': true,
  'variant-switch': true,
  'theme-changed': true,
  'language-change': true,
  'feature-toggle': true,
  // News
  'news-sort-toggle': true,
  'news-summarize': true,
  'live-news-fullscreen': true,
  // Webcams
  'webcam-selected': true,
  'webcam-region-filter': true,
  'webcam-fullscreen': true,
  // Downloads / banners
  'download-clicked': true,
  'critical-banner': true,
  // AI widget
  'widget-ai-open': true,
  'widget-ai-generate': true,
  'widget-ai-success': true,
  // WM Analyst dashboard control
  'analyst-control-action': true,
  // MCP
  'mcp-connect-attempt': true,
  'mcp-connect-success': true,
  'mcp-panel-add': true,
  // WebMCP (in-page agent tool surface)
  'webmcp-registered': true,
  'webmcp-tool-invoked': true,
  // Route Explorer
  'route-explorer:opened': true,
  'route-explorer:query': true,
  'route-explorer:tab-switch': true,
  'route-explorer:alternative-selected': true,
  'route-explorer:impact-viewed': true,
  'route-explorer:share-copied': true,
  'route-explorer:free-cta-click': true,
  'route-explorer:closed': true,
  // Auth (wired in PR #1812 — do not remove)
  'sign-in': true,
  'sign-up': true,
  'sign-out': true,
  'gate-hit': true,
  // Conversion funnel (#4931) — pageview → gate-hit → checkout-start →
  // checkout-success is the end-to-end funnel; the /pro page fires its own
  // checkout-start via the raw tracker (separate build, same event name).
  'checkout-start': true,
  'checkout-success': true,
  'checkout-failed': true,
  'content-handoff': true,
  // API outcome telemetry — closed-vocabulary key lifecycle actions only;
  // never include key names, ids, prompts, or request/user data.
  'api-action': true,
  // Premium entitlement health — a client that believes it is Pro received a
  // server-side denial. This is trend telemetry, never an authorization signal.
  'entitlement-desync': true,
  // Brief — open-rate lift measurement for U10's followed-country bias
  // (followed-countries plan U11). Fired from the dashboard cover card
  // and from the hosted magazine source-link clicks. `followed` flags
  // whether the click target maps to a country the user follows;
  // correlate with non-followed threads to size the bias's effect.
  'brief-thread-open': true,
  // Pro Activation Onboarding funnel (#4771) — day-0 activation interstitial:
  // entered → per-step confirmed/skipped/blocked/failed → exit (with completion
  // state). Names mirror ACTIVATION_EVENTS in @/services/pro-activation-state
  // (the single naming source); this catalog matches those literals.
  // `blocked` is a platform refusal, not a user choice (#5609); `failed`
  // (#5600) is our own write erroring. Both used to land as `skipped`, which is
  // how a day of broken day-0 activations read as user disinterest.
  'pro-activation-entered': true,
  'pro-activation-step-confirmed': true,
  'pro-activation-step-skipped': true,
  'pro-activation-step-blocked': true,
  'pro-activation-step-failed': true,
  'pro-activation-exit': true,
} as const;

export type UmamiEvent = keyof typeof EVENTS;

/**
 * Durable-delivery contract for the terminal funnel events.
 *
 * #4934 round-2 F2: the marker written by trackCheckoutSuccess clears only once
 * the event actually reached the collector, so a page reload that races the
 * deferred queue replays instead of dropping it.
 * #4934 round-6: the /pro handoff marker clears only for a REPLAYED
 * checkout-start — a live dashboard checkout-start proves nothing about queued
 * replays.
 *
 * Both invariants now key off a confirmed collector receipt rather than "track()
 * returned without throwing".
 */
/**
 * Whether a completed write settles a durable checkout marker.
 *
 * The question is only ever "could this have committed a row?", because that is
 * what makes a boot replay a DUPLICATE rather than a recovery:
 *
 * - delivered (no failure)        -> settled.
 * - an HTTP failure we will not retry (500/502/504, and #4183's P2002) -> the
 *   origin engaged the request and may have written the event row before
 *   failing. The in-page retry already refuses to re-send it for exactly that
 *   reason; leaving the marker armed would let the next boot re-send it anyway.
 * - queue-overflow / missing-receipt / network / timeout -> no row can exist
 *   (never dispatched, or accepted-and-discarded, or never answered), so the
 *   marker must survive and replay. These are recoveries, not duplicates.
 */
function isDurableMarkerResolved(failure: CollectorOutcome['failure']): boolean {
  if (failure === null) return true;
  if (failure.kind !== 'http') return false;
  return !isRetryableCollectorFailure(failure);
}

function handleCollectorOutcome(outcome: CollectorOutcome): void {
  if (outcome.requestType !== 'event') return;

  // A session_data uniqueness conflict is NOT a lost event. Umami writes the
  // event row in saveEvent() and only then upserts session_data, so #4183's
  // P2002 means the event committed and the follow-up metadata write lost a
  // race. Treating it as undelivered would replay the conversion on every boot
  // for the life of the tab — the duplicate the no-retry policy exists to stop.
  //
  // The same reasoning generalises: ANY failure the retry policy refuses to
  // re-send in-page must also be terminal for the durable marker. A 502/504 (or
  // a 500 whose body carried no Prisma metadata to recognise) reached the origin
  // and may have committed the row, and a receiptless 200 was accepted and
  // discarded — none of them are retried, so leaving the marker armed would let
  // the boot replay smuggle the event back in and duplicate the conversion that
  // isRetryableCollectorFailure just declined to risk.
  //
  // A queue-overflow drop is the one exception: it never reached the network at
  // all, so the marker must survive for the next boot to replay it.
  if (!isDurableMarkerResolved(outcome.failure)) return;

  if (outcome.eventName === 'checkout-success') clearPendingCheckoutSuccessMarker();
  if (outcome.eventName === 'checkout-start' && isReplayedCheckoutStart(outcome.requestBody)) {
    noteProFunnelReplayDelivered();
  }
  if (outcome.eventName === 'checkout-start' || outcome.eventName === 'checkout-failed') {
    forgetPendingConversion(outcome.eventName);
  }
}

configureCollectorTransport({
  endpoint: UMAMI_COLLECTOR_ENDPOINT,
  isCriticalEvent: (name) => CRITICAL_TRACK_EVENTS.has(name as UmamiEvent),
  onOutcome: handleCollectorOutcome,
});

function isReplayedCheckoutStart(requestBody: string | undefined): boolean {
  if (typeof requestBody !== 'string') return false;
  try {
    const body = JSON.parse(requestBody) as { payload?: { data?: { replayed?: unknown } } };
    return body?.payload?.data?.replayed === true;
  } catch {
    // A malformed tracker body cannot be a confirmed replay.
    return false;
  }
}

function queueUmamiCall(call: QueuedUmamiCall): void {
  // Identity is a latest-snapshot write, not an append-only event. Auth and
  // billing can both publish before the deferred tracker loads; replaying every
  // intermediate snapshot concurrently is both wasteful and the trigger for
  // Umami #4183's sessionData race. Keep only the newest queued identity.
  if (call.kind === 'identify') {
    for (let index = pendingUmamiCalls.length - 1; index >= 0; index -= 1) {
      if (pendingUmamiCalls[index]?.kind === 'identify') {
        pendingUmamiCalls.splice(index, 1);
      }
    }
  }
  if (pendingUmamiCalls.length >= UMAMI_QUEUE_LIMIT) {
    pendingUmamiCalls.shift();
  }
  pendingUmamiCalls.push(call);
}

function clearScheduledIdentityRetry(): void {
  if (identifyRetryTimer !== null) {
    clearTimeout(identifyRetryTimer);
    identifyRetryTimer = null;
  }
}

function createIdentifyCall(data: Record<string, unknown>): QueuedUmamiCall {
  latestIdentityRevision += 1;
  clearScheduledIdentityRetry();
  return {
    kind: 'identify',
    data,
    revision: latestIdentityRevision,
    retryAttempt: 0,
  };
}

function scheduleIdentityRetry(call: IdentifyCall): void {
  if (call.revision !== latestIdentityRevision) return;
  if (call.retryAttempt >= UMAMI_IDENTIFY_RETRY_LIMIT) return;

  clearScheduledIdentityRetry();
  const generation = identifyDeliveryGeneration;
  const retryCall = {
    ...call,
    retryAttempt: call.retryAttempt + 1,
  };
  const delay = UMAMI_IDENTIFY_RETRY_BASE_DELAY_MS * (2 ** call.retryAttempt);
  identifyRetryTimer = setTimeout(() => {
    identifyRetryTimer = null;
    if (generation !== identifyDeliveryGeneration) return;
    if (retryCall.revision !== latestIdentityRevision) return;
    if (!sendUmamiCall(retryCall)) {
      queueUmamiCall(retryCall);
    }
  }, delay);
}

/**
 * Umami v3.1.0 swallows its own fetch and JSON failures, including HTTP 500s,
 * so its public tracker promises do not tell us whether the collector accepted
 * a write. The installed transport gate reports the real outcome of the beacon
 * the tracker issues; `observeCollectorDelivery` attributes that outcome to
 * this call WITHOUT wrapping `window.fetch` a second time.
 *
 * `observed: false` means no collector write was attributed — the gate is not
 * installed, or the tracker deferred its beacon past the synchronous window.
 * That is an ABSENCE of signal, never a success.
 */
function invokeWithDelivery(
  invoke: () => unknown,
  requestType: 'event' | 'identify',
): { observed: boolean; result: unknown } {
  return observeCollectorDelivery(invoke, requestType);
}

function finishIdentityDelivery(call: IdentifyCall, generation: number, error?: unknown): void {
  if (generation !== identifyDeliveryGeneration) return;

  identifyInFlight = false;
  const nextCall = pendingIdentityCall;
  pendingIdentityCall = null;
  if (nextCall) {
    if (!sendUmamiCall(nextCall)) {
      queueUmamiCall(nextCall);
    }
    return;
  }
  // Identity is an idempotent latest-snapshot write, so it uses the broader
  // retry policy that still covers HTTP 500 — the failure #5715 was opened for.
  // The narrow conversion policy (which excludes 500) exists to avoid
  // double-counting an append-only event and does not apply here.
  if (error && isRetryableIdentityFailure(collectorFailureFromError(error))) {
    scheduleIdentityRetry(call);
  }
}

function sendIdentityCall(
  call: IdentifyCall,
  umami: NonNullable<Window['umami']>,
): boolean {
  // Umami stores each identity field independently with an update-then-create
  // sequence. Keep a single collector write active and retain only the latest
  // snapshot received during that write so auth and billing cannot race the
  // same sessionData key.
  if (identifyInFlight) {
    pendingIdentityCall = call;
    return true;
  }

  identifyInFlight = true;
  const generation = identifyDeliveryGeneration;
  try {
    const { result } = invokeWithDelivery(() => umami.identify(call.data), 'identify');
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).then(
        () => finishIdentityDelivery(call, generation),
        (error) => finishIdentityDelivery(call, generation, error),
      );
    } else {
      finishIdentityDelivery(call, generation);
    }
  } catch (error) {
    finishIdentityDelivery(call, generation, error);
  }
  return true;
}

function scheduleTrackRetry(call: Extract<QueuedUmamiCall, { kind: 'track' }>, error: unknown): void {
  const failure = collectorFailureFromError(error);
  if (!isRetryableCollectorFailure(failure)) return;
  const retryAttempt = call.retryAttempt ?? 0;
  if (retryAttempt >= UMAMI_TRACK_RETRY_LIMIT) return;

  const generation = trackRetryGeneration;
  const retryCall = { ...call, retryAttempt: retryAttempt + 1 };
  const delay = UMAMI_IDENTIFY_RETRY_BASE_DELAY_MS * (2 ** retryAttempt);
  setTimeout(() => {
    if (generation !== trackRetryGeneration) return;
    if (!sendUmamiCall(retryCall)) queueUmamiCall(retryCall);
  }, delay);
}

/**
 * Fallback for when no delivery signal exists for a critical event — the gate
 * could not be installed (non-writable `window.fetch`), or a test double /
 * alternate tracker issued no observable beacon. Without this the durable
 * marker would never clear and the conversion would replay on every reload for
 * the life of the tab.
 *
 * This deliberately preserves the pre-gate contract rather than claiming a
 * richer one: #4934 round-6's rule that only a REPLAYED checkout-start clears
 * the /pro handoff still holds here.
 */
function clearUnobservableCriticalMarker(call: Extract<QueuedUmamiCall, { kind: 'track' }>): void {
  if (call.event === 'checkout-success') clearPendingCheckoutSuccessMarker();
  if (call.event === 'checkout-start' && call.data?.replayed === true) {
    noteProFunnelReplayDelivered();
  }
}

function sendUmamiCall(call: QueuedUmamiCall): boolean {
  if (typeof window === 'undefined') return false;
  const umami = window.umami;
  if (!umami) return false;
  installCollectorFetchGate();
  if (call.kind === 'identify') {
    return sendIdentityCall(call, umami);
  }
  try {
    const critical = CRITICAL_TRACK_EVENTS.has(call.event);
    if (!critical) {
      const result: unknown = umami.track(call.event, call.data);
      if (result && typeof (result as { catch?: unknown }).catch === 'function') {
        void (result as Promise<unknown>).catch(() => {});
      }
      return true;
    }

    const { observed, result } = invokeWithDelivery(
      () => umami.track(call.event, call.data),
      'event',
    );
    if (observed) {
      // The gate owns marker clearing for observed writes (handleCollectorOutcome).
      void Promise.resolve(result).then(
        () => {},
        (error) => scheduleTrackRetry(call, error),
      );
      return true;
    }

    // No delivery signal for a critical event. Drain any tracker promise so it
    // cannot surface as an unhandled rejection, then fall back.
    if (result && typeof (result as { catch?: unknown }).catch === 'function') {
      void (result as Promise<unknown>).catch(() => {});
    }
    clearUnobservableCriticalMarker(call);
    return true;
  } catch {
    return false;
  }
}

function flushPendingUmamiCalls(): void {
  if (pendingUmamiCalls.length === 0) return;
  if (typeof window === 'undefined' || !window.umami) return;
  installCollectorFetchGate();
  const calls = pendingUmamiCalls.splice(0, pendingUmamiCalls.length);
  for (const call of calls) sendUmamiCall(call);
}

function loadUmamiScript(): void {
  if (umamiLoadStarted || typeof document === 'undefined') return;
  installCollectorFetchGate();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${UMAMI_SCRIPT_SRC}"]`);
  if (existing) {
    // A script tag already exists (e.g. re-entry after a soft navigation).
    // Mark load as started so the guard above short-circuits future calls.
    // If Umami already initialised, flush now; otherwise wait for its load
    // event. Flushing unconditionally before window.umami is set is a no-op
    // and a dead {once:true} listener if load already fired.
    umamiLoadStarted = true;
    if (typeof window !== 'undefined' && window.umami) {
      flushPendingUmamiCalls();
    } else {
      existing.addEventListener('load', flushPendingUmamiCalls, { once: true });
    }
    return;
  }

  umamiLoadStarted = true;
  umamiLoadAttempts += 1;
  const script = document.createElement('script');
  script.async = true;
  script.src = UMAMI_SCRIPT_SRC;
  script.dataset.websiteId = UMAMI_WEBSITE_ID;
  script.dataset.domains = UMAMI_DOMAINS;
  script.addEventListener('load', flushPendingUmamiCalls, { once: true });
  script.addEventListener('error', () => {
    umamiLoadStarted = false;
    script.remove();
    if (umamiLoadAttempts < UMAMI_LOAD_ATTEMPT_LIMIT) {
      setTimeout(loadUmamiScript, UMAMI_LOAD_RETRY_DELAY_MS);
    }
  }, { once: true });
  document.head.appendChild(script);
}

/** Type-safe Umami wrapper. Safe to call even if the script hasn't loaded. */
export function track(event: UmamiEvent, data?: Record<string, unknown>): void {
  const enrichedData = withContentAttribution(data, getContentAttributionForAnalytics());
  if (!sendUmamiCall({ kind: 'track', event, data: enrichedData })) {
    queueUmamiCall({ kind: 'track', event, data: enrichedData });
  }
}

/** Fire once for a freshly captured content landing, not on every reload. */
export function trackContentHandoff(): void {
  const attribution = getContentAttributionForAnalytics();
  if (!attribution) return;
  track('content-handoff', getContentAttributionAnalyticsFields(attribution));
}

export function initAnalytics(): void {
  if (umamiLoadScheduled || typeof window === 'undefined' || typeof document === 'undefined') return;
  umamiLoadScheduled = true;
  scheduleAfterFirstPaint(loadUmamiScript, 3000);
}

// ---------------------------------------------------------------------------
// User identity — call after auth state resolves so Umami can segment events
// by user/plan. Safe to call before Umami script loads.
// ---------------------------------------------------------------------------

export function identifyUser(
  userId: string,
  plan: string,
  subStatus?: SubscriptionInfo['status'] | null,
  planKey?: string | null,
): void {
  const data = {
    userId,
    plan,
    ...(subStatus != null && { subStatus }),
    ...(planKey != null && { planKey }),
  };
  const call = createIdentifyCall(data);
  if (!sendUmamiCall(call)) {
    queueUmamiCall(call);
  }
}

export function clearIdentity(): void {
  const call = createIdentifyCall({});
  if (!sendUmamiCall(call)) {
    queueUmamiCall(call);
  }
}

let _unsubAuth: (() => void) | null = null;
let _unsubBilling: (() => void) | null = null;

// Cached latest values so either subscription firing can re-identify with full data
let _lastAuth: AuthSession | null = null;
let _lastSub: SubscriptionInfo | null = null;

function _syncIdentity(): void {
  const user = _lastAuth?.user;
  if (user) {
    identifyUser(user.id, user.role, _lastSub?.status ?? null, _lastSub?.planKey ?? null);
  } else {
    _lastSub = null;
    clearIdentity();
  }
}

/**
 * Call once after initAuthState() to keep Umami identity in sync with
 * the authenticated user and their subscription status.
 * Re-entrant safe: subsequent calls are no-ops.
 */
export function initAuthAnalytics(): void {
  if (_unsubAuth) return;

  _unsubAuth = subscribeAuthState((state) => {
    const prevUserId = _lastAuth?.user?.id ?? null;
    const nextUserId = state.user?.id ?? null;
    if (prevUserId !== nextUserId) {
      _lastSub = null;
      // Detect a genuine sign-UP (not a sign-in). Null→non-null id transition
      // plus a createdAt within FRESH_SIGNUP_WINDOW_MS of now means Clerk
      // just created this account. Firing trackSignUp on the button click
      // would conflate "opened the sign-up modal" with "completed the flow";
      // gating on createdAt freshness captures the successful-completion
      // signal we actually want to measure.
      //
      // Durable fire-once guard: `_lastAuth` resets to null on every page
      // load, so without a persisted marker the null→user transition looks
      // identical on the completion reload and on any reload within the
      // 60s freshness window. We'd re-fire trackSignUp on every tab
      // refresh until createdAt ages out, inflating the signup count.
      // sessionStorage scopes the marker to the browser tab — tight enough
      // that re-install / new session reliably re-counts, wide enough that
      // a reload mid-signup doesn't double-count.
      if (
        nextUserId !== null &&
        !hasTrackedSignupInSession(nextUserId) &&
        isLikelyFreshSignup(prevUserId, nextUserId, getClerkUserCreatedAt(), Date.now())
      ) {
        trackSignUp('clerk');
        markSignupTrackedInSession(nextUserId);
      }
    }
    _lastAuth = state;
    _syncIdentity();
  });

  _unsubBilling = onSubscriptionChange((sub) => {
    _lastSub = sub;
    _syncIdentity();
  });
}

/** Tear down auth + billing listeners. Symmetric with initAuthAnalytics(). */
export function destroyAuthAnalytics(): void {
  _unsubAuth?.();
  _unsubBilling?.();
  _unsubAuth = null;
  _unsubBilling = null;
  _lastAuth = null;
  _lastSub = null;
  clearIdentity();
}

// ---------------------------------------------------------------------------
// Auth events
// ---------------------------------------------------------------------------

export function trackSignIn(method: string): void {
  track('sign-in', { method });
}

export function trackSignUp(method: string): void {
  track('sign-up', { method });
}

export function trackAnalystControlAction(actionType: string, status: string, reason?: string): void {
  track('analyst-control-action', {
    actionType,
    status,
    ...(reason ? { reason } : {}),
  });
}

/**
 * Window during which a freshly-observed Clerk `createdAt` is treated
 * as "this user just signed up." 60s is conservative enough to survive
 * network jitter between Clerk's user.created and the client seeing
 * the auth-state transition, while staying tight enough to reject
 * returning-user sign-ins on accounts created weeks ago.
 */
export const FRESH_SIGNUP_WINDOW_MS = 60_000;

/**
 * Pure predicate: was the just-observed auth transition a fresh sign-up?
 *
 * Exported for testability. Do not read Date.now() or Clerk state from
 * inside this function — callers pass both, so tests can pin time and
 * user state.
 */
/**
 * Lower bound for clock skew. A createdAt earlier-than-now by up to
 * this amount is treated as "now" for freshness purposes — tolerates
 * client clocks that lag the server. Bigger negatives (createdAt
 * unrealistically far in the future) are rejected as malformed.
 */
const FRESH_SIGNUP_CLOCK_SKEW_MS = 5_000;

/**
 * localStorage-backed fire-once guard, keyed by user id. Originally used
 * sessionStorage but sessionStorage is per-TAB — a user who signs up and
 * then opens a second tab on the app within the 60s createdAt freshness
 * window would fire a second trackSignUp from that fresh tab's
 * `_lastAuth=null → user` transition. localStorage is shared across
 * tabs in the same browser profile, so once any tab marks the user as
 * tracked, no other tab for the same user will re-fire.
 *
 * Keyed per user id so account switches within the same browser still
 * correctly track each user's first signup (rare but valid). The key
 * never needs to be cleaned up because Clerk user ids are effectively
 * unique forever — a deleted user's key is harmless and the storage
 * footprint is trivial (one byte per user who ever signed up here).
 *
 * Read/write are try/catched because storage throws in private-mode /
 * quota-exceeded / disabled scenarios; we fail open (track, don't
 * persist) rather than swallow signups.
 */
const SIGNUP_TRACKED_KEY_PREFIX = 'wm-signup-tracked:';

export function hasTrackedSignupInSession(userId: string): boolean {
  try {
    return window.localStorage.getItem(SIGNUP_TRACKED_KEY_PREFIX + userId) === '1';
  } catch {
    return false;
  }
}

export function markSignupTrackedInSession(userId: string): void {
  try {
    window.localStorage.setItem(SIGNUP_TRACKED_KEY_PREFIX + userId, '1');
  } catch {
    // Storage unavailable — we'll just risk a single double-count on
    // reload instead of crashing analytics init.
  }
}

export function isLikelyFreshSignup(
  prevUserId: string | null,
  nextUserId: string | null,
  createdAtMs: number | null,
  nowMs: number,
): boolean {
  if (prevUserId !== null) return false;
  if (nextUserId === null) return false;
  if (createdAtMs === null) return false;
  const age = nowMs - createdAtMs;
  // Accept:   -5s  ≤ age ≤ 60s  (brief clock skew tolerance + fresh window)
  // Reject: < -5s (createdAt unrealistically far in the future — malformed)
  //         > 60s (returning user, not a fresh signup)
  return age >= -FRESH_SIGNUP_CLOCK_SKEW_MS && age <= FRESH_SIGNUP_WINDOW_MS;
}

export function trackSignOut(): void {
  track('sign-out');
}

/**
 * Test-only: reset module-level deferred-load state so each test starts from
 * a clean slate. The queue and load guards are module singletons that persist
 * across the shared module import in tests/secondary-startup.test.mts.
 */
export function resetAnalyticsForTesting(): void {
  resetCollectorTransportForTesting();
  clearScheduledIdentityRetry();
  identifyDeliveryGeneration += 1;
  trackRetryGeneration += 1;
  identifyInFlight = false;
  pendingIdentityCall = null;
  pendingUmamiCalls.length = 0;
  umamiLoadScheduled = false;
  umamiLoadStarted = false;
  umamiLoadAttempts = 0;
  latestIdentityRevision = 0;
  proFunnelReplaysAwaitingDelivery = 0;
}

export function trackGateHit(feature: string): void {
  track('gate-hit', { feature });
}

// ---------------------------------------------------------------------------
// Conversion funnel (#4931)
// ---------------------------------------------------------------------------

/**
 * Closed product-id vocabulary for analytics (#4934 round-4 F2): the
 * dashboard resume path replays a productId that originally travelled
 * through URL/sessionStorage, so a crafted value must not inject unbounded
 * cardinality into Umami. Unknown ids collapse to 'unknown'; the checkout
 * flow itself still passes the raw id through (backend validates).
 * Auto-fresh: DODO_PRODUCT_IDS is generated from the catalog. Keeping this
 * small allowlist separate means analytics does not pull the checkout config
 * into the post-hydration module graph. (#5165)
 */
const KNOWN_PRODUCT_IDS = DODO_PRODUCT_IDS;

export function bucketProductIdForAnalytics(productId: string): string {
  return KNOWN_PRODUCT_IDS.has(productId) ? productId : 'unknown';
}

/**
 * Fired when a checkout is initiated from the dashboard (any locked-panel
 * CTA, settings upgrade card, banner, etc. — all route through
 * `startCheckout`). `authed: false` marks intent clicks from signed-out
 * users that detour through sign-in before a Dodo session exists;
 * `surface: 'dashboard-resume'` marks the post-sign-in auto-resume
 * re-entry so a signed-out conversion (two events: dashboard/authed:false,
 * then dashboard-resume/authed:true) isn't double-counted as two attempts.
 * The /pro page mirrors this with 'pro-page' / 'pro-resume'.
 */
/**
 * Durable marker for the dashboard conversion events that are NOT covered by
 * the /pro handoff marker.
 *
 * `startCheckout` calls trackCheckoutStart and then immediately
 * `window.location.assign(hostedCheckoutUrl)`, so a bounded in-page retry is
 * destroyed by the very redirect it needs to survive. checkout-failed has the
 * same exposure on a navigation. Entries are dropped once the collector
 * confirms the write, and replayed on the next boot otherwise.
 */
const CONVERSION_PENDING_KEY = 'wm-conversion-pending';
const CONVERSION_PENDING_LIMIT = 5;

type PendingConversion = {
  event: 'checkout-start' | 'checkout-failed';
  data: Record<string, unknown>;
};

function readPendingConversions(): PendingConversion[] {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(CONVERSION_PENDING_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is PendingConversion => {
      if (!item || typeof item !== 'object') return false;
      const { event, data } = item as { event?: unknown; data?: unknown };
      return (event === 'checkout-start' || event === 'checkout-failed')
        && Boolean(data) && typeof data === 'object';
    }).slice(0, CONVERSION_PENDING_LIMIT);
  } catch {
    return [];
  }
}

function writePendingConversions(items: PendingConversion[]): void {
  try {
    if (items.length === 0) window.sessionStorage.removeItem(CONVERSION_PENDING_KEY);
    else window.sessionStorage.setItem(CONVERSION_PENDING_KEY, JSON.stringify(items));
  } catch {
    // Storage denied — fall back to fire-and-hope, matching every other event.
  }
}

function rememberPendingConversion(event: PendingConversion['event'], data: Record<string, unknown>): void {
  const items = readPendingConversions();
  items.push({ event, data });
  writePendingConversions(items.slice(-CONVERSION_PENDING_LIMIT));
}

/** Drop one stored entry for this event once the collector confirms it. */
function forgetPendingConversion(event: PendingConversion['event']): void {
  const items = readPendingConversions();
  const index = items.findIndex((item) => item.event === event);
  if (index < 0) return;
  items.splice(index, 1);
  writePendingConversions(items);
}

/**
 * Re-queue dashboard conversion events whose delivery was cut off by the Dodo
 * redirect. Entries stay durable until the collector confirms them, so this is
 * a no-op on ordinary boots.
 */
export function replayPendingConversionEvents(): void {
  for (const item of readPendingConversions()) {
    track(item.event, { ...item.data, replayed: true });
  }
}

export function trackCheckoutStart(
  productId: string,
  authed: boolean,
  surface: 'dashboard' | 'dashboard-resume' = 'dashboard',
): void {
  const data = { productId: bucketProductIdForAnalytics(productId), surface, authed };
  rememberPendingConversion('checkout-start', data);
  track('checkout-start', data);
}

/**
 * The one funnel event that races a reload: checkout-success is tracked on
 * the post-checkout dashboard load, but the entitlement watcher reloads the
 * page the moment Pro lands — often before the deferred Umami queue flushes
 * (#4934 round-2 F2). A sessionStorage marker written at track time and
 * cleared only on actual delivery (see sendUmamiCall) lets the next boot
 * replay the event instead of dropping it. sessionStorage is per-tab, so
 * the replay can't leak across tabs or users.
 */
const CHECKOUT_SUCCESS_PENDING_KEY = 'wm-checkout-success-pending';

function clearPendingCheckoutSuccessMarker(): void {
  try {
    window.sessionStorage.removeItem(CHECKOUT_SUCCESS_PENDING_KEY);
  } catch {
    // Storage unavailable — replay just won't be possible, same as before.
  }
}

/**
 * Fired on the dashboard when a checkout return reconciles as success.
 * `source` distinguishes the full-page return-URL path from the legacy
 * overlay session-flag path (see panel-layout.ts checkout-return wiring).
 */
export function trackCheckoutSuccess(source: 'url-return' | 'overlay-flag'): void {
  try {
    window.sessionStorage.setItem(CHECKOUT_SUCCESS_PENDING_KEY, source);
  } catch {
    // Storage denied — fall back to fire-and-hope, matching every other event.
  }
  track('checkout-success', { source });
}

/**
 * Re-queue a checkout-success whose delivery was cut off by the entitlement
 * reload. Called on every non-checkout-return boot (panel-layout); a no-op
 * unless the durable marker survived. Deliberately does NOT rewrite the
 * marker: it stays until sendUmamiCall confirms delivery, so repeated
 * reloads keep replaying rather than dropping.
 */
export function replayPendingCheckoutSuccess(): void {
  let source: string | null = null;
  try {
    source = window.sessionStorage.getItem(CHECKOUT_SUCCESS_PENDING_KEY);
  } catch {
    return;
  }
  if (!source) return;
  track('checkout-success', { source, replayed: true });
}

/**
 * Replay /pro checkout-start events that died with the redirect (#4934
 * round-5): the /pro page mirrors undelivered checkout-start events into
 * sessionStorage (see pro-test/src/services/checkout.ts) because the fast
 * signed-in/resume path top-level-redirects to Dodo before its flush poll
 * runs. The buyer returns to the dashboard in the same tab, so this boot
 * hook replays them here. Every field is re-validated against closed
 * vocabularies — sessionStorage is tab-local but still client-writable,
 * and replayed junk must not become analytics cardinality.
 *
 * Delivery contract (round-6): the marker is NOT cleared here. Replays
 * enter the deferred queue, and the entitlement watcher can reload the
 * page before it flushes — clearing at read time would drop the event
 * permanently in exactly the race round-2 fixed for checkout-success.
 * Instead the key is REWRITTEN with only the sanitized survivors (so
 * junk can't loop forever) and removed in sendUmamiCall once a replayed
 * event actually reaches the tracker.
 */
const PRO_FUNNEL_PENDING_KEY = 'wm-pro-funnel-pending';

function clearPendingProFunnelMarker(): void {
  proFunnelReplaysAwaitingDelivery = 0;
  try {
    window.sessionStorage.removeItem(PRO_FUNNEL_PENDING_KEY);
  } catch {
    // Storage unavailable — worst case is a duplicate replayed:true event
    // on the next boot, the side we deliberately err on.
  }
}

/**
 * How many replayed checkout-start events from the current batch have not yet
 * been confirmed by the collector.
 *
 * Before the write gate existed, all replays flushed in one synchronous loop,
 * so clearing the marker on the first delivery was safe. Writes are now
 * serialized: only replay #1 is in flight when it lands, and #2..n are still
 * queued. Clearing on the first receipt would drop the remainder on a reload,
 * so the marker shrinks to the undelivered tail instead and clears only when
 * the batch is fully acknowledged.
 */
let proFunnelReplaysAwaitingDelivery = 0;

function noteProFunnelReplayDelivered(): void {
  if (proFunnelReplaysAwaitingDelivery <= 0) {
    clearPendingProFunnelMarker();
    return;
  }
  proFunnelReplaysAwaitingDelivery -= 1;
  if (proFunnelReplaysAwaitingDelivery === 0) {
    clearPendingProFunnelMarker();
    return;
  }
  try {
    const raw = window.sessionStorage.getItem(PRO_FUNNEL_PENDING_KEY);
    if (!raw) return;
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items)) return;
    window.sessionStorage.setItem(
      PRO_FUNNEL_PENDING_KEY,
      JSON.stringify(items.slice(items.length - proFunnelReplaysAwaitingDelivery)),
    );
  } catch {
    // Rewrite failed — the full batch stays durable, so the worst case is a
    // duplicate replay next boot rather than a dropped one.
  }
}

export function replayPendingProFunnelEvents(): void {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(PRO_FUNNEL_PENDING_KEY);
  } catch {
    return;
  }
  if (!raw) return;

  const sanitized: Array<{ productId: string; surface: 'pro-page' | 'pro-resume'; authed: boolean }> = [];
  try {
    const items: unknown = JSON.parse(raw);
    if (Array.isArray(items)) {
      for (const item of items.slice(0, 10)) {
        if (!item || typeof item !== 'object') continue;
        const { event, data } = item as { event?: unknown; data?: unknown };
        if (event !== 'checkout-start' || !data || typeof data !== 'object') continue;
        const d = data as Record<string, unknown>;
        sanitized.push({
          productId: bucketProductIdForAnalytics(String(d.productId ?? '')),
          surface: d.surface === 'pro-resume' ? 'pro-resume' : 'pro-page',
          authed: Boolean(d.authed),
        });
      }
    }
  } catch {
    // Malformed JSON — nothing replayable.
  }

  if (sanitized.length === 0) {
    clearPendingProFunnelMarker();
    return;
  }

  // Persist the sanitized survivors so a pre-delivery reload retries
  // exactly these (bounded, closed-vocabulary), then queue the replays.
  try {
    window.sessionStorage.setItem(
      PRO_FUNNEL_PENDING_KEY,
      JSON.stringify(sanitized.map((data) => ({ event: 'checkout-start', data }))),
    );
  } catch {
    // Rewrite failed — the original payload stays; sanitization re-runs
    // on the next boot. Still safe to queue this boot's replays.
  }
  proFunnelReplaysAwaitingDelivery = sanitized.length;
  for (const data of sanitized) {
    track('checkout-start', { ...data, replayed: true });
  }
}

/**
 * Closed status vocabulary for checkout-failed (#4934 round-2 F3). The raw
 * value is URL-derived (Dodo return params — and checkout-return.ts:117
 * forwards ANY unknown status when Dodo ID params are present), so a
 * crafted or novel URL must not inject unbounded cardinality into
 * analytics. Unknowns collapse to 'other'.
 */
const CHECKOUT_FAILED_STATUSES = new Set(['failed', 'declined', 'cancelled', 'canceled']);

/** Fired when a checkout return reconciles as failed/declined/cancelled. */
export function trackCheckoutFailed(rawStatus: string): void {
  const status = CHECKOUT_FAILED_STATUSES.has(rawStatus) ? rawStatus : 'other';
  rememberPendingConversion('checkout-failed', { status });
  track('checkout-failed', { status });
}

const API_ACTIONS = ['key-created', 'key-revoked'] as const;
export type ApiActionName = (typeof API_ACTIONS)[number];

/** Track a successful, bounded API product action without leaking key data. */
export function trackApiAction(action: ApiActionName): void {
  if (!API_ACTIONS.includes(action)) return;
  track('api-action', { action });
}

// ---------------------------------------------------------------------------
// Pro Activation Onboarding funnel (#4771)
// ---------------------------------------------------------------------------

/** The activation funnel events — the leaf's ACTIVATION_EVENTS is the naming source. */
export type ProActivationEvent = ActivationEventName;

/**
 * The ONLY fields allowed on an activation event payload. Deliberately narrow:
 * the plan tier, the step id (step events), and the aggregate exit counts
 * (exit event). NEVER the subscription id or any billing identifier — cohort
 * joins key on the userId Umami already receives via identifyUser(). Mirrors
 * the closed-vocabulary minimization of bucketProductIdForAnalytics above.
 */
export interface ProActivationEventFields {
  planKey?: string | null;
  step?: ActivationStepId;
  completion?: 'complete' | 'partial' | 'none';
  verified?: number;
  pending?: number;
  failed?: number;
  total?: number;
}

/**
 * Track a Pro-activation funnel event with a minimized payload. Every field is
 * whitelisted here, so a caller cannot widen the payload into billing identity:
 * only planKey / step / the aggregate exit counts ever reach Umami.
 */
export function trackProActivation(
  event: ProActivationEvent,
  fields: ProActivationEventFields = {},
): void {
  const data: Record<string, unknown> = {};
  if (fields.planKey != null) data.planKey = fields.planKey;
  if (fields.step != null) data.step = fields.step;
  if (fields.completion != null) data.completion = fields.completion;
  if (fields.verified != null) data.verified = fields.verified;
  if (fields.pending != null) data.pending = fields.pending;
  if (fields.failed != null) data.failed = fields.failed;
  if (fields.total != null) data.total = fields.total;
  track(event, data);
}

// ---------------------------------------------------------------------------
// Generic (kept as no-ops — too noisy / not useful in Umami)
// ---------------------------------------------------------------------------

export function trackEvent(_name: string, _props?: Record<string, unknown>): void {}
export function trackEventBeforeUnload(_name: string, _props?: Record<string, unknown>): void {}
export function trackPanelView(_panelId: string): void {}
export function trackApiKeysSnapshot(): void {}
export function trackUpdateShown(_current: string, _remote: string): void {}
export function trackUpdateClicked(_version: string): void {}
export function trackUpdateDismissed(_version: string): void {}
export function trackDownloadBannerDismissed(): void {}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function trackSearchUsed(queryLength: number, resultCount: number): void {
  track('search-used', { queryLength, resultCount });
}

export function trackSearchResultSelected(resultType: string): void {
  track('search-result-selected', { type: resultType });
}

// ---------------------------------------------------------------------------
// Country / map
// ---------------------------------------------------------------------------

export function trackCountrySelected(code: string, name: string, source: string): void {
  track('country-selected', { code, name, source });
}

export function trackCountryBriefOpened(countryCode: string): void {
  track('country-brief-opened', { code: countryCode });
}

// ---------------------------------------------------------------------------
// Brief thread-open (followed-countries plan, U11)
// ---------------------------------------------------------------------------

export type BriefThreadOpenSeverity =
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'
  | 'info'
  | null;

export interface BriefThreadOpenProps {
  /** ISO-2 country code, or null when no primary country attaches. */
  country: string | null;
  /** True iff the user follows `country` at click time. */
  followed: boolean;
  severity: BriefThreadOpenSeverity;
  /** Where the click originated. */
  source: 'dashboard' | 'magazine';
}

/**
 * Fire-and-forget: `track` short-circuits when Umami hasn't loaded.
 * Wrap call sites in try/catch anyway so a future regression in
 * `track` (e.g. throwing identify) cannot break navigation UX.
 */
export function trackBriefThreadOpen(props: BriefThreadOpenProps): void {
  track('brief-thread-open', {
    country: props.country,
    followed: props.followed,
    severity: props.severity,
    source: props.source,
  });
}

export function trackMapLayerToggle(layerId: string, enabled: boolean, source: 'user' | 'programmatic'): void {
  if (source !== 'user') return;
  track('map-layer-toggle', { layerId, enabled });
}

export function trackMapViewChange(_view: string): void {
  // No-op: low analytical value.
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export function trackPanelToggled(panelId: string, enabled: boolean): void {
  track('panel-toggle', { panelId, enabled });
}

export function trackPanelResized(_panelId: string, _newSpan: number): void {
  // No-op: fires on every drag step, too noisy for analytics.
}

// ---------------------------------------------------------------------------
// App-wide settings
// ---------------------------------------------------------------------------

export function trackVariantSwitch(from: string, to: string): void {
  track('variant-switch', { from, to });
}

export function trackThemeChanged(theme: string): void {
  track('theme-changed', { theme });
}

export function trackLanguageChange(language: string): void {
  track('language-change', { language });
}

export function trackFeatureToggle(featureId: string, enabled: boolean): void {
  track('feature-toggle', { featureId, enabled });
}

// ---------------------------------------------------------------------------
// AI / LLM
// ---------------------------------------------------------------------------

export function trackLLMUsage(_provider: string, _model: string, _cached: boolean): void {
  // No-op: per-request noise, not a meaningful user action for analytics.
}

export function trackLLMFailure(_lastProvider: string): void {
  // No-op: per-request noise, not a meaningful user action for analytics.
}

// ---------------------------------------------------------------------------
// Webcams
// ---------------------------------------------------------------------------

export function trackWebcamSelected(webcamId: string, city: string, viewMode: string): void {
  track('webcam-selected', { webcamId, city, viewMode });
}

export function trackWebcamRegionFiltered(region: string): void {
  track('webcam-region-filter', { region });
}

// ---------------------------------------------------------------------------
// Downloads / banners / findings
// ---------------------------------------------------------------------------

export function trackDownloadClicked(platform: string): void {
  track('download-clicked', { platform });
}

export function trackCriticalBannerAction(action: string, theaterId: string): void {
  track('critical-banner', { action, theaterId });
}

export function trackFindingClicked(_id: string, _source: string, _type: string, _priority: string): void {
  // No-op: niche feature, low analytical value.
}

export function trackDeeplinkOpened(_type: string, _target: string): void {
  // No-op: not useful for analytics.
}
