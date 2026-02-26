const DEFAULT_REMOTE_HOSTS: Record<string, string> = {
  tech: 'https://tech.worldmonitor.app',
  full: 'https://worldmonitor.app',
  world: 'https://worldmonitor.app',
};

const DEFAULT_LOCAL_API_PORT = 46123;
const FORCE_DESKTOP_RUNTIME = import.meta.env.VITE_DESKTOP_RUNTIME === '1';

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

  const configuredBaseUrl = import.meta.env.VITE_TAURI_API_BASE_URL;
  if (configuredBaseUrl) {
    return normalizeBaseUrl(configuredBaseUrl);
  }

  return `http://127.0.0.1:${getLocalApiPort()}`;
}

export function getRemoteApiBaseUrl(): string {
  const configuredRemoteBase = import.meta.env.VITE_TAURI_REMOTE_API_BASE_URL;
  if (configuredRemoteBase) {
    return normalizeBaseUrl(configuredRemoteBase);
  }

  const variant = import.meta.env.VITE_VARIANT || 'full';
  return DEFAULT_REMOTE_HOSTS[variant] ?? DEFAULT_REMOTE_HOSTS.full ?? 'https://worldmonitor.app';
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

const APP_HOSTS = new Set([
  'worldmonitor.app',
  'www.worldmonitor.app',
  'tech.worldmonitor.app',
  'localhost',
  '127.0.0.1',
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

function isLocalOnlyApiTarget(target: string): boolean {
  // Security boundary: endpoints that can carry local secrets must use the
  // `/api/local-*` prefix so cloud fallback is automatically blocked.
  return target.startsWith('/api/local-');
}

function isKeyFreeApiTarget(target: string): boolean {
  return target.startsWith('/api/register-interest');
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
      if (/^\/api\/[^/]+\/v1\//.test(target)) {
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
      if (response.status === 401 && localApiToken) {
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
