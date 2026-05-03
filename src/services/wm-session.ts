// Client-side helper for the anonymous-browser session token (issue #3541).
//
// The server's validateApiKey() (api/_api-key.js) no longer trusts header-only
// signals like Origin / Referer / Sec-Fetch-Site to authorize key-less browser
// access — every header is forgeable by curl. Anonymous browsers now mint a
// short-lived HMAC-signed token via POST /api/wm-session at boot and include
// it on subsequent API calls via the X-WorldMonitor-Key header.
//
// Two pieces:
//   1. ensureWmSession() — fetch + cache the token in sessionStorage.
//   2. installWmSessionFetchInterceptor() — patch globalThis.fetch ONCE so
//      every call to our API origin auto-gets the header. Avoids touching
//      ~50 fetch sites individually. Skipped if the caller already supplied
//      auth (Authorization, X-WorldMonitor-Key, X-Api-Key) — Bearer JWT and
//      explicit user-key paths still take precedence.

import { getCanonicalApiOrigin, toApiUrl } from './runtime';
import { PREMIUM_RPC_PATHS } from '@/shared/premium-paths';

const STORAGE_KEY = 'wm-session-token';
// Refresh well before expiry so a half-loaded page doesn't fail mid-flight.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface StoredSession {
  token: string;
  exp: number;
}

let cached: StoredSession | null = null;
let inflight: Promise<string | null> | null = null;
let interceptorInstalled = false;

function isFresh(s: StoredSession | null): s is StoredSession {
  return !!s && s.exp - REFRESH_MARGIN_MS > Date.now();
}

function loadFromStorage(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed?.token === 'string' && typeof parsed?.exp === 'number') {
      return { token: parsed.token, exp: parsed.exp };
    }
  } catch { /* ignore */ }
  return null;
}

function saveToStorage(s: StoredSession): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

async function fetchNewToken(): Promise<StoredSession | null> {
  try {
    const resp = await fetch(toApiUrl('/api/wm-session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { token?: unknown; exp?: unknown };
    if (typeof data?.token !== 'string' || typeof data?.exp !== 'number') return null;
    return { token: data.token, exp: data.exp };
  } catch {
    return null;
  }
}

export async function ensureWmSession(): Promise<string | null> {
  if (isFresh(cached)) return cached.token;
  if (inflight) return inflight;

  const stored = loadFromStorage();
  if (isFresh(stored)) {
    cached = stored;
    return cached.token;
  }

  inflight = (async () => {
    const fresh = await fetchNewToken();
    if (fresh) {
      cached = fresh;
      saveToStorage(fresh);
      return fresh.token;
    }
    return null;
  })().finally(() => { inflight = null; });

  return inflight;
}

export function getWmSessionToken(): string | null {
  if (isFresh(cached)) return cached.token;
  return null;
}

// Install a one-shot fetch wrapper that adds X-WorldMonitor-Key to API calls.
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
  const original = window.fetch.bind(window);

  window.fetch = async function wmSessionFetch(input, init) {
    const url = (() => {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      if (input instanceof Request) return input.url;
      return '';
    })();

    if (!isApiCallTarget(url, apiOrigin)) return original(input, init);

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
    if (PREMIUM_RPC_PATHS.has(path)) return original(input, init);

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
      return original(input, init);
    }

    const token = getWmSessionToken();
    if (!token) return original(input, init);

    headers.set('X-WorldMonitor-Key', token);

    // Preserve body/method/credentials/cache/redirect by cloning the Request.
    // For string/URL inputs, fold the merged headers into init.
    if (input instanceof Request) {
      const cloned = new Request(input, { headers });
      return original(cloned, init);
    }
    return original(input, { ...(init ?? {}), headers });
  };
}
