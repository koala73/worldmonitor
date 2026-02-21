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
};

// ── Typed event schemas (allowlisted properties per event) ──

const HAS_KEYS = Object.values(SECRET_ANALYTICS_NAMES).map(n => `has_${n}`);

const EVENT_SCHEMAS: Record<string, Set<string>> = {
  wm_app_loaded: new Set(['load_time_ms', 'panel_count']),
  wm_panel_viewed: new Set(['panel_id']),
  wm_summary_generated: new Set(['provider', 'model', 'cached']),
  wm_summary_failed: new Set(['last_provider']),
  wm_api_keys_configured: new Set([
    'total_keys_configured', 'total_features_enabled', 'enabled_features',
    'ollama_model', 'platform',
    ...HAS_KEYS,
  ]),
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
  capture: (event: string, props?: Record<string, unknown>) => void;
};

let posthogInstance: PostHogInstance | null = null;
let initPromise: Promise<void> | null = null;

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const POSTHOG_HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || 'https://us.i.posthog.com';

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
        capture_pageview: false,
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
    } catch (error) {
      console.warn('[Analytics] Failed to initialize PostHog:', error);
    }
  })();

  return initPromise;
}

export function trackEvent(name: string, props?: Record<string, unknown>): void {
  if (!posthogInstance) return;
  const safeProps = props ? sanitizeProps(name, props) : {};
  posthogInstance.capture(name, safeProps);
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
