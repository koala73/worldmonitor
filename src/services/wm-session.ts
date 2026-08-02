// Client-side helper for the anonymous-browser session cookie (issue #3541).
//
// The server's validateApiKey() (api/_api-key.js) no longer trusts header-only
// signals like Origin / Referer / Sec-Fetch-Site to authorize key-less browser
// access — every header is forgeable by curl. Anonymous browsers now mint a
// short-lived HMAC-signed token via POST /api/wm-session. The token is stored
// by the server in an HttpOnly cookie; JavaScript only tracks the expiry.
//
// Two pieces:
//   1. ensureWmSession() — asks the server to mint/refresh the HttpOnly cookie.
//   2. installWmSessionFetchInterceptor() — patch globalThis.fetch ONCE so
//      every call to our API origin includes credentials. Avoids touching
//      ~50 fetch sites individually.

import { getCanonicalApiOrigin, toApiUrl } from './runtime';
import { PREMIUM_RPC_PATHS } from '@/shared/premium-paths';
import { hasPremiumIntent } from './premium-intent';
import { isPublicSharedRpcRequest } from '@/shared/public-rpc-cache';
import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import { PUBLIC_WEATHER_BOOTSTRAP_KEY, bootstrapTierKeyNames } from '../../shared/bootstrap-tier-keys.js';

const STORAGE_KEY = 'wm-session-exp';
// Refresh well before expiry so a half-loaded page doesn't fail mid-flight.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Abort a session mint that stalls. Without this, a hung /api/wm-session response
// strands every concurrent caller on the shared `inflight` promise forever.
let fetchNewSessionTimeoutMs = 10_000;
// Periodic refresh cadence — wake every 30 minutes to renew before the
// 12-hour token expires. Long-lived tabs (overnight, multi-day) lose the
// token without this; the original implementation had no auto-refresh.
const PERIODIC_REFRESH_MS = 30 * 60 * 1000;
// A rejected retry means the browser cannot currently deliver the HttpOnly
// cookie (for example, strict cookie settings). Avoid amplifying that into a
// request + mint + retry loop for every panel refresh.
const SESSION_DEAD_COOLDOWN_MS = 15 * 60 * 1000;
// A single endpoint that still 401s after a fresh mint proves nothing about
// the session cookie (#5674). Server telemetry for the regrown WORLDMONITOR-WG
// episodes showed 11 of 12 sampled affected browsers emitting ZERO server-side
// 401s across the whole episode — sibling routes on the same tab returned 200
// in the very same second the client declared the session dead. Treating one
// route's denial as proof of a dead cookie is what turns a single endpoint
// problem into a 15-minute blackout of every anonymous panel.
//
// Require corroboration from this many DISTINCT routes before suppressing all
// anonymous traffic. The failure mode #5219/#5251 originally targeted — the
// browser cannot deliver the HttpOnly cookie at all — makes EVERY route 401,
// so it still reaches the quorum and still engages the global cooldown.
const SESSION_DEAD_ROUTE_QUORUM = 2;
// How close together those distinct denials must fall to count as ONE
// session-wide failure. This is deliberately NOT SESSION_DEAD_COOLDOWN_MS: the
// evidence that justifies a blackout is temporal coincidence (the sampled
// episodes showed siblings returning 200 in the very same second), so a horizon
// three orders of magnitude wider would let two unrelated endpoint bugs 14
// minutes apart black out a demonstrably healthy session — the exact harm this
// mechanism exists to remove. The per-route suppression window below stays at
// SESSION_DEAD_COOLDOWN_MS; only the corroboration arithmetic uses this.
const SESSION_DEAD_CORROBORATION_MS = 60 * 1000;
// How long one route stays suppressed after rejecting a fresh cookie. Equal to
// the global cooldown today, but named separately because it answers a different
// question ("how long to stop paying mints for this endpoint" vs "how long to
// blank the whole surface") — tuning one must not silently retune the other.
const SESSION_DEAD_ROUTE_STRIKE_TTL_MS = SESSION_DEAD_COOLDOWN_MS;
// Every logical key that `/api/bootstrap?keys=<name>&public=1` serves without
// credentials: the on-demand tier plus weatherAlerts, which rides the fast tier
// but has its own public URL (#5386). A credential-less read of one of these is
// public by contract, so a denial there is NOT evidence the anonymous session
// cookie is dead and must not trigger session recovery.
const PUBLIC_SINGLE_KEY_BOOTSTRAP_KEYS = new Set([
  ...bootstrapTierKeyNames('on-demand'),
  PUBLIC_WEATHER_BOOTSTRAP_KEY,
]);
export const WM_SESSION_DEGRADED_EVENT = 'wm-session-degraded';

type WmSessionDeadReason = 'mint_failed' | 'retry_401' | 'cookie_not_persisted';

// Whether a mint in THIS page session has already handed the browser a cookie.
// The next mint must arrive carrying it — `/api/wm-session` reports that as
// `hadSession`. A first-ever mint legitimately carries none, so the flag is
// what separates "new visitor" from "browser is dropping our cookie."
let cookieIssuedThisSession = false;
// Latched once a mint proves the browser did not keep the previous cookie.
let cookiePersistenceBroken = false;
// Anonymous-only fallback for clients that reject the shared-domain HttpOnly
// cookie. Kept in memory (never local/session storage) and activated only
// after the server proves a prior cookie did not make the round trip.
let anonymousSessionHeaderToken: string | null = null;
let useAnonymousSessionHeader = false;

interface StoredSession {
  exp: number;
}

let cached: StoredSession | null = null;
let inflight: Promise<boolean> | null = null;
let recoveryInFlight: Promise<Response | null> | null = null;
let sessionGeneration = 0;
let sessionIdentityGeneration = 0;
let interceptorInstalled = false;
let nativeSessionFetch: typeof fetch | null = null;
let sessionDeadUntil = 0;
let sessionDeadReason: WmSessionDeadReason | null = null;
let sentryEnqueue: typeof enqueueSentryCall = enqueueSentryCall;
// Two pieces of state with deliberately different lifetimes. Collapsing them
// into one map conflates "stop spending mints on this endpoint" with "the whole
// session looks broken", and those need opposite clearing rules: a sibling's 200
// must NOT release the mint guard (that reopens the #5219 request+mint+retry
// loop — a broken route re-polled every 30s would remint every 30s), but it MUST
// void the session-wide evidence.
//
// 1. Suppression — raw pathname -> moment the strike lapses. Keyed by the RAW
//    path because one id of a dynamic route being denied says nothing about its
//    siblings. Cleared only by expiry, by its own route succeeding, by the
//    global cooldown, or by a key-bound session replacing the identity.
const routeStrikes = new Map<string, number>();
// 2. Corroboration evidence — bounded route TAG -> when it failed. Keyed by the
//    TAG so two ids of one dynamic endpoint cannot masquerade as two
//    independent routes and fake a quorum. Any successful credentialed response
//    clears it: a 200 proves the cookie is being delivered, which is precisely
//    the counter-evidence the #5674 diagnosis rested on.
const recentRouteFailures = new Map<string, number>();

// Sentry tags must stay low-cardinality. Interceptor traffic only ever targets
// our own /api/ surface, but dynamic segments (`/api/v2/shipping/webhooks/
// <subscriberId>`) and the catch-all not-found route can still carry
// caller-controlled values, so collapse anything id-shaped before tagging.
const MAX_ROUTE_TAG_SEGMENTS = 8;
const MAX_ROUTE_TAG_LENGTH = 96;
// Per-segment cap, sized against the REAL route table rather than guessed. Of
// the 198 registered routes, the longest final segment is
// `get-china-corridor-control-towers` at 33 chars, with
// `get-consumer-price-basket-series` right behind at exactly 32 — so the
// original 32 collapsed a live panel route (ChinaCorridorPanel) to
// `/api/supply-chain/v1/:id` and left the next long route name one character
// from doing the same. The headroom here is the point; the id-shape rules below,
// not this length, are what actually catch identifiers.
const MAX_ROUTE_TAG_SEGMENT_LENGTH = 48;

/**
 * Reduce a request pathname to a bounded, aggregable Sentry tag value.
 * Exported for direct unit coverage — the cardinality guarantee is the whole
 * point of the tag, and it is not observable from the interceptor's outside.
 */
export function toRouteTag(pathname: string): string {
  if (!pathname.startsWith('/api/')) return 'other';
  const segments = pathname.split('/').filter(Boolean).slice(0, MAX_ROUTE_TAG_SEGMENTS);
  const safe = segments.map((segment) => {
    // `v1`/`v2` are real, fixed route segments.
    if (/^v\d+$/.test(segment)) return segment;
    if (segment.length > MAX_ROUTE_TAG_SEGMENT_LENGTH || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(segment)) return ':id';
    // Classify on identifier SHAPE, not on merely containing a digit. Real RPC
    // method names embed small numbers (`get-co2-monitoring`, `get-pm25-*`,
    // `get-g20-*`) and collapsing those to `:id` would destroy the one thing
    // this tag exists to deliver — naming the offending endpoint (#5674 AC#1) —
    // while looking indistinguishable from a genuinely dynamic route family.
    // An identifier instead has a word that STARTS with a digit (`8f2a11`,
    // `2026`, `9d4c7b2e`) or a long letter+digit run (uuid/hash chunks).
    const words = segment.split(/[-._]/);
    if (words.some((word) => /^\d/.test(word) || (word.length >= 6 && /\d/.test(word)))) return ':id';
    return segment;
  });
  return `/${safe.join('/')}`.slice(0, MAX_ROUTE_TAG_LENGTH);
}

export function isWmSessionDead(): boolean {
  if (sessionDeadUntil <= Date.now()) {
    sessionDeadUntil = 0;
    sessionDeadReason = null;
    return false;
  }
  return true;
}

/**
 * Raw pathnames currently under per-route suppression.
 *
 * Per-route suppression is deliberately silent — no toast, no degraded event —
 * which makes "one panel is broken but the rest of the dashboard works" the one
 * state this module can enter with no local way to confirm it. Without this the
 * only diagnosis is a Sentry search for `kind: wm_session_route_401` scoped to
 * the user's IP inside the 15-minute window before the strike self-expires, so a
 * console-reachable reader is the difference between answering that question in
 * seconds and needing Sentry access plus exact timing. Mirrors
 * `isWmSessionDead()`; route paths are already client-visible strings.
 */
export function getStruckRoutes(): string[] {
  return [...routeStrikes.keys()].filter((rawPath) => isRouteStruck(rawPath));
}

/**
 * True when `rawPath` already failed a replay-with-a-fresh-cookie inside the
 * current window. Re-running recovery for it would re-derive the same denial
 * and spend another mint, which is the request+mint+retry amplification #5219
 * exists to prevent.
 */
function isRouteStruck(rawPath: string): boolean {
  const until = routeStrikes.get(rawPath);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  routeStrikes.delete(rawPath);
  return false;
}

/**
 * Record a failed fresh-mint replay for `rawPath`, and return how many DISTINCT
 * routes have failed inside the corroboration window — i.e. how much evidence
 * there is that the session itself (not this one endpoint) is broken.
 *
 * The two stores move on different clocks by design: suppression lasts
 * SESSION_DEAD_COOLDOWN_MS so a known-bad endpoint stops costing mints, while
 * the returned count only sees failures from the last
 * SESSION_DEAD_CORROBORATION_MS.
 */
function recordRouteStrike(rawPath: string): number {
  const now = Date.now();
  for (const [struck, until] of routeStrikes) {
    if (until <= now) routeStrikes.delete(struck);
  }
  routeStrikes.set(rawPath, now + SESSION_DEAD_ROUTE_STRIKE_TTL_MS);

  const corroborationFloor = now - SESSION_DEAD_CORROBORATION_MS;
  for (const [tag, at] of recentRouteFailures) {
    if (at <= corroborationFloor) recentRouteFailures.delete(tag);
  }
  recentRouteFailures.set(toRouteTag(rawPath), now);
  return recentRouteFailures.size;
}

/**
 * A credentialed request just succeeded, so the browser IS delivering the
 * session cookie. Retire the evidence that argued otherwise.
 *
 * Asymmetric on purpose: the succeeding route's own suppression is released
 * (it demonstrably works again, so letting it back into recovery costs nothing),
 * but a SIBLING's success must not release a struck route's suppression — that
 * would put the broken endpoint back through mint-on-every-poll, which is the
 * amplification #5219 exists to prevent. Session-wide evidence, by contrast, is
 * void the moment anything succeeds.
 */
function noteRouteSuccess(rawPath: string): void {
  routeStrikes.delete(rawPath);
  if (recentRouteFailures.size > 0) recentRouteFailures.clear();
  // A fresh-cookie success is stronger evidence than a two-route retry_401
  // quorum, including when that success was already in flight as the quorum
  // formed. Lift only retry-derived cooldowns here: mint_failed means the
  // session endpoint itself is unavailable and retains its immediate guard.
  //
  // cookie_not_persisted is lifted for the same reason and is even more
  // clear-cut: a credentialed route just succeeded, so the browser demonstrably
  // DID deliver the cookie. Clear the latch too, or the next mint would
  // immediately re-derive the verdict this success just disproved.
  if (sessionDeadReason === 'retry_401' || sessionDeadReason === 'cookie_not_persisted') {
    sessionDeadUntil = 0;
    sessionDeadReason = null;
  }
  cookiePersistenceBroken = false;
}

function addSessionBreadcrumb(message: string, data: Record<string, string>): void {
  // Sentry's automatic fetch instrumentation cannot see these requests: the
  // interceptor captured `window.fetch` before the deferred Sentry.init wrapped
  // it, so every retry it issues bypasses the SDK. The outer call DOES get a
  // breadcrumb, but only once its promise settles — which is after this
  // episode's captureMessage has already been sent. Without a manual crumb the
  // 401 is invisible in the event that exists to explain it (#5674).
  try {
    sentryEnqueue((s) => s.addBreadcrumb({
      category: 'wm-session',
      level: 'warning',
      message,
      data,
    }));
  } catch { /* best-effort telemetry */ }
}

function markWmSessionDead(reason: WmSessionDeadReason, rawPath: string): void {
  const alreadyDead = isWmSessionDead();
  sessionDeadUntil = Date.now() + SESSION_DEAD_COOLDOWN_MS;
  if (!alreadyDead) sessionDeadReason = reason;
  cached = null;
  // The global cooldown supersedes per-route suppression — every anonymous
  // call is already blocked, so keeping strikes alive past it would only make
  // the first post-cooldown failure trip the quorum on stale evidence.
  routeStrikes.clear();
  recentRouteFailures.clear();
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  if (alreadyDead) return;
  console.warn('[wm-session] refreshed HttpOnly session cookie was still rejected; suppressing anonymous API calls briefly');
  // One warning per degraded episode — reportServerError (premium-fetch.ts)
  // deliberately skips the synthetic X-Wm-Session-Degraded 503s, so this is
  // the only remote signal that anonymous browsing is degraded (#5245).
  //
  // The `route` tag (#5674) identifies which endpoint's retry 401'd. Without
  // it the capture carried only kind + reason, so a surviving
  // fresh-mint-then-401 path could not be aggregated and the offending
  // endpoint was undiagnosable from Sentry alone — the blocker that made
  // #5674 take a full production probe to find.
  //
  // Guarded: a telemetry throw must never skip the degraded-event dispatch
  // below, nor turn the interceptor's recovery return into a rejection.
  // `route` must name what actually failed, because the obvious use of this tag
  // is to group WORLDMONITOR-WG by it and read off the offending endpoint. For
  // retry_401 that is the replayed route. For mint_failed it is /api/wm-session:
  // the mint returned nothing usable, and whichever route happened to be in
  // flight is a bystander — tagging it would seed the census with innocent
  // endpoints under the same tag name that means "the denied route" elsewhere.
  // The bystander is still worth having, so it rides the breadcrumb instead.
  const blockedTag = toRouteTag(rawPath);
  // Only retry_401 implicates a specific endpoint. mint_failed and
  // cookie_not_persisted are both session-scoped verdicts learned AT the mint,
  // so whichever route happened to be in flight is a bystander — tagging it
  // would seed the census with innocent endpoints.
  const routeTag = reason === 'retry_401' ? blockedTag : '/api/wm-session';
  addSessionBreadcrumb('wm-session recovery failed', { route: routeTag, blocked: blockedTag, reason });
  try {
    sentryEnqueue((s) => s.captureMessage(
      'wm-session dead: anonymous API calls suppressed',
      { level: 'warning', tags: { kind: 'wm_session_dead', reason, route: routeTag } },
    ));
  } catch { /* best-effort telemetry */ }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(WM_SESSION_DEGRADED_EVENT));
  }
}

/**
 * A lone route failed its replay with a demonstrably fresh cookie. Suppress
 * just that route and report it under its own `kind` so WORLDMONITOR-WG stays
 * the blackout counter it was designed to be (#5245) while the offending
 * endpoint still becomes aggregable. Bounded to one report per route per
 * cooldown window: a struck route short-circuits before recovery runs again.
 */
function reportRouteRecoveryFailure(rawPath: string): void {
  const routeTag = toRouteTag(rawPath);
  addSessionBreadcrumb('wm-session route denied after fresh mint', { route: routeTag });
  try {
    sentryEnqueue((s) => s.captureMessage(
      'wm-session route rejected after fresh mint',
      { level: 'info', tags: { kind: 'wm_session_route_401', route: routeTag } },
    ));
  } catch { /* best-effort telemetry */ }
}

/**
 * Decide how far a failed recovery should reach.
 *
 * `mint_failed` is session-wide by construction — /api/wm-session itself did
 * not hand back a cookie, so no route can succeed. It trips the global
 * cooldown immediately, exactly as before.
 *
 * `retry_401` only implicates the one route that was replayed, so it needs
 * SESSION_DEAD_ROUTE_QUORUM distinct routes before it may black out the tab.
 */
function noteRecoveryFailure(reason: WmSessionDeadReason, rawPath: string): void {
  if (reason === 'mint_failed') {
    markWmSessionDead(reason, rawPath);
    return;
  }
  if (recordRouteStrike(rawPath) >= SESSION_DEAD_ROUTE_QUORUM) {
    markWmSessionDead(reason, rawPath);
    return;
  }
  reportRouteRecoveryFailure(rawPath);
}

function sessionDegradedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Anonymous session temporarily unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'X-Wm-Session-Degraded': '1',
    },
  });
}

function isFresh(s: StoredSession | null): s is StoredSession {
  return !!s && s.exp - REFRESH_MARGIN_MS > Date.now();
}

function loadFromStorage(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed?.exp === 'number') return { exp: parsed.exp };
  } catch { /* ignore */ }
  return null;
}

function saveToStorage(s: StoredSession): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/**
 * Fold one mint's cookie evidence into the persistence latch.
 *
 * `hadSession` is the server's answer to the one question the client cannot
 * ask itself: did this request arrive carrying a usable cookie? The cookie is
 * HttpOnly, so "the server rejected a good cookie" and "my browser never kept
 * it" are indistinguishable from JS — and they need opposite responses. The
 * first deserves a re-mint; the second makes every further mint pointless,
 * because no credentialed route can ever succeed.
 */
function noteMintCookieEvidence(hadSession: boolean, aCookieExistedWhenSent: boolean): void {
  if (hadSession) {
    // The cookie completed a round trip. Any earlier suspicion is void —
    // direct evidence outranks inference, same doctrine as noteRouteSuccess.
    cookieIssuedThisSession = true;
    cookiePersistenceBroken = false;
    useAnonymousSessionHeader = false;
    return;
  }
  cookieIssuedThisSession = true;
  // Only a mint DISPATCHED after some earlier mint had already been answered
  // can testify. `aCookieExistedWhenSent` is sampled at request time for
  // exactly that reason: mints overlap in flight at page boot, because
  // establishWmKeySession bypasses ensureWmSession's `inflight` dedupe and both
  // migrateLegacyKeysToHttpOnlySession() call sites are fire-and-forget. Two
  // requests that left before either response installed a cookie BOTH report
  // hadSession:false honestly — judging that at response time would read the
  // second one as proof and black out a healthy session.
  if (!aCookieExistedWhenSent) return;
  // A cookie was already in hand when this request left, and it still arrived
  // without one: the browser is not storing it (strict cookie settings, an
  // in-app WebView, partitioned storage, a privacy extension).
  cookiePersistenceBroken = true;
  useAnonymousSessionHeader = anonymousSessionHeaderToken !== null;
}

async function fetchNewSession(body?: { widgetKey?: string; proKey?: string }): Promise<StoredSession | null> {
  // Sampled BEFORE the request leaves, not when it returns: concurrent mints
  // would otherwise let the first response to land make the others look like
  // follow-up mints that came back empty. See noteMintCookieEvidence.
  const aCookieExistedWhenSent = cookieIssuedThisSession;
  const identityGenerationWhenSent = sessionIdentityGeneration;
  // AbortSignal.timeout is Baseline 2024 and absent on older Safari/WebView and
  // Smart-TV engines still present in production. Calling it directly throws
  // before fetch is dispatched and looks exactly like a server-side
  // mint_failed episode. AbortController has materially wider support.
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(
    () => timeoutController.abort(),
    fetchNewSessionTimeoutMs,
  );
  try {
    const fetchImpl = nativeSessionFetch ?? globalThis.fetch;
    const resp = await fetchImpl(toApiUrl('/api/wm-session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutController.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { exp?: unknown; hadSession?: unknown; token?: unknown };
    if (typeof data?.exp !== 'number') return null;
    if (
      sessionIdentityGeneration === identityGenerationWhenSent &&
      typeof data.token === 'string' &&
      data.token.startsWith('wms_')
    ) {
      anonymousSessionHeaderToken = data.token;
    }
    // Absent on an older deployment: treat as "no evidence either way" and
    // leave the latch alone rather than accusing a healthy browser.
    if (typeof data.hadSession === 'boolean') {
      noteMintCookieEvidence(data.hadSession, aCookieExistedWhenSent);
    }
    return { exp: data.exp };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function ensureWmSession(): Promise<boolean> {
  if (isWmSessionDead()) return false;
  if (isFresh(cached)) return true;
  if (inflight) return inflight;

  const stored = loadFromStorage();
  if (isFresh(stored)) {
    cached = stored;
    return true;
  }

  inflight = (async () => {
    const fresh = await fetchNewSession();
    if (fresh) {
      cached = fresh;
      sessionGeneration += 1;
      saveToStorage(fresh);
      // A cookie the browser will not keep cannot authorize anything, and the
      // next route's 401 would buy another useless mint. Suppress up front and
      // name the real cause, instead of letting the retry_401 quorum report it
      // as the API rejecting a good cookie (WORLDMONITOR-WG/XP).
      if (cookiePersistenceBroken) {
        if (anonymousSessionHeaderToken) {
          useAnonymousSessionHeader = true;
          return true;
        }
        markWmSessionDead('cookie_not_persisted', '/api/wm-session');
        return false;
      }
      return true;
    }
    return false;
  })().finally(() => { inflight = null; });

  return inflight;
}

export function getWmSessionToken(): string | null {
  // Tokens are HttpOnly now; callers can only know whether the cookie should
  // be fresh by calling ensureWmSession().
  return null;
}

export async function establishWmKeySession(keys: { widgetKey?: string; proKey?: string }): Promise<boolean> {
  const fresh = await fetchNewSession(keys);
  if (!fresh) return false;
  cached = fresh;
  sessionGeneration += 1;
  sessionIdentityGeneration += 1;
  sessionDeadUntil = 0;
  sessionDeadReason = null;
  // A key-bound session is a clean slate: strikes recorded against the old
  // anonymous identity say nothing about what this one may reach. The
  // persistence latch is cleared for the same reason — this mint just set a
  // fresh cookie, and the new identity is entitled to prove itself rather than
  // inherit a verdict reached before the upgrade. If the browser really is
  // dropping cookies, the very next mint re-derives it.
  routeStrikes.clear();
  recentRouteFailures.clear();
  cookiePersistenceBroken = false;
  anonymousSessionHeaderToken = null;
  useAnonymousSessionHeader = false;
  saveToStorage(fresh);
  return true;
}

function withCredentials(init?: RequestInit): RequestInit {
  return { ...(init ?? {}), credentials: init?.credentials ?? 'include' };
}

// Test-only escape hatch. The interceptor lifecycle is module-scoped (one
// install per process) so unit tests can't easily simulate token-state
// transitions across cases without a way to clear `cached` and `inflight`.
// Production code never imports this — it's exclusively for `tests/wm-session-*`.
//
// `interceptorInstalled` is also reset so a test that calls this followed by
// `installWmSessionFetchInterceptor()` actually re-runs the install path
// instead of silently no-op'ing on the install guard. Without it, future
// tests that wipe state and expect a fresh install would see a stale
// `window.fetch` wrapper from a prior test.
export function __resetWmSessionForTests(): void {
  cached = null;
  inflight = null;
  recoveryInFlight = null;
  sessionGeneration = 0;
  sessionIdentityGeneration = 0;
  interceptorInstalled = false;
  sessionDeadUntil = 0;
  sessionDeadReason = null;
  routeStrikes.clear();
  recentRouteFailures.clear();
  cookieIssuedThisSession = false;
  cookiePersistenceBroken = false;
  anonymousSessionHeaderToken = null;
  useAnonymousSessionHeader = false;
  sentryEnqueue = enqueueSentryCall;
  fetchNewSessionTimeoutMs = 10_000;
}

// Test-only: shrink the mint timeout so adversarial repros for hung fetches
// don't need to wait the production 10s budget.
export function __setWmSessionFetchTimeoutForTests(ms: number): void {
  fetchNewSessionTimeoutMs = ms;
}

// Test-only: observe the once-per-episode dead-session Sentry capture without
// loading the SDK. Reset back to the real enqueue by __resetWmSessionForTests.
export function __setWmSessionSentryEnqueueForTests(fn: typeof enqueueSentryCall): void {
  sentryEnqueue = fn;
}

// Install a one-shot fetch wrapper that includes HttpOnly session cookies on
// API calls.
// Only patches calls to our API origin (or relative /api/ paths). Other fetches
// (Sentry, Clerk, third-party CDNs) are forwarded to native fetch unchanged.
//
// Decide whether a fetch URL should go through the wms_-injection branch.
// Exported (and named with no implementation detail in its signature) so the
// regression test in tests/wm-session-interceptor-target.test.mts can lock the
// shape of this decision without needing a JSDOM/happy-dom environment to
// stand up the full interceptor.
//
// Two failure modes pinned here:
//
//   1. PR #3574 — `apiOrigin` was '' on browsers, so the cross-origin match
//      silently returned false for every absolute URL. Bug class: matcher
//      under-matches → wms_ never attached → 401 on every browser request.
//
//   2. PR #3575 review — using raw `startsWith(apiOrigin)` for absolute URLs
//      lets attacker-controlled origins that embed the canonical-origin
//      string as a prefix (e.g. `https://api.worldmonitor.app.evil.example/`)
//      OR as the userinfo portion (`https://api.worldmonitor.app@evil/`)
//      slip through, sending the wms_ token to a foreign host. Bug class:
//      matcher over-matches → token leaks cross-origin.
//
// The fix: relative `/api/` paths still take a fast prefix check (no host
// to validate, can only resolve same-origin). Absolute URLs are parsed via
// `new URL` and compared by `.origin` (exact-match, RFC-3986-correct), with
// an additional `/api/` pathname guard so the matcher never attaches the
// token to non-API paths even if they happen to be on the API host.
export function isApiCallTarget(url: string, apiOrigin: string): boolean {
  if (url.startsWith('/api/')) return true;
  if (apiOrigin === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === apiOrigin && parsed.pathname.startsWith('/api/');
}

function isCredentiallessPublicDataRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  url: string,
): boolean {
  const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : undefined);
  if (credentials !== 'omit') return false;

  let parsed: URL;
  try {
    parsed = new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href);
  } catch {
    return false;
  }

  const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (isPublicSharedRpcRequest(parsed, method)) return true;
  if (pathname !== '/api/bootstrap' || method.toUpperCase() !== 'GET') return false;

  const params = Array.from(parsed.searchParams.keys());
  const tiers = parsed.searchParams.getAll('tier');
  const publicFlags = parsed.searchParams.getAll('public');
  if (
    !params.some((key) => key !== 'tier' && key !== 'public')
    && tiers.length === 1
    && (tiers[0] === 'fast' || tiers[0] === 'slow')
    && publicFlags.length === 1
    && publicFlags[0] === '1'
  ) {
    return true;
  }

  // Single-key public hydration uses one registered key per CDN URL. Reuse the
  // shared tier registry so a credentials:'omit' request cannot escape the
  // session guard merely by presenting an arbitrary single-key shape.
  if (params.some((key) => key !== 'keys' && key !== 'public')) return false;
  const keys = parsed.searchParams.getAll('keys');
  const key = keys[0];
  return keys.length === 1
    && typeof key === 'string'
    && PUBLIC_SINGLE_KEY_BOOTSTRAP_KEYS.has(key)
    && publicFlags.length === 1
    && publicFlags[0] === '1';
}

// If a caller already set Authorization / X-WorldMonitor-Key / X-Api-Key, we
// don't override — Clerk Bearer JWT and explicit user keys still take
// precedence over the anonymous session token.
export function installWmSessionFetchInterceptor(): void {
  if (interceptorInstalled || typeof window === 'undefined') return;
  interceptorInstalled = true;

  // CRITICAL: must be getCanonicalApiOrigin(), NOT getApiBaseUrl(). The latter
  // returns '' for non-desktop runtimes (see runtime.ts:111), which makes the
  // interceptor's cross-origin match below silently fail for every browser
  // request to https://api.worldmonitor.app/api/* — the interceptor only
  // catches relative '/api/' paths, the wms_ token never gets attached, and
  // the gateway returns {"error":"API key required"}. Production incident
  // 2026-05-03: every browser request 401'd because of this.
  const apiOrigin = (() => {
    try { return new URL(getCanonicalApiOrigin()).origin; } catch { return ''; }
  })();
  // AGENTS.md bans `fetch.bind(globalThis)` to avoid freezing a stale
  // reference. The prescribed alternative `(...args) => globalThis.fetch(...)`
  // would recurse here because the very next line replaces `window.fetch`
  // with our wrapper — re-entering through `globalThis.fetch` would loop
  // forever. The correct minimal pattern that captures the pre-wrapping
  // value AND avoids `.bind()` is a plain assignment: in modern browsers
  // `fetch` is already bound to its global receiver and the unbound
  // reference works correctly when called as `original(...)`.
  const original = window.fetch;
  nativeSessionFetch = original;

  window.fetch = async function wmSessionFetch(input, init) {
    const url = (() => {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      if (input instanceof Request) return input.url;
      return '';
    })();

    if (!isApiCallTarget(url, apiOrigin)) return original(input, init);

    // Public tier hydration is intentionally credential-less and does not rely
    // on the anonymous wm-session cookie. Let this exact request shape reach
    // the native fetch even while session recovery is cooling down; otherwise
    // the interceptor's synthetic 503 prevents the public CDN path from
    // restoring the dashboard. Keep the bypass narrow so arbitrary bootstrap
    // reads cannot opt out of the normal session machinery.
    if (isCredentiallessPublicDataRequest(input, init, url)) return original(input, init);

    // Premium routes have a dedicated auth-injection layer
    // (`installWebApiRedirect`'s `enrichInitForPremium` adds Clerk Bearer JWT,
    // WORLDMONITOR_API_KEY, or tester key based on what the user has). Stepping
    // aside lets that inner layer attach the right credential — if we set
    // X-WorldMonitor-Key=wms_... here, the premium injector sees the header
    // and bails, and the server then 401s because wms_ is rejected on premium
    // routes (it's anonymous, not user-bound). PR #3557 review finding.
    const path = (() => {
      try {
        return new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href).pathname;
      } catch {
        return url.split('?')[0] ?? url;
      }
    })();
    if (PREMIUM_RPC_PATHS.has(path)) return original(input, withCredentials(init));

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );

    // Caller already authenticated (Bearer JWT, explicit user/widget key, etc).
    // Don't override — Clerk and explicit-key paths take precedence.
    if (
      headers.has('Authorization') ||
      headers.has('X-WorldMonitor-Key') ||
      headers.has('X-Api-Key')
    ) {
      return original(input, withCredentials(init));
    }

    if (isWmSessionDead()) return sessionDegradedResponse();

    await ensureWmSession().catch(() => false);

    if (isWmSessionDead()) return sessionDegradedResponse();

    // A Request body is a one-shot stream — clone BEFORE the first send so
    // the refresh-on-401 retry below has an intact body to replay. For
    // string/URL inputs, body lives on `init` and Headers merging is enough.
    const requestClone = input instanceof Request ? input.clone() : null;

    const sendWith = (h: Headers, src: typeof input): Promise<Response> => {
      const requestHeaders = new Headers(h);
      if (
        useAnonymousSessionHeader &&
        anonymousSessionHeaderToken &&
        !requestHeaders.has('Authorization') &&
        !requestHeaders.has('X-WorldMonitor-Key') &&
        !requestHeaders.has('X-Api-Key')
      ) {
        requestHeaders.set('X-WorldMonitor-Key', anonymousSessionHeaderToken);
      }
      if (src instanceof Request) {
        const cloned = new Request(src, { ...withCredentials(init), headers: requestHeaders });
        return original(cloned);
      }
      return original(src, { ...withCredentials(init), headers: requestHeaders });
    };

    // Replay once with whatever cookie is current now and record what that
    // proves about THIS route. Used by both mint-free replay paths below (the
    // stale-generation branch and the concurrent-burst follower branch), which
    // must report identically — a 401 that survives a newer cookie is
    // fresh-cookie evidence wherever it is observed.
    const requestSessionIdentityGeneration = sessionIdentityGeneration;
    const isCurrentSessionIdentity = (): boolean => (
      sessionIdentityGeneration === requestSessionIdentityGeneration
    );
    const replayAndReport = async (): Promise<Response> => {
      const replayed = await sendWith(new Headers(headers), requestClone ?? input);
      if (isCurrentSessionIdentity()) {
        if (replayed.status === 401) noteRecoveryFailure('retry_401', path);
        else noteRouteSuccess(path);
      }
      return replayed;
    };

    const requestSessionGeneration = sessionGeneration;
    const resp = await sendWith(headers, input);

    // Layer 2 — refresh-on-401. A single transient blip (HMAC-key rotation,
    // expiry race, server-side cache flap) shouldn't strand the tab. If we
    // had no token to begin with OR the token we sent was rejected, mint a
    // fresh one and replay ONCE. Premium routes already returned above; the
    // wms_ token is irrelevant there.
    if (resp.status !== 401) {
      // Anything other than 401 means the server did not reject our credential,
      // so neither "this route is denied" nor "the session is dead" is supported
      // any more. Deliberately keyed on "not 401" rather than on 2xx: this
      // module's whole model is that 401 is the session signal, and biasing the
      // other way (treating a 500 as continued evidence of a dead session) is
      // what produces blackouts of healthy sessions. See noteRouteSuccess for
      // why this releases the session-wide evidence but not a sibling's guard.
      if (isCurrentSessionIdentity()) noteRouteSuccess(path);
      return resp;
    }

    // #5674 — premiumFetch marked this as a premium call it could not
    // authenticate, so the 401 is the expected auth denial, not a rejected
    // cookie. Hand it back untouched: reminting and replaying would produce the
    // identical 401 and then suppress every anonymous API call for 15 minutes.
    //
    // This is the SECOND of the two bypasses in this function, and the only one
    // that can fire here — path-listed premium routes already returned far
    // above, before any session work. The two are not interchangeable:
    //
    //   - PREMIUM_RPC_PATHS steps aside entirely (a dedicated auth-injection
    //     layer owns those credentials; PR #3557 review).
    //   - This one suppresses ONLY the recovery. The request must already have
    //     minted a session and travelled with credentials, because
    //     `forcePremium` also covers routes anonymous callers legitimately use
    //     — the market-quote tape via proFreshRpcFetch — which 401 when no
    //     cookie is sent at all. premiumFetch keeps that tape unmarked for the
    //     same reason.
    if (hasPremiumIntent(init)) return resp;

    // A slower initial request can report the old cookie after another caller
    // already recovered it. Replay with the newer cookie instead of clearing
    // that success and spending another mint.
    //
    // Checked BEFORE the struck-route short-circuit below: this branch spends no
    // mint, so a struck route must not be denied it — otherwise a route stays
    // pinned to a stale 401 for the rest of its 15-minute window even after some
    // unrelated caller has already obtained a cookie that would work. A 401 that
    // survives the newer cookie IS fresh-cookie evidence, so report it.
    if (sessionGeneration !== requestSessionGeneration) {
      return replayAndReport();
    }

    // This route already 401'd once with a demonstrably fresh cookie. Running
    // recovery again would re-derive the same denial at the cost of another
    // mint, so hand the server's own verdict back to the caller untouched —
    // and, critically, leave the session (and every other route) alone.
    if (isRouteStruck(path)) return resp;

    // Invalidate the cached expiry (and its sessionStorage twin) before
    // re-minting. ensureWmSession() is opportunistic — without invalidation,
    // it would return the same not-yet-clock-expired token that the server
    // just rejected (HMAC-key rotation: token signature is wrong even though
    // `exp` is in the future), and the retry would 401 with the same header.
    cached = null;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }

    // One request verifies the reminted cookie. Other simultaneous 401s wait
    // for that result instead of each multiplying the failed retry.
    if (!recoveryInFlight) {
      const recovery = (async (): Promise<Response | null> => {
        const fresh = await ensureWmSession().catch(() => false);
        if (!fresh) {
          if (isCurrentSessionIdentity()) noteRecoveryFailure('mint_failed', path);
          return null;
        }
        // Recovery already has stronger evidence than a page-boot mint: the
        // request that brought us here was rejected, and this fresh mint handed
        // back an anonymous-only token. Use it for the verification replay now.
        // This also covers reloads where sessionStorage retained a fresh expiry
        // but the HttpOnly cookie was dropped: cookieIssuedThisSession starts
        // false, so hadSession:false alone cannot safely prove persistence is
        // broken, while replaying without the returned token would send every
        // concurrent follower into the retry_401 quorum.
        if (isCurrentSessionIdentity() && anonymousSessionHeaderToken) {
          useAnonymousSessionHeader = true;
        }
        const retryResp = await replayAndReport();
        return retryResp.status === 401 ? null : retryResp;
      })();
      recoveryInFlight = recovery;
      void recovery.then(
        () => { if (recoveryInFlight === recovery) recoveryInFlight = null; },
        () => { if (recoveryInFlight === recovery) recoveryInFlight = null; },
      );
      return (await recovery) ?? resp;
    }

    const verified = await recoveryInFlight;
    if (!verified) {
      // The leader's replay failed, but that verdict is about the LEADER's route.
      // A dashboard launches its panels together, so the session-wide failure
      // this quorum exists to catch (cookie undeliverable => every route 401s)
      // arrives as one concurrent burst — and if every follower just returned
      // here, the burst would contribute exactly ONE strike and never corroborate
      // itself. A fresh cookie does exist unless the mint itself failed (which
      // already blacked out globally), so replay once and report our OWN route's
      // verdict. Costs no mint: recoveryInFlight already spent the only one.
      if (isWmSessionDead()) return resp;
      return replayAndReport();
    }
    return replayAndReport();
  };

  // Layer 1 — periodic refresh. The token is short-lived (12h server-side)
  // and originally there was no auto-refresh, so a tab open overnight (or
  // a laptop that slept) returned 401 on every API call after expiry.
  //
  // Two complementary primitives:
  //   1. setInterval at PERIODIC_REFRESH_MS — wakes opportunistically.
  //      Gated on document.visibilityState so a hidden tab on a sleeping
  //      laptop doesn't fire a flurry of mints when the laptop wakes (N
  //      tabs all hitting /api/wm-session in parallel).
  //   2. visibilitychange listener — when the user returns to a hidden
  //      tab, check freshness immediately. Catches the case where the
  //      interval skipped many beats while hidden.
  //
  // Errors are swallowed — periodic refresh is best-effort; the
  // refresh-on-401 layer above is the safety net.
  if (typeof setInterval === 'function') {
    setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (isFresh(cached)) return;
      ensureWmSession().catch(() => { /* best-effort */ });
    }, PERIODIC_REFRESH_MS);
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (isFresh(cached)) return;
      ensureWmSession().catch(() => { /* best-effort */ });
    });
  }
}
