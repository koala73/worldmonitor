const DEFAULT_REMOTE_HOSTS: Record<string, string> = {
  tech: 'https://tech.worldmonitor.app',
  full: 'https://worldmonitor.app',
  world: 'https://worldmonitor.app',
};

const DEFAULT_LOCAL_API_BASE = 'http://127.0.0.1:46123';
const FORCE_DESKTOP_RUNTIME = import.meta.env.VITE_DESKTOP_RUNTIME === '1';

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

  return DEFAULT_LOCAL_API_BASE;
}

export function getRemoteApiBaseUrl(): string {
  const configuredRemoteBase = import.meta.env.VITE_TAURI_REMOTE_API_BASE_URL;
  if (configuredRemoteBase) {
    return normalizeBaseUrl(configuredRemoteBase);
  }

  const variant = import.meta.env.VITE_VARIANT || 'world';
  return DEFAULT_REMOTE_HOSTS[variant] ?? DEFAULT_REMOTE_HOSTS.world ?? 'https://worldmonitor.app';
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

function getApiTargetFromRequestInput(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') {
    if (input.startsWith('/')) return input;
    try {
      const u = new URL(input);
      return `${u.pathname}${u.search}`;
    } catch {
      return null;
    }
  }

  if (input instanceof URL) {
    return `${input.pathname}${input.search}`;
  }

  try {
    const u = new URL(input.url);
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function installRuntimeFetchPatch(): void {
  if (!isDesktopRuntime() || typeof window === 'undefined' || (window as unknown as Record<string, unknown>).__wmFetchPatched) {
    return;
  }

  const nativeFetch = window.fetch.bind(window);
  const localBase = getApiBaseUrl();
  const remoteBase = getRemoteApiBaseUrl();
  let localApiToken: string | null = null;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = getApiTargetFromRequestInput(input);
    if (!target?.startsWith('/api/')) {
      return nativeFetch(input, init);
    }

    // Lazy load the local API token from the vault on the first local request
    if (isDesktopRuntime() && !localApiToken) {
      try {
        localApiToken = await tryInvokeTauri<string>('get_local_api_token');
      } catch (e) {
        console.warn('[runtime] Failed to retrieve local API token', e);
      }
    }

    const localUrl = `${localBase}${target}`;
    const remoteUrl = `${remoteBase}${target}`;

    // Prepare headers with the local API token
    const headers = new Headers(init?.headers);
    if (localApiToken) {
      headers.set('Authorization', `Bearer ${localApiToken}`);
    }
    const localInit = { ...init, headers };

    try {
      const localResponse = await fetchLocalWithStartupRetry(nativeFetch, localUrl, localInit);
      if (localResponse.ok) {
        return localResponse;
      }

      // Desktop local handlers can return 4xx/5xx when API keys are missing.
      // Prefer remote parity response when available.
      try {
        const remoteResponse = await nativeFetch(remoteUrl, init);
        if (remoteResponse.ok) {
          return remoteResponse;
        }
      } catch (remoteError) {
        console.warn(`[runtime] Remote API fallback failed for ${target}`, remoteError);
      }

      return localResponse;
    } catch (error) {
      console.warn(`[runtime] Local API fetch failed for ${target}, falling back to cloud`, error);
      return nativeFetch(remoteUrl, init);
    }
  };

  (window as unknown as Record<string, unknown>).__wmFetchPatched = true;
}
