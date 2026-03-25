/**
 * Analytics facade — wired to Umami.
 *
 * All functions use window.umami?.track() so they are safe to call
 * even if the Umami script has not loaded yet (e.g. ad blockers, SSR).
 */

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

/**
 * Attach user context to all subsequent Umami events for this session.
 * Call this once after a successful sign-in or on app boot when the user
 * is already authenticated.
 *
 * PR #1812: call from subscribeAuthState() when user is non-null.
 * Pass user.id and the plan string from the session/subscription object.
 */
export function identifyUser(userId: string, plan: string): void {
  window.umami?.identify({ userId, plan });
}

/**
 * Clear user identity (call on sign-out so subsequent events are anonymous).
 *
 * PR #1812: call from subscribeAuthState() when user becomes null.
 */
export function clearIdentity(): void {
  window.umami?.identify({});
}

/**
 * Stub — wire this in PR #1812.
 *
 * Instructions for PR #1812:
 *   1. Import { identifyUser, clearIdentity, track } from '@/services/analytics'
 *   2. Replace this body with:
 *
 *      subscribeAuthState((user) => {
 *        if (user) {
 *          identifyUser(user.id, user.plan ?? 'free');
 *        } else {
 *          clearIdentity();
 *        }
 *      });
 *
 *   3. Call initAuthAnalytics() from main.ts after initAnalytics().
 *
 *   4. At the sign-in callsite (success callback):
 *        track('sign-in', { method: 'email' });   // or 'google', 'github'
 *
 *   5. At the sign-up callsite (success callback):
 *        track('sign-up', { method: 'email' });
 *
 *   6. At the sign-out callsite:
 *        track('sign-out');
 *
 *   7. Wherever a feature is gated behind auth/pro and the user is blocked:
 *        track('gate-hit', { feature: 'pro-widget' });  // or 'mcp', 'pro-brief', etc.
 */
export function initAuthAnalytics(): void {
  // No-op until PR #1812.
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
