/**
 * PostHog Analytics Service
 *
 * Always active when VITE_POSTHOG_KEY is set. No consent gate.
 * All exports are no-ops when the key is absent (dev/local).
 *
 * Data safety:
 * - Typed allowlists per event — unlisted properties silently dropped
 * - sanitize_properties callback strips strings matching API key prefixes
 * - No session recordings, no autocapture
 * - distinct_id is a random UUID — pseudonymous, not identifiable
 */

import { isDesktopRuntime } from './runtime';
import { getRuntimeConfigSnapshot, type RuntimeSecretKey } from './runtime-config';
import { SITE_VARIANT } from '@/config';
import { isMobileDevice } from '@/utils';
import { invokeTauri } from './tauri-bridge';

// ── Installation identity ──

function getOrCreateInstallationId(): string {
  const STORAGE_KEY = 'wm-installation-id';
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

// ── Stable property name map for secret keys ──

const SECRET_ANALYTICS_NAMES: Record<RuntimeSecretKey, string> = {
  GROQ_API_KEY: 'groq',
  OPENROUTER_API_KEY: 'openrouter',
  FRED_API_KEY: 'fred',
  EIA_API_KEY: 'eia',
  CLOUDFLARE_API_TOKEN: 'cloudflare',
  ACLED_ACCESS_TOKEN: 'acled',
  URLHAUS_AUTH_KEY: 'urlhaus',
  OTX_API_KEY: 'otx',
  ABUSEIPDB_API_KEY: 'abuseipdb',
  WINGBITS_API_KEY: 'wingbits',
  WS_RELAY_URL: 'ws_relay',
  VITE_OPENSKY_RELAY_URL: 'opensky_relay',
  OPENSKY_CLIENT_ID: 'opensky',
  OPENSKY_CLIENT_SECRET: 'opensky_secret',
  AISSTREAM_API_KEY: 'aisstream',
  FINNHUB_API_KEY: 'finnhub',
  NASA_FIRMS_API_KEY: 'nasa_firms',
  UC_DP_KEY: 'uc_dp',
  OLLAMA_API_URL: 'ollama_url',
  OLLAMA_MODEL: 'ollama_model',
  WORLDMONITOR_API_KEY: 'worldmonitor',
};

// ── Typed event schemas (allowlisted properties per event) ──

const HAS_KEYS = Object.values(SECRET_ANALYTICS_NAMES).map(n => `has_${n}`);

const EVENT_SCHEMAS: Record<string, Set<string>> = {
  // Phase 1 — core events
  wm_app_loaded: new Set(['load_time_ms', 'panel_count']),
  wm_panel_viewed: new Set(['panel_id']),
  wm_summary_generated: new Set(['provider', 'model', 'cached']),
  wm_summary_failed: new Set(['last_provider']),
  wm_api_keys_configured: new Set([
    'total_keys_configured', 'total_features_enabled', 'enabled_features',
    'ollama_model', 'platform',
    ...HAS_KEYS,
  ]),
  // Phase 2 — plan-specified events
  wm_panel_resized: new Set(['panel_id', 'new_span']),
  wm_variant_switched: new Set(['from', 'to']),
  wm_map_layer_toggled: new Set(['layer_id', 'enabled', 'source']),
  wm_country_brief_opened: new Set(['country_code']),
  wm_theme_changed: new Set(['theme']),
  wm_language_changed: new Set(['language']),
  wm_feature_toggled: new Set(['feature_id', 'enabled']),
  wm_search_used: new Set(['query_length', 'result_count']),
  // Phase 2 — additional interaction events
  wm_map_view_changed: new Set(['view']),
  wm_country_selected: new Set(['country_code', 'country_name', 'source']),
  wm_search_result_selected: new Set(['result_type']),
  wm_panel_toggled: new Set(['panel_id', 'enabled']),
  wm_finding_clicked: new Set(['finding_id', 'finding_source', 'finding_type', 'priority']),
  wm_update_shown: new Set(['current_version', 'remote_version']),
  wm_update_clicked: new Set(['target_version']),
  wm_update_dismissed: new Set(['target_version']),
  wm_critical_banner_action: new Set(['action', 'theater_id']),
  wm_download_clicked: new Set(['platform']),
  wm_download_banner_dismissed: new Set([]),
  wm_webcam_selected: new Set(['webcam_id', 'city', 'view_mode']),
  wm_webcam_region_filtered: new Set(['region']),
  wm_deeplink_opened: new Set(['deeplink_type', 'target']),
};

function sanitizeProps(event: string, raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = EVENT_SCHEMAS[event];
  if (!allowed) return {};
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (allowed.has(k)) safe[k] = v;
  }
  return safe;
}

// ── Defense-in-depth: strip values that look like API keys ──

const API_KEY_PREFIXES = /^(sk-|gsk_|or-|Bearer )/;

function deepStripSecrets(props: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'string' && API_KEY_PREFIXES.test(v)) {
      cleaned[k] = '[REDACTED]';
    } else {
      cleaned[k] = v;
    }
  }
  return cleaned;
}

// ── PostHog instance management ──

type PostHogInstance = {
  init: (key: string, config: Record<string, unknown>) => void;
  register: (props: Record<string, unknown>) => void;
  capture: (event: string, props?: Record<string, unknown>, options?: { transport?: 'XHR' | 'sendBeacon' }) => void;
};

let posthogInstance: PostHogInstance | null = null;
let initPromise: Promise<void> | null = null;

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const POSTHOG_HOST = isDesktopRuntime()
  ? ((import.meta.env.VITE_POSTHOG_HOST as string | undefined) || 'https://us.i.posthog.com')
  : '/ingest'; // Reverse proxy through own domain to bypass ad blockers

// ── Public API ──

export async function initAnalytics(): Promise<void> {
  if (!POSTHOG_KEY) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const mod = await import('posthog-js');
      const posthog = mod.default;

      posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        persistence: 'localStorage',
        autocapture: false,
        capture_pageview: false, // Manual capture below — auto-capture silently fails with bootstrap + SPA
        capture_pageleave: true,
        disable_session_recording: true,
        bootstrap: { distinctID: getOrCreateInstallationId() },
        sanitize_properties: (props: Record<string, unknown>) => deepStripSecrets(props),
      });

      // Register super properties (attached to every event)
      const superProps: Record<string, unknown> = {
        platform: isDesktopRuntime() ? 'desktop' : 'web',
        variant: SITE_VARIANT,
        app_version: __APP_VERSION__,
        is_mobile: isMobileDevice(),
        screen_width: screen.width,
        screen_height: screen.height,
        viewport_width: innerWidth,
        viewport_height: innerHeight,
        is_big_screen: screen.width >= 2560 || screen.height >= 1440,
        is_tv_mode: screen.width >= 3840,
        device_pixel_ratio: devicePixelRatio,
        browser_language: navigator.language,
        local_hour: new Date().getHours(),
        local_day: new Date().getDay(),
      };

      // Desktop additionally registers OS and arch
      if (isDesktopRuntime()) {
        try {
          const info = await invokeTauri<{ os: string; arch: string }>('get_desktop_runtime_info');
          superProps.desktop_os = info.os;
          superProps.desktop_arch = info.arch;
        } catch {
          // Tauri bridge may not be available yet
        }
      }

      posthog.register(superProps);
      posthogInstance = posthog as unknown as PostHogInstance;

      // Fire $pageview manually after full init — auto capture_pageview: true
      // fires during init() before super props are registered, and silently
      // fails with bootstrap + SPA setups (posthog-js #386).
      posthog.capture('$pageview');

      // Flush any events queued while offline (desktop)
      flushOfflineQueue();

      // Re-flush when coming back online
      if (isDesktopRuntime()) {
        window.addEventListener('online', () => flushOfflineQueue());
      }
    } catch (error) {
      console.warn('[Analytics] Failed to initialize PostHog:', error);
    }
  })();

  return initPromise;
}

// ── Offline event queue (desktop) ──

const OFFLINE_QUEUE_KEY = 'wm-analytics-offline-queue';
const OFFLINE_QUEUE_CAP = 200;

function enqueueOffline(name: string, props: Record<string, unknown>): void {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    const queue: Array<{ name: string; props: Record<string, unknown>; ts: number }> = raw ? JSON.parse(raw) : [];
    queue.push({ name, props, ts: Date.now() });
    if (queue.length > OFFLINE_QUEUE_CAP) queue.splice(0, queue.length - OFFLINE_QUEUE_CAP);
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch { /* localStorage full or unavailable */ }
}

function flushOfflineQueue(): void {
  if (!posthogInstance) return;
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return;
    const queue: Array<{ name: string; props: Record<string, unknown> }> = JSON.parse(raw);
    localStorage.removeItem(OFFLINE_QUEUE_KEY);
    for (const { name, props } of queue) {
      posthogInstance.capture(name, props);
    }
  } catch { /* corrupt queue, discard */ }
}

export function trackEvent(name: string, props?: Record<string, unknown>): void {
  const safeProps = props ? sanitizeProps(name, props) : {};
  if (!posthogInstance) {
    if (isDesktopRuntime() && POSTHOG_KEY) enqueueOffline(name, safeProps);
    return;
  }
  posthogInstance.capture(name, safeProps);
}

/** Use sendBeacon transport for events fired just before page reload. */
export function trackEventBeforeUnload(name: string, props?: Record<string, unknown>): void {
  if (!posthogInstance) return;
  const safeProps = props ? sanitizeProps(name, props) : {};
  posthogInstance.capture(name, safeProps, { transport: 'sendBeacon' });
}

export function trackPanelView(panelId: string): void {
  trackEvent('wm_panel_viewed', { panel_id: panelId });
}

export function trackApiKeysSnapshot(): void {
  const config = getRuntimeConfigSnapshot();
  const presence: Record<string, boolean> = {};
  for (const [internalKey, analyticsName] of Object.entries(SECRET_ANALYTICS_NAMES)) {
    const state = config.secrets[internalKey as RuntimeSecretKey];
    presence[`has_${analyticsName}`] = Boolean(state?.value);
  }

  const enabledFeatures = Object.entries(config.featureToggles)
    .filter(([, v]) => v).map(([k]) => k);

  trackEvent('wm_api_keys_configured', {
    platform: isDesktopRuntime() ? 'desktop' : 'web',
    total_keys_configured: Object.values(presence).filter(Boolean).length,
    ...presence,
    enabled_features: enabledFeatures,
    total_features_enabled: enabledFeatures.length,
    ollama_model: config.secrets.OLLAMA_MODEL?.value || 'none',
  });
}

export function trackLLMUsage(provider: string, model: string, cached: boolean): void {
  trackEvent('wm_summary_generated', { provider, model, cached });
}

export function trackLLMFailure(lastProvider: string): void {
  trackEvent('wm_summary_failed', { last_provider: lastProvider });
}

// ── Phase 2 helpers (plan-specified events) ──

export function trackPanelResized(panelId: string, newSpan: number): void {
  trackEvent('wm_panel_resized', { panel_id: panelId, new_span: newSpan });
}

export function trackVariantSwitch(from: string, to: string): void {
  trackEventBeforeUnload('wm_variant_switched', { from, to });
}

export function trackMapLayerToggle(layerId: string, enabled: boolean, source: 'user' | 'programmatic'): void {
  trackEvent('wm_map_layer_toggled', { layer_id: layerId, enabled, source });
}

export function trackCountryBriefOpened(countryCode: string): void {
  trackEvent('wm_country_brief_opened', { country_code: countryCode });
}

export function trackThemeChanged(theme: string): void {
  trackEventBeforeUnload('wm_theme_changed', { theme });
}

export function trackLanguageChange(language: string): void {
  trackEventBeforeUnload('wm_language_changed', { language });
}

export function trackFeatureToggle(featureId: string, enabled: boolean): void {
  trackEvent('wm_feature_toggled', { feature_id: featureId, enabled });
}

export function trackSearchUsed(queryLength: number, resultCount: number): void {
  trackEvent('wm_search_used', { query_length: queryLength, result_count: resultCount });
}

// ── Phase 2 helpers (additional interaction events) ──

export function trackMapViewChange(view: string): void {
  trackEvent('wm_map_view_changed', { view });
}

export function trackCountrySelected(code: string, name: string, source: string): void {
  trackEvent('wm_country_selected', { country_code: code, country_name: name, source });
}

export function trackSearchResultSelected(resultType: string): void {
  trackEvent('wm_search_result_selected', { result_type: resultType });
}

export function trackPanelToggled(panelId: string, enabled: boolean): void {
  trackEvent('wm_panel_toggled', { panel_id: panelId, enabled });
}

export function trackFindingClicked(id: string, source: string, type: string, priority: string): void {
  trackEvent('wm_finding_clicked', { finding_id: id, finding_source: source, finding_type: type, priority });
}

export function trackUpdateShown(current: string, remote: string): void {
  trackEvent('wm_update_shown', { current_version: current, remote_version: remote });
}

export function trackUpdateClicked(version: string): void {
  trackEvent('wm_update_clicked', { target_version: version });
}

export function trackUpdateDismissed(version: string): void {
  trackEvent('wm_update_dismissed', { target_version: version });
}

export function trackCriticalBannerAction(action: string, theaterId: string): void {
  trackEvent('wm_critical_banner_action', { action, theater_id: theaterId });
}

export function trackDownloadClicked(platform: string): void {
  trackEvent('wm_download_clicked', { platform });
}

export function trackDownloadBannerDismissed(): void {
  trackEvent('wm_download_banner_dismissed');
}

export function trackWebcamSelected(webcamId: string, city: string, viewMode: string): void {
  trackEvent('wm_webcam_selected', { webcam_id: webcamId, city, view_mode: viewMode });
}

export function trackWebcamRegionFiltered(region: string): void {
  trackEvent('wm_webcam_region_filtered', { region });
}

export function trackDeeplinkOpened(type: string, target: string): void {
  trackEvent('wm_deeplink_opened', { deeplink_type: type, target });
}
