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
import type { WmSessionDeadReason } from './wm-session-copy';
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

export type WmSessionDegradedDetail = { reason: WmSessionDeadReason };

// Whether a mint in THIS page session has already handed the browser a cookie.
// The next mint must arrive carrying it — `/api/wm-session` reports that as
// `hadSession`. A first-ever mint legitimately carries none, so the flag is
// what separates "new visitor" from "browser is dropping our cookie."
let cookieIssuedThisSession = false;
// Latched once a mint proves the browser did not keep the previous cookie.
let cookiePersistenceBroken = false;
// Anonymous-only fallback for clients that reject the shared-domain HttpOnly
// cookie. Kept in memory (never local/session storage) and attached on
// anonymous API calls as soon as a mint returns a token. Cookie remains
// primary via credentials:include.
let anonymousSessionHeaderToken: string | null = null;

interface StoredSession {
  exp: number;
}

let cached: StoredSession | null = null;
let inflight: Promise<SessionAttempt> | null = null;
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
// 2. Corroboration evidence — bounded route TAG -> when it failed and, when the
//    failure was a mint rather than a route denial, why. Keyed by the TAG so two
//    ids of one dynamic endpoint cannot masquerade as two independent routes and
//    fake a quorum. Any successful credentialed response clears it: a 200 proves
//    the cookie is being delivered, which is precisely the counter-evidence the
//    #5674 diagnosis rested on.
//
//    The cause rides the evidence because the verdict that TIPS a quorum is
//    usually not the one carrying the diagnosis. In the modal WORLDMONITOR-WG
//    burst the leader's mint fails (cause `network`, one strike, below quorum)
//    and a follower's replay tips it — with a causeless retry_401, because the
//    follower replays with no cookie, none ever having been minted. Reading the
//    tipping verdict alone would tag an all-mints-failed episode `none` and send
//    triage hunting a cookie problem on a bystander panel. Bounded by
//    SESSION_DEAD_CORROBORATION_MS and voided by any success, so this is
//    episode-scoped evidence, not the ambient last-value state #6804 removed.
const recentRouteFailures = new Map<string, { at: number; cause: MintFailureCause | null }>();

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
function recordRouteStrike(rawPath: string, cause: MintFailureCause | null): number {
  const now = Date.now();
  for (const [struck, until] of routeStrikes) {
    if (until <= now) routeStrikes.delete(struck);
  }
  routeStrikes.set(rawPath, now + SESSION_DEAD_ROUTE_STRIKE_TTL_MS);

  const corroborationFloor = now - SESSION_DEAD_CORROBORATION_MS;
  for (const [tag, seen] of recentRouteFailures) {
    if (seen.at <= corroborationFloor) recentRouteFailures.delete(tag);
  }
  recentRouteFailures.set(toRouteTag(rawPath), { at: now, cause });
  return recentRouteFailures.size;
}

/**
 * The mint cause to report for an episode the quorum just tipped.
 *
 * The tipping verdict frequently has no cause of its own — a retry_401 never
 * does — while the evidence that put the quorum within one strike often does.
 * Prefer the tipping verdict's own cause, then the most recent mint cause still
 * inside the corroboration window, so `none` keeps meaning "no mint failed in
 * this episode" rather than "the last verdict happened not to be a mint".
 */
function episodeMintCause(tippingCause: MintFailureCause | null): MintFailureCause | null {
  if (tippingCause) return tippingCause;
  let latest: { at: number; cause: MintFailureCause | null } | null = null;
  for (const seen of recentRouteFailures.values()) {
    if (seen.cause && (latest === null || seen.at > latest.at)) latest = seen;
  }
  return latest?.cause ?? null;
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

function markWmSessionDead(
  reason: WmSessionDeadReason,
  rawPath: string,
  cause: MintFailureCause | null = null,
): void {
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
  // `reason` names the CATEGORY of failure; `mint_cause` names the actual one.
  // Without it every mint_failed event looked identical, so WORLDMONITOR-WG
  // could not be told apart from a server outage, a rate-limit, a CORS block or
  // a dropped connection — and each of those needs a different fix. This is the
  // same aggregability argument that added the `route` tag in #5674.
  //
  // Emitted UNCONDITIONALLY (#6804). Writing the tag only when a cause existed
  // collapsed two different states into the same blank Sentry bucket: "this
  // episode has no mint cause" (a retry_401 denial, or a mint that succeeded and
  // then lost its cookie) and "the tag was dropped". `none` says the first out
  // loud, so a blank now means only one thing — a client too old to carry it.
  const mintCause: MintCauseTag = cause ?? 'none';
  const tags: Record<string, string> = {
    kind: 'wm_session_dead',
    reason,
    route: routeTag,
    mint_cause: mintCause,
  };
  addSessionBreadcrumb('wm-session recovery failed', {
    route: routeTag,
    blocked: blockedTag,
    reason,
    mint_cause: mintCause,
  });
  try {
    sentryEnqueue((s) => s.captureMessage(
      'wm-session dead: anonymous API calls suppressed',
      { level: 'warning', tags },
    ));
  } catch { /* best-effort telemetry */ }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    // The reason rides the event so the toast can name the right remedy. A
    // plain `Event` forced one blanket message, which told the majority of
    // affected users to check a cookie setting that was never the cause
    // (WORLDMONITOR-WG residual — see describeWmSessionDegradation).
    window.dispatchEvent(
      new CustomEvent<WmSessionDegradedDetail>(WM_SESSION_DEGRADED_EVENT, { detail: { reason } }),
    );
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
 * What the recovery path observed. `mint_failed` carries its cause in the same
 * value, so the reporter cannot be handed a category without the evidence for
 * it — the shape that produced causeless `mint_failed` events (#6804).
 */
type RecoveryVerdict =
  | { reason: 'retry_401' }
  | { reason: 'mint_failed'; cause: MintFailureCause };

/**
 * Decide how far a failed recovery should reach.
 *
 * `mint_failed` is session-wide only when the SERVER produced the failure —
 * `refused` (it answered non-2xx) or `malformed` (it answered something
 * unusable). Those still trip the global cooldown immediately, because no route
 * can succeed against an endpoint that will not issue a token.
 *
 * A `timeout` or `network` mint failure is NOT session-wide. The request never
 * completed, so the server rendered no verdict, and the original
 * "session-wide by construction" reading turned one dropped request into a
 * 15-minute blackout. It is retried once and then needs the same corroboration
 * as `retry_401` (WORLDMONITOR-WG).
 *
 * `retry_401` only implicates the one route that was replayed, so it needs
 * SESSION_DEAD_ROUTE_QUORUM distinct routes before it may black out the tab.
 */
function noteRecoveryFailure(verdict: RecoveryVerdict, rawPath: string): void {
  const cause = verdict.reason === 'mint_failed' ? verdict.cause : null;
  // A mint the SERVER refused (or answered unusably) is session-wide by
  // construction, exactly as before: no route can succeed against an endpoint
  // that will not issue a token, so this still skips the quorum.
  if (mintCauseIsServerVerdict(cause)) {
    markWmSessionDead(verdict.reason, rawPath, cause);
    return;
  }
  // Everything else needs corroboration from a second distinct route before it
  // may black out the tab. For retry_401 that is the original #5674 rule. For a
  // transport-level mint failure it is new: the attempt already burned its one
  // retry, and a single client-side blip is not evidence that the session is
  // unusable — production shows the server minting normally for everyone else
  // at that moment (WORLDMONITOR-WG).
  if (recordRouteStrike(rawPath, cause) >= SESSION_DEAD_ROUTE_QUORUM) {
    markWmSessionDead(verdict.reason, rawPath, episodeMintCause(cause));
    return;
  }
  // Below quorum, a transport mint failure gets no captureMessage. WG is the
  // blackout counter (#5245) and no blackout happened; XP counts routes that
  // reject a demonstrably fresh cookie, which this route did not do — the
  // cookie never arrived. The breadcrumb from the eventual episode carries it.
  if (verdict.reason === 'retry_401') reportRouteRecoveryFailure(rawPath);
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
}

/**
 * Why a mint attempt did not produce a session.
 *
 * `refused` and `malformed` are verdicts FROM the server: it answered, and the
 * answer was unusable. Those really are session-wide — no route can succeed
 * against a session endpoint that will not issue a token.
 *
 * `timeout` and `network` are failures of our own transport: the request never
 * completed, so the server never rendered a verdict at all. They say nothing
 * about whether the next attempt will work, and must not be read as one
 * (WORLDMONITOR-WG — see mintCauseIsTransport).
 *
 * `unknown` is the defensive floor: the mint path threw somewhere it was not
 * expected to. It is not a server verdict either, so it takes the corroboration
 * route rather than blacking out the tab on a client-side bug — but it is not
 * retried, because we cannot say what would be retried.
 */
type MintFailureCause = 'refused' | 'malformed' | 'timeout' | 'network' | 'unknown';
// What the `mint_cause` Sentry tag may say. `none` is the explicit "this
// episode has no mint cause" — see markWmSessionDead (#6804).
type MintCauseTag = MintFailureCause | 'none';
type MintOutcome =
  | { ok: true; session: StoredSession }
  | { ok: false; cause: MintFailureCause };

/**
 * A transport cause is evidence about this ATTEMPT, not about the session.
 *
 * Production disproved the original "a failed mint is session-wide by
 * construction" premise: for 5 of the 7 most recent mint_failed events, server
 * telemetry showed 121-216 successful /api/wm-session mints in a +/-2.5 minute
 * window around the event and ZERO rejections. The server was healthy and
 * minting for everyone else while one client declared the whole session dead
 * and suppressed its own anonymous calls for 15 minutes.
 */
function mintCauseIsTransport(cause: MintFailureCause | null): boolean {
  return cause === 'timeout' || cause === 'network';
}

/**
 * Only a cause the SERVER produced justifies suppressing every anonymous call
 * at once. Stated positively rather than as `!mintCauseIsTransport(...)`,
 * because that spelling made every value the taxonomy did not yet name — a
 * missing cause, and now `unknown` — default to the most expensive verdict the
 * client can reach (#6804).
 */
function mintCauseIsServerVerdict(cause: MintFailureCause | null): boolean {
  return cause === 'refused' || cause === 'malformed';
}

async function mintSession(body?: { widgetKey?: string; proKey?: string }): Promise<MintOutcome> {
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
  // Set by our own timer, so an AbortError can be attributed to the budget
  // rather than guessed at from the error name — a caller-supplied abort or a
  // browser-issued one would otherwise be misreported as `timeout`.
  let timedOut = false;
  const timeoutId = setTimeout(
    () => { timedOut = true; timeoutController.abort(); },
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
    // The server answered and said no. That IS a session-wide verdict.
    if (!resp.ok) return { ok: false, cause: 'refused' };
    // A body we cannot parse or that carries no usable expiry is the server
    // answering with something unusable — also session-wide, and NOT a
    // transport failure, so it must not inherit the retry below.
    let data: { exp?: unknown; hadSession?: unknown; token?: unknown };
    try {
      data = await resp.json() as { exp?: unknown; hadSession?: unknown; token?: unknown };
    } catch {
      return { ok: false, cause: 'malformed' };
    }
    if (typeof data?.exp !== 'number') return { ok: false, cause: 'malformed' };
    if (sessionIdentityGeneration === identityGenerationWhenSent) {
      if (typeof data.token === 'string' && data.token.startsWith('wms_')) {
        anonymousSessionHeaderToken = data.token;
      }
      // Absent on an older deployment: treat as "no evidence either way" and
      // leave the latch alone rather than accusing a healthy browser.
      if (typeof data.hadSession === 'boolean') {
        noteMintCookieEvidence(data.hadSession, aCookieExistedWhenSent);
      }
    }
    return { ok: true, session: { exp: data.exp } };
  } catch {
    // The request never completed. Nothing here is evidence about the session.
    return { ok: false, cause: timedOut ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * What ONE attempt at securing a session actually did.
 *
 * The bare boolean could not answer the only question the recovery path needs
 * answered — did we ask the server, and what did it say? So recovery read the
 * cause from a module-scoped `lastMintFailureCause` instead, which is ambient:
 * it belongs to whichever mint finished last, not to this attempt, and it is
 * `null` for every `false` that never reached a mint at all. Both readings were
 * then reported as `mint_failed` (#6804). Returning the verdict alongside the
 * result makes the two inseparable by construction.
 */
type SessionAttempt =
  | { ok: true }
  // The session is already suppressed, so NO mint was attempted. This is not a
  // mint failure: the blackout that suppressed it was captured when it was
  // declared, and reporting it again would count one episode once per request
  // that happened to be in flight — inflating WORLDMONITOR-WG (the blackout
  // counter, #5245) and, worse, re-arming the cooldown each time, because
  // markWmSessionDead extends sessionDeadUntil before its already-dead return.
  | { ok: false; kind: 'suppressed' }
  // The mint SUCCEEDED; the browser then proved it will not keep the cookie.
  // markWmSessionDead('cookie_not_persisted') has already recorded that verdict
  // and named the right remedy — relabelling the same episode `mint_failed`
  // downstream contradicts it and points diagnosis at the server.
  | { ok: false; kind: 'cookie_not_persisted' }
  | { ok: false; kind: 'mint_failed'; cause: MintFailureCause };

const SESSION_ATTEMPT_OK: SessionAttempt = { ok: true };
// A throw from the attempt itself. Not a server verdict (see
// mintCauseIsServerVerdict), so it needs corroboration like a transport blip.
const SESSION_ATTEMPT_THREW: SessionAttempt = { ok: false, kind: 'mint_failed', cause: 'unknown' };

/**
 * `unknown` is the one cause that says "we do not know what happened", so
 * discarding the exception on the way to it defeats the tag this module exists
 * to make legible. Send the throw itself; the verdict is unchanged.
 *
 * This is a live path, not a defensive floor: `new AbortController()` and the
 * timeout `setTimeout` sit OUTSIDE mintSession's try (see the AbortSignal.timeout
 * note there), and markWmSessionDead's `new CustomEvent(...)` is unguarded — all
 * three on exactly the old WebView / Smart-TV engines that comment names.
 */
function reportUnknownMintThrow(error: unknown): SessionAttempt {
  try { sentryEnqueue((s) => s.captureException(error)); } catch { /* best-effort telemetry */ }
  return SESSION_ATTEMPT_THREW;
}

async function attemptWmSession(): Promise<SessionAttempt> {
  if (isWmSessionDead()) return { ok: false, kind: 'suppressed' };
  if (isFresh(cached)) return SESSION_ATTEMPT_OK;
  if (inflight) return inflight;

  const stored = loadFromStorage();
  // sessionStorage only stores {exp}. After reload the in-memory wms_
  // token is gone; treating that expiry as a live session would send the
  // first RPC cookie-only (the XP bug). Remint unless we already have a
  // token. Do NOT write `cached = stored` first: a failed remint would
  // then make the next attemptWmSession hit `isFresh(cached)` above and
  // return OK with no token — the leftover that turned one transport
  // mint blip into cookie-less 401s on every boot panel (WORLDMONITOR-WG).
  if (isFresh(stored) && anonymousSessionHeaderToken) {
    cached = stored;
    return SESSION_ATTEMPT_OK;
  }

  const identityGenerationWhenStarted = sessionIdentityGeneration;
  inflight = (async (): Promise<SessionAttempt> => {
    const outcome = await mintSession();
    // A key-session mint may replace this anonymous identity while its request
    // is in flight. The replacement is already authoritative; let the caller
    // replay through it without overwriting its cache or persistence verdict.
    if (sessionIdentityGeneration !== identityGenerationWhenStarted) return SESSION_ATTEMPT_OK;
    if (!outcome.ok) return { ok: false, kind: 'mint_failed', cause: outcome.cause };
    cached = outcome.session;
    sessionGeneration += 1;
    saveToStorage(outcome.session);
    // A cookie the browser will not keep cannot authorize anything, and the
    // next route's 401 would buy another useless mint. Suppress up front and
    // name the real cause, instead of letting the retry_401 quorum report it
    // as the API rejecting a good cookie (WORLDMONITOR-WG/XP).
    if (cookiePersistenceBroken) {
      if (anonymousSessionHeaderToken) {
        return SESSION_ATTEMPT_OK;
      }
      markWmSessionDead('cookie_not_persisted', '/api/wm-session');
      return { ok: false, kind: 'cookie_not_persisted' };
    }
    return SESSION_ATTEMPT_OK;
  })().finally(() => { inflight = null; });

  return inflight;
}

export async function ensureWmSession(): Promise<boolean> {
  return (await attemptWmSession()).ok;
}

export function getWmSessionToken(): string | null {
  // Tokens are HttpOnly now; callers can only know whether the cookie should
  // be fresh by calling ensureWmSession().
  return null;
}

export async function establishWmKeySession(keys: { widgetKey?: string; proKey?: string }): Promise<boolean> {
  const outcome = await mintSession(keys);
  if (!outcome.ok) return false;
  const fresh = outcome.session;
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
// Test-only: populate `cached` the way a successful mint does, without
// going through attemptWmSession. The storage-prime helper used to rely
// on writing `{exp}` into `cached` before remint; that path is gone so a
// leftover failed remint cannot look like a live session.
export function __primeWmSessionCacheForTests(exp: number): void {
  cached = { exp };
}

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
      // Attach whenever the mint already handed us a token. Waiting on
      // useAnonymousSessionHeader left the first post-mint RPC cookie-only,
      // which 401s when the HttpOnly cookie has not landed yet (or never
      // will). Cookie remains primary via credentials:'include'; the header
      // is a same-token backup and is skipped if the caller already authed.
      if (
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
        if (replayed.status === 401) {
          // retry_401 means "a demonstrably fresh cookie was rejected".
          // A 401 after a mint that never succeeded is guaranteed — we
          // sent neither wms_ nor a newly issued cookie — so it must not
          // corroborate a transport mint failure into a tab-wide blackout.
          // The modal WORLDMONITOR-WG residual was exactly that: mint
          // failed (network), then USNI / vessel-snapshot replayed
          // cookie-less and tipped the quorum. sessionGeneration ticks
          // only on a successful mint, which is also what the cookie-only
          // test fixtures use (body is `{exp}` with no token).
          if (anonymousSessionHeaderToken || sessionGeneration > 0) {
            noteRecoveryFailure({ reason: 'retry_401' }, path);
          }
        } else noteRouteSuccess(path);
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
        let attempt = await attemptWmSession().catch(reportUnknownMintThrow);
        // A transport failure is the one cause worth immediately re-attempting:
        // the server never answered, so a second try costs one request and may
        // simply succeed. Bounded to a single retry, and only for a transport
        // cause — a refusal is not retried, because the server already answered
        // and would answer the same way (WORLDMONITOR-WG). A suppressed attempt
        // is not retried either: nothing was asked, so there is nothing to ask
        // again until the cooldown lapses.
        if (!attempt.ok && attempt.kind === 'mint_failed' && mintCauseIsTransport(attempt.cause)) {
          attempt = await attemptWmSession().catch(reportUnknownMintThrow);
        }
        if (!attempt.ok) {
          // Only an attempt that actually reached the mint may be reported as
          // `mint_failed`. `suppressed` and `cookie_not_persisted` already have
          // their own verdict on record — re-reporting either one attributes a
          // failure to a mint that never happened, or overwrites the diagnosis
          // of one that succeeded (#6804).
          if (attempt.kind === 'mint_failed' && isCurrentSessionIdentity()) {
            noteRecoveryFailure({ reason: 'mint_failed', cause: attempt.cause }, path);
          }
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
