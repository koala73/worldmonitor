import { SITE_VARIANT } from '@/config/variant';

const ENV = (() => {
  try {
    return import.meta.env ?? {};
  } catch {
    return {} as Record<string, string | undefined>;
  }
})();

const WS_API_URL = ENV.VITE_WS_API_URL || '';
const DEFAULT_WEB_API_URL = 'https://api.worldmonitor.app';
const KEYED_CLOUD_API_PATTERN = /^\/api\/(?:[^/]+\/v1\/|bootstrap(?:\?|$)|polymarket(?:\?|$)|ais-snapshot(?:\?|$))/;

const DEFAULT_REMOTE_HOSTS: Record<string, string> = {
  tech: WS_API_URL,
  full: WS_API_URL,
  finance: WS_API_URL,
  world: WS_API_URL,
  happy: WS_API_URL,
};

const DEFAULT_LOCAL_API_PORT = 46123;
const FORCE_DESKTOP_RUNTIME = ENV.VITE_DESKTOP_RUNTIME === '1';

let _resolvedPort: number | null = null;
let _portPromise: Promise<number> | null = null;

export async function resolveLocalApiPort(): Promise<number> {
  if (_resolvedPort !== null) return _resolvedPort;
  if (_portPromise) return _portPromise;
  _portPromise = (async () => {
    try {
      const { tryInvokeTauri } = await import('@/services/tauri-bridge');
      const port = await tryInvokeTauri<number>('get_local_api_port');
      if (port && port > 0) {
        _resolvedPort = port;
        return port;
      }
    } catch {
      // IPC failed — allow retry on next call
    } finally {
      _portPromise = null;
    }
    return DEFAULT_LOCAL_API_PORT;
  })();
  return _portPromise;
}

export function getLocalApiPort(): number {
  return _resolvedPort ?? DEFAULT_LOCAL_API_PORT;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

type RuntimeProbe = {
  hasTauriGlobals: boolean;
  userAgent: string;
  locationProtocol: string;
  locationHost: string;
  locationOrigin: string;
};

export function detectDesktopRuntime(probe: RuntimeProbe): boolean {
  const tauriInUserAgent = probe.userAgent.includes('Tauri');
  const secureLocalhostOrigin = (
    probe.locationProtocol === 'https:' && (
      probe.locationHost === 'localhost' ||
      probe.locationHost.startsWith('localhost:') ||
      probe.locationHost === '127.0.0.1' ||
      probe.locationHost.startsWith('127.0.0.1:')
    )
  );

  // Tauri production windows can expose tauri-like hosts/schemes without
  // always exposing bridge globals at first paint.
  const tauriLikeLocation = (
    probe.locationProtocol === 'tauri:' ||
    probe.locationProtocol === 'asset:' ||
    probe.locationHost === 'tauri.localhost' ||
    probe.locationHost.endsWith('.tauri.localhost') ||
    probe.locationOrigin.startsWith('tauri://') ||
    secureLocalhostOrigin
  );

  return probe.hasTauriGlobals || tauriInUserAgent || tauriLikeLocation;
}

export function isDesktopRuntime(): boolean {
  if (FORCE_DESKTOP_RUNTIME) {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  return detectDesktopRuntime({
    hasTauriGlobals: '__TAURI_INTERNALS__' in window || '__TAURI__' in window,
    userAgent: window.navigator?.userAgent ?? '',
    locationProtocol: window.location?.protocol ?? '',
    locationHost: window.location?.host ?? '',
    locationOrigin: window.location?.origin ?? '',
  });
}

export function getApiBaseUrl(): string {
  if (!isDesktopRuntime()) {
    return '';
  }

  const configuredBaseUrl = ENV.VITE_TAURI_API_BASE_URL;
  if (configuredBaseUrl) {
    return normalizeBaseUrl(configuredBaseUrl);
  }

  return `http://127.0.0.1:${getLocalApiPort()}`;
}

function isWorldMonitorWebHost(hostname: string): boolean {
  return hostname === 'worldmonitor.app'
    || hostname === 'www.worldmonitor.app'
    || hostname.endsWith('.worldmonitor.app');
}

export function getConfiguredWebApiBaseUrl(): string {
  if (WS_API_URL) {
    return normalizeBaseUrl(WS_API_URL);
  }

  if (typeof window === 'undefined') {
    return '';
  }

  if (isDesktopRuntime()) {
    return '';
  }

  const hostname = window.location?.hostname ?? '';
  if (!isWorldMonitorWebHost(hostname)) {
    return '';
  }

  return DEFAULT_WEB_API_URL;
}

export function getCanonicalApiOrigin(): string {
  return getConfiguredWebApiBaseUrl() || DEFAULT_WEB_API_URL;
}

export function getRemoteApiBaseUrl(): string {
  const configuredRemoteBase = ENV.VITE_TAURI_REMOTE_API_BASE_URL;
  if (configuredRemoteBase) {
    return normalizeBaseUrl(configuredRemoteBase);
  }

  const webApiBase = getConfiguredWebApiBaseUrl();
  if (webApiBase) {
    return webApiBase;
  }

  const fromHosts = DEFAULT_REMOTE_HOSTS[SITE_VARIANT] ?? DEFAULT_REMOTE_HOSTS.full ?? '';
  if (fromHosts) return fromHosts;

  // Desktop builds may not set VITE_WS_API_URL; default to production.
  if (isDesktopRuntime()) return 'https://worldmonitor.app';
  return '';
}

export function toRuntimeUrl(path: string): string {
  if (!path.startsWith('/')) {
    return path;
  }

  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    return path;
  }

  return `${baseUrl}${path}`;
}

export function toApiUrl(path: string): string {
  if (!path.startsWith('/')) {
    return path;
  }

  if (isDesktopRuntime()) {
    return toRuntimeUrl(path);
  }

  const webApiBase = getConfiguredWebApiBaseUrl();
  if (!webApiBase) {
    return path;
  }

  return `${webApiBase}${path}`;
}

function extractHostnames(...urls: (string | undefined)[]): string[] {
  const hosts: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    try { hosts.push(new URL(u).hostname); } catch {}
  }
  return hosts;
}

const APP_HOSTS = new Set([
  'worldmonitor.app',
  'www.worldmonitor.app',
  'tech.worldmonitor.app',
  'api.worldmonitor.app',
  'localhost',
  '127.0.0.1',
  ...extractHostnames(WS_API_URL, ENV.VITE_WS_RELAY_URL),
]);

function isAppOriginUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const host = u.hostname;
    return APP_HOSTS.has(host) || host.endsWith('.worldmonitor.app');
  } catch {
    return false;
  }
}

function getApiTargetFromRequestInput(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') {
    if (input.startsWith('/')) return input;
    if (isAppOriginUrl(input)) {
      const u = new URL(input);
      return `${u.pathname}${u.search}`;
    }
    return null;
  }

  if (input instanceof URL) {
    if (isAppOriginUrl(input.href)) {
      return `${input.pathname}${input.search}`;
    }
    return null;
  }

  if (isAppOriginUrl(input.url)) {
    const u = new URL(input.url);
    return `${u.pathname}${u.search}`;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SmartPollReason = 'interval' | 'resume' | 'manual' | 'startup';

export interface SmartPollContext {
  signal?: AbortSignal;
  reason: SmartPollReason;
  isHidden: boolean;
}

export interface SmartPollOptions {
  intervalMs: number;
  hiddenIntervalMs?: number;
  hiddenMultiplier?: number;
  pauseWhenHidden?: boolean;
  refreshOnVisible?: boolean;
  runImmediately?: boolean;
  shouldRun?: () => boolean;
  maxBackoffMultiplier?: number;
  jitterFraction?: number;
  minIntervalMs?: number;
  onError?: (error: unknown) => void;
  visibilityDebounceMs?: number;
  visibilityHub?: VisibilityHub;
}

export class VisibilityHub {
  private listeners = new Set<() => void>();
  private listening = false;
  private handler: (() => void) | null = null;

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    this.ensureListening();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stopListening();
    };
  }

  destroy(): void {
    this.stopListening();
    this.listeners.clear();
  }

  private ensureListening(): void {
    if (this.listening || !hasVisibilityApi()) return;
    this.handler = () => {
      for (const cb of this.listeners) cb();
    };
    document.addEventListener('visibilitychange', this.handler);
    this.listening = true;
  }

  private stopListening(): void {
    if (!this.listening || !this.handler) return;
    document.removeEventListener('visibilitychange', this.handler);
    this.handler = null;
    this.listening = false;
  }
}

export interface SmartPollLoopHandle {
  stop: () => void;
  trigger: () => void;
  isActive: () => boolean;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError';
}

function hasVisibilityApi(): boolean {
  return typeof document !== 'undefined'
    && typeof document.addEventListener === 'function'
    && typeof document.removeEventListener === 'function';
}

function isDocumentHidden(): boolean {
  return hasVisibilityApi() && document.visibilityState === 'hidden';
}

export function startSmartPollLoop(
  poll: (ctx: SmartPollContext) => Promise<boolean | void> | boolean | void,
  opts: SmartPollOptions,
): SmartPollLoopHandle {
  const intervalMs = Math.max(1_000, Math.round(opts.intervalMs));
  const hiddenMultiplier = Math.max(1, opts.hiddenMultiplier ?? 10);
  const pauseWhenHidden = opts.pauseWhenHidden ?? false;
  const refreshOnVisible = opts.refreshOnVisible ?? true;
  const runImmediately = opts.runImmediately ?? false;
  const shouldRun = opts.shouldRun;
  const onError = opts.onError;
  const maxBackoffMultiplier = Math.max(1, opts.maxBackoffMultiplier ?? 4);
  const jitterFraction = Math.max(0, opts.jitterFraction ?? 0.1);
  const minIntervalMs = Math.max(250, opts.minIntervalMs ?? 1_000);
  const hiddenIntervalMs = opts.hiddenIntervalMs !== undefined
    ? Math.max(minIntervalMs, Math.round(opts.hiddenIntervalMs))
    : undefined;

  const visibilityDebounceMs = Math.max(0, opts.visibilityDebounceMs ?? 300);

  let active = true;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let visibilityDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let backoffMultiplier = 1;
  let activeController: AbortController | null = null;

  const clearTimer = () => {
    if (!timerId) return;
    clearTimeout(timerId);
    timerId = null;
  };

  const baseDelayMs = (hidden: boolean): number | null => {
    if (hidden) {
      if (pauseWhenHidden) return null;
      return hiddenIntervalMs ?? (intervalMs * hiddenMultiplier);
    }
    return intervalMs * backoffMultiplier;
  };

  const computeDelay = (baseMs: number): number => {
    const jitterRange = baseMs * jitterFraction;
    const jittered = baseMs + ((Math.random() * 2 - 1) * jitterRange);
    return Math.max(minIntervalMs, Math.round(jittered));
  };

  const scheduleNext = () => {
    if (!active) return;
    clearTimer();
    const base = baseDelayMs(isDocumentHidden());
    if (base === null) return;
    timerId = setTimeout(() => {
      timerId = null;
      void runOnce('interval');
    }, computeDelay(base));
  };

  const runOnce = async (reason: SmartPollReason): Promise<void> => {
    if (!active) return;

    const hidden = isDocumentHidden();
    if (hidden && pauseWhenHidden) {
      scheduleNext();
      return;
    }
    if (shouldRun && !shouldRun()) {
      scheduleNext();
      return;
    }
    if (inFlight) {
      scheduleNext();
      return;
    }

    inFlight = true;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    activeController = controller;

    try {
      const result = await poll({
        signal: controller?.signal,
        reason,
        isHidden: hidden,
      });

      if (result === false) {
        backoffMultiplier = Math.min(backoffMultiplier * 2, maxBackoffMultiplier);
      } else {
        backoffMultiplier = 1;
      }
    } catch (error) {
      if (!controller?.signal.aborted && !isAbortError(error)) {
        backoffMultiplier = Math.min(backoffMultiplier * 2, maxBackoffMultiplier);
        if (onError) onError(error);
      }
    } finally {
      if (activeController === controller) activeController = null;
      inFlight = false;
      scheduleNext();
    }
  };

  const clearVisibilityDebounce = () => {
    if (visibilityDebounceTimer) {
      clearTimeout(visibilityDebounceTimer);
      visibilityDebounceTimer = null;
    }
  };

  const handleVisibilityChange = () => {
    if (!active) return;
    const hidden = isDocumentHidden();

    if (hidden) {
      if (pauseWhenHidden) {
        clearTimer();
        activeController?.abort();
        return;
      }
      scheduleNext();
      return;
    }

    if (refreshOnVisible) {
      clearTimer();
      void runOnce('resume');
      return;
    }

    scheduleNext();
  };

  const onVisibilityChange = () => {
    if (!active) return;
    // Debounce rapid visibility toggles (e.g. fast alt-tab) to prevent
    // request bursts. Hidden→pause is applied immediately so we don't
    // keep polling after the tab disappears.
    if (visibilityDebounceMs > 0 && !isDocumentHidden()) {
      clearVisibilityDebounce();
      visibilityDebounceTimer = setTimeout(handleVisibilityChange, visibilityDebounceMs);
      return;
    }
    handleVisibilityChange();
  };

  let unsubVisibility: (() => void) | null = null;
  if (opts.visibilityHub) {
    unsubVisibility = opts.visibilityHub.subscribe(onVisibilityChange);
  } else if (hasVisibilityApi()) {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  if (runImmediately) {
    void runOnce('startup');
  } else {
    scheduleNext();
  }

  return {
    stop: () => {
      if (!active) return;
      active = false;
      clearTimer();
      clearVisibilityDebounce();
      activeController?.abort();
      activeController = null;
      if (unsubVisibility) {
        unsubVisibility();
        unsubVisibility = null;
      } else if (hasVisibilityApi()) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    },
    trigger: () => {
      if (!active) return;
      clearTimer();
      void runOnce('manual');
    },
    isActive: () => active,
  };
}

export async function waitForSidecarReady(timeoutMs = 3000): Promise<boolean> {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return false;
  const pollInterval = 200;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/service-status`, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      // sidecar not ready yet
    }
    await sleep(pollInterval);
  }
  return false;
}

function isLocalOnlyApiTarget(target: string): boolean {
  // Security boundary: endpoints that can carry local secrets must use the
  // `/api/local-*` prefix so cloud fallback is automatically blocked.
  return target.startsWith('/api/local-');
}

function isKeyFreeApiTarget(target: string): boolean {
  return target.startsWith('/api/register-interest') || target.startsWith('/api/version');
}

async function fetchLocalWithStartupRetry(
  nativeFetch: typeof window.fetch,
  localUrl: string,
  init?: RequestInit,
): Promise<Response> {
  const maxAttempts = 4;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await nativeFetch(localUrl, init);
    } catch (error) {
      lastError = error;

      // Preserve caller intent for aborted requests.
      if (init?.signal?.aborted) {
        throw error;
      }

      if (attempt === maxAttempts) {
        break;
      }

      await sleep(125 * attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Local API unavailable');
}

// ── Security threat model for the fetch patch ──────────────────────────
// The LOCAL_API_TOKEN exists to prevent OTHER local processes from
// accessing the sidecar on port 46123. The renderer IS the intended
// client — injecting the token automatically is correct by design.
//
// If the renderer is compromised (XSS, supply chain), the attacker
// already has access to strictly more powerful Tauri IPC commands
// (get_all_secrets, set_secret, etc.) via window.__TAURI_INTERNALS__.
// The fetch patch does not expand the attack surface beyond what IPC
// already provides.
//
// Defense layers that protect the renderer trust boundary:
//   1. CSP: script-src 'self' (no unsafe-inline/eval)
//   2. IPC origin validation: sensitive commands gated to trusted windows
//   3. Sidecar allowlists: env-update restricted to ALLOWED_ENV_KEYS
//   4. DevTools disabled in production builds
//
// The token has a 5-minute TTL in the closure to limit exposure window
// if IPC access is revoked mid-session.
const TOKEN_TTL_MS = 5 * 60 * 1000;

export function installRuntimeFetchPatch(): void {
  if (!isDesktopRuntime() || typeof window === 'undefined' || (window as unknown as Record<string, unknown>).__wmFetchPatched) {
    return;
  }

  const nativeFetch = window.fetch.bind(window);
  let localApiToken: string | null = null;
  let tokenFetchedAt = 0;
  let authRetryCooldownUntil = 0; // suppress 401 retries after consecutive failures

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = getApiTargetFromRequestInput(input);
    const debug = localStorage.getItem('wm-debug-log') === '1';

    if (!target?.startsWith('/api/')) {
      if (debug) {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        console.log(`[fetch] passthrough → ${raw.slice(0, 120)}`);
      }
      return nativeFetch(input, init);
    }

    // Resolve dynamic sidecar port on first API call
    if (_resolvedPort === null) {
      try { await resolveLocalApiPort(); } catch { /* use default */ }
    }

    const tokenExpired = localApiToken && (Date.now() - tokenFetchedAt > TOKEN_TTL_MS);
    if (!localApiToken || tokenExpired) {
      try {
        const { tryInvokeTauri } = await import('@/services/tauri-bridge');
        localApiToken = await tryInvokeTauri<string>('get_local_api_token');
        tokenFetchedAt = Date.now();
      } catch {
        localApiToken = null;
        tokenFetchedAt = 0;
      }
    }

    const headers = new Headers(init?.headers);
    if (localApiToken) {
      headers.set('Authorization', `Bearer ${localApiToken}`);
    }
    const localInit = { ...init, headers };

    const localUrl = `${getApiBaseUrl()}${target}`;
    if (debug) console.log(`[fetch] intercept → ${target}`);
    let allowCloudFallback = !isLocalOnlyApiTarget(target);

    if (allowCloudFallback && !isKeyFreeApiTarget(target)) {
      try {
        const { getSecretState, secretsReady } = await import('@/services/runtime-config');
        await Promise.race([secretsReady, new Promise<void>(r => setTimeout(r, 2000))]);
        const wmKeyState = getSecretState('WORLDMONITOR_API_KEY');
        if (!wmKeyState.present || !wmKeyState.valid) {
          allowCloudFallback = false;
        }
      } catch {
        allowCloudFallback = false;
      }
    }

    const cloudFallback = async () => {
      if (!allowCloudFallback) {
        throw new Error(`Cloud fallback blocked for ${target}`);
      }
      const cloudUrl = `${getRemoteApiBaseUrl()}${target}`;
      if (debug) console.log(`[fetch] cloud fallback → ${cloudUrl}`);
      const cloudHeaders = new Headers(init?.headers);
      if (KEYED_CLOUD_API_PATTERN.test(target)) {
        const { getRuntimeConfigSnapshot } = await import('@/services/runtime-config');
        const wmKeyValue = getRuntimeConfigSnapshot().secrets['WORLDMONITOR_API_KEY']?.value;
        if (wmKeyValue) {
          cloudHeaders.set('X-WorldMonitor-Key', wmKeyValue);
        }
      }
      return nativeFetch(cloudUrl, { ...init, headers: cloudHeaders });
    };

    try {
      const t0 = performance.now();
      let response = await fetchLocalWithStartupRetry(nativeFetch, localUrl, localInit);
      if (debug) console.log(`[fetch] ${target} → ${response.status} (${Math.round(performance.now() - t0)}ms)`);

      // Token may be stale after a sidecar restart — refresh and retry once.
      // Skip retry if we recently failed (avoid doubling every request during auth outages).
      if (response.status === 401 && localApiToken && Date.now() > authRetryCooldownUntil) {
        if (debug) console.log(`[fetch] 401 from sidecar, refreshing token and retrying`);
        try {
          const { tryInvokeTauri } = await import('@/services/tauri-bridge');
          localApiToken = await tryInvokeTauri<string>('get_local_api_token');
          tokenFetchedAt = Date.now();
        } catch {
          localApiToken = null;
          tokenFetchedAt = 0;
        }
        if (localApiToken) {
          const retryHeaders = new Headers(init?.headers);
          retryHeaders.set('Authorization', `Bearer ${localApiToken}`);
          response = await fetchLocalWithStartupRetry(nativeFetch, localUrl, { ...init, headers: retryHeaders });
          if (debug) console.log(`[fetch] retry ${target} → ${response.status}`);
          if (response.status === 401) {
            authRetryCooldownUntil = Date.now() + 60_000;
            if (debug) console.log(`[fetch] auth retry failed, suppressing retries for 60s`);
          } else {
            authRetryCooldownUntil = 0;
          }
        }
      }

      if (!response.ok) {
        if (!allowCloudFallback) {
          if (debug) console.log(`[fetch] local-only endpoint ${target} returned ${response.status}; skipping cloud fallback`);
          return response;
        }
        if (debug) console.log(`[fetch] local ${response.status}, falling back to cloud`);
        return cloudFallback();
      }
      return response;
    } catch (error) {
      if (debug) console.warn(`[runtime] Local API unavailable for ${target}`, error);
      if (!allowCloudFallback) {
        throw error;
      }
      return cloudFallback();
    }
  };

  (window as unknown as Record<string, unknown>).__wmFetchPatched = true;
}

const ALLOWED_REDIRECT_HOSTS = /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*worldmonitor\.app(:\d+)?$/;

function isAllowedRedirectTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_REDIRECT_HOSTS.test(parsed.origin) || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

export function installWebApiRedirect(): void {
  if (isDesktopRuntime() || typeof window === 'undefined') return;
  const apiBase = getConfiguredWebApiBaseUrl();
  if (!apiBase) return;
  if (!isAllowedRedirectTarget(apiBase)) {
    console.warn('[runtime] web API base blocked — not in hostname allowlist:', apiBase);
    return;
  }
  if ((window as unknown as Record<string, unknown>).__wmWebRedirectPatched) return;

  const nativeFetch = window.fetch.bind(window);
  const API_BASE = apiBase;
  const shouldRedirectPath = (pathWithQuery: string): boolean => pathWithQuery.startsWith('/api/');
  const shouldFallbackToOrigin = (status: number): boolean => (
    status === 404 || status === 405 || status === 501 || status === 502 || status === 503
  );
  const fetchWithRedirectFallback = async (
    redirectedInput: RequestInfo | URL,
    originalInput: RequestInfo | URL,
    originalInit?: RequestInit,
  ): Promise<Response> => {
    try {
      const redirectedResponse = await nativeFetch(redirectedInput, originalInit);
      if (!shouldFallbackToOrigin(redirectedResponse.status)) return redirectedResponse;
      return nativeFetch(originalInput, originalInit);
    } catch (error) {
      try {
        return await nativeFetch(originalInput, originalInit);
      } catch {
        throw error;
      }
    }
  };

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' && shouldRedirectPath(input)) {
      return fetchWithRedirectFallback(`${API_BASE}${input}`, input, init);
    }
    if (input instanceof URL && input.origin === window.location.origin && shouldRedirectPath(`${input.pathname}${input.search}`)) {
      return fetchWithRedirectFallback(new URL(`${API_BASE}${input.pathname}${input.search}`), input, init);
    }
    if (input instanceof Request) {
      const u = new URL(input.url);
      if (u.origin === window.location.origin && shouldRedirectPath(`${u.pathname}${u.search}`)) {
        return fetchWithRedirectFallback(
          new Request(`${API_BASE}${u.pathname}${u.search}`, input),
          input.clone(),
          init,
        );
      }
    }
    return nativeFetch(input, init);
  };

  (window as unknown as Record<string, unknown>).__wmWebRedirectPatched = true;
}
