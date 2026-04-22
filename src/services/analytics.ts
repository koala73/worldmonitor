/**
 * Analytics facade — wired to Umami.
 *
 * All functions use window.umami?.track() so they are safe to call
 * even if the Umami script has not loaded yet (e.g. ad blockers, SSR).
 */

import { subscribeAuthState, type AuthSession } from './auth-state';
import { onSubscriptionChange, type SubscriptionInfo } from './billing';
import { getClerkUserCreatedAt } from './clerk';

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
  // MCP
  'mcp-connect-attempt': true,
  'mcp-connect-success': true,
  'mcp-panel-add': true,
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
} as const;

export type UmamiEvent = keyof typeof EVENTS;

/** Type-safe Umami wrapper. Safe to call even if the script hasn't loaded. */
export function track(event: UmamiEvent, data?: Record<string, unknown>): void {
  window.umami?.track(event, data);
}

export async function initAnalytics(): Promise<void> {
  // No-op: Umami initialises itself via the script tag in index.html.
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
  window.umami?.identify({
    userId,
    plan,
    ...(subStatus != null && { subStatus }),
    ...(planKey != null && { planKey }),
  });
}

export function clearIdentity(): void {
  window.umami?.identify({});
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

export function trackGateHit(feature: string): void {
  track('gate-hit', { feature });
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
