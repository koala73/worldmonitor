import { isDesktopRuntime, toApiUrl, toRuntimeUrl } from '../services/runtime';
import { getPersistentCache, setPersistentCache } from '../services/persistent-cache';

const isDev = import.meta.env.DEV;
const RESPONSE_CACHE_PREFIX = 'api-response:';
const DEFAULT_PERSISTED_RESPONSE_MAX_AGE_MS = 5 * 60 * 1000;
const PERSISTED_RESPONSE_MAX_AGE_CAP_MS = 15 * 60 * 1000;

// RSS proxy: route directly to Railway relay via Cloudflare CDN when enabled.
// Feature flag controls rollout; default off for safe staged deployment.
const RSS_DIRECT_TO_RELAY = import.meta.env.VITE_RSS_DIRECT_TO_RELAY === 'true';
const RSS_PROXY_BASE = isDev
  ? '' // Dev uses Vite's rssProxyPlugin
  : RSS_DIRECT_TO_RELAY
    ? 'https://proxy.worldmonitor.app'
    : '';

// Widget agent proxy:
//   dev       → Vite proxy /widget-agent → relay
//   desktop   → relay directly (sidecar buffers arrayBuffer() which destroys SSE streaming)
//   prod web  → /api/widget-agent (Vercel edge) → validates Clerk JWT or tester keys
//               then proxies SSE to relay with real server-side keys
const WIDGET_RELAY_BASE = 'https://proxy.worldmonitor.app';
export function widgetAgentUrl(): string {
  if (isDev) return '/widget-agent';
  if (isDesktopRuntime()) return `${WIDGET_RELAY_BASE}/widget-agent`;
  return '/api/widget-agent';
}

export function widgetAgentHealthUrl(): string {
  if (isDev) return '/widget-agent/health';
  if (isDesktopRuntime()) return `${WIDGET_RELAY_BASE}/widget-agent/health`;
  return '/api/widget-agent'; // Vercel handler: GET → relay /widget-agent/health
}

export function rssProxyUrl(feedUrl: string): string {
  if (isDesktopRuntime()) return proxyUrl(feedUrl);
  if (RSS_PROXY_BASE) {
    return `${RSS_PROXY_BASE}/rss?url=${encodeURIComponent(feedUrl)}`;
  }
  return `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
}

type CachedResponsePayload = {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
};

export function hasNoStoreCacheDirective(headers: HeadersInit): boolean {
  const cacheControl = new Headers(headers).get('cache-control');
  return cacheControl?.split(',').some((directive) => {
    const name = directive.trim().split('=', 1)[0]?.trim().toLowerCase();
    return name === 'no-store';
  }) ?? false;
}

// In production browser deployments, routes are handled by Vercel serverless functions.
// In local dev, Vite proxy handles these routes.
// In Tauri desktop mode, route requests need an absolute remote host.
export function proxyUrl(localPath: string): string {
  if (isDesktopRuntime()) {
    return toRuntimeUrl(localPath);
  }

  if (isDev) {
    return localPath;
  }

  return toApiUrl(localPath);
}

function shouldPersistResponse(url: string): boolean {
  return url.startsWith('/api/');
}

function requestPathname(url: string): string {
  if (url.startsWith('/')) return url.split('?')[0] ?? url;
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

// /api/fwdstart is a public wildcard-CORS feed. The session interceptor
// defaults credentials to 'include'; browsers then reject ACAO: *.
function proxyFetchInit(url: string, init: RequestInit = {}): RequestInit {
  return requestPathname(url) === '/api/fwdstart'
    ? { ...init, credentials: 'omit' }
    : init;
}

function buildResponseCacheKey(url: string): string {
  return `${RESPONSE_CACHE_PREFIX}${url}`;
}

function toCachedPayload(url: string, response: Response, body: string): CachedResponsePayload {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    url,
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
  };
}

function toResponse(payload: CachedResponsePayload): Response {
  return new Response(payload.body, {
    status: payload.status,
    statusText: payload.statusText,
    headers: payload.headers,
  });
}

function persistedResponseMaxAgeMs(payload: CachedResponsePayload): number {
  const cacheControl = new Headers(payload.headers).get('cache-control');
  const maxAgeMatch = cacheControl?.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i);
  if (!maxAgeMatch?.[1]) return DEFAULT_PERSISTED_RESPONSE_MAX_AGE_MS;

  const maxAgeSeconds = Number(maxAgeMatch[1]);
  if (!Number.isFinite(maxAgeSeconds)) {
    return DEFAULT_PERSISTED_RESPONSE_MAX_AGE_MS;
  }
  // Persisted responses hydrate reloads; they must not turn an upstream's long browser TTL
  // into an equally long period where old news is presented as a successful live fetch.
  return Math.min(maxAgeSeconds * 1000, PERSISTED_RESPONSE_MAX_AGE_CAP_MS);
}

function isPersistedResponseFresh(
  cached: { updatedAt: number; data: CachedResponsePayload },
  now = Date.now(),
): boolean {
  if (hasNoStoreCacheDirective(cached.data.headers)) return false;
  const ageMs = now - cached.updatedAt;
  return Number.isFinite(ageMs)
    && ageMs >= 0
    && ageMs < persistedResponseMaxAgeMs(cached.data);
}

async function fetchAndPersist(url: string): Promise<Response> {
  const response = await fetch(proxyUrl(url), proxyFetchInit(url, { cache: 'no-store' }));
  if (response.ok && shouldPersistResponse(url) && !hasNoStoreCacheDirective(response.headers)) {
    try {
      const body = await response.clone().text();
      void setPersistentCache(buildResponseCacheKey(url), toCachedPayload(url, response, body));
    } catch (error) {
      console.warn('[proxy] Failed to persist API response cache', error);
    }
  }
  return response;
}

export async function fetchWithProxy(url: string): Promise<Response> {
  if (!shouldPersistResponse(url)) {
    return fetch(proxyUrl(url), proxyFetchInit(url));
  }

  const cacheKey = buildResponseCacheKey(url);
  const cached = await getPersistentCache<CachedResponsePayload>(cacheKey);

  if (cached?.data && isPersistedResponseFresh(cached)) {
    void fetchAndPersist(url).catch((error) => {
      console.warn('[proxy] Background refresh failed for cached API response', error);
    });
    return toResponse(cached.data);
  }

  return fetchAndPersist(url);
}
