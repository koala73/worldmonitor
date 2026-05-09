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
// Periodic refresh cadence — wake every 30 minutes to renew before the
// 12-hour token expires. Long-lived tabs (overnight, multi-day) lose the
// token without this; the original implementation had no auto-refresh.
const PERIODIC_REFRESH_MS = 30 * 60 * 1000;

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
export function __resetWmSessionForTests(): void {
  cached = null;
  inflight = null;
  interceptorInstalled = false;
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
  // AGENTS.md bans `fetch.bind(globalThis)` to avoid freezing a stale
  // reference. The prescribed alternative `(...args) => globalThis.fetch(...)`
  // would recurse here because the very next line replaces `window.fetch`
  // with our wrapper — re-entering through `globalThis.fetch` would loop
  // forever. The correct minimal pattern that captures the pre-wrapping
  // value AND avoids `.bind()` is a plain assignment: in modern browsers
  // `fetch` is already bound to its global receiver and the unbound
  // reference works correctly when called as `original(...)`.
  const original = window.fetch;

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
    if (token) headers.set('X-WorldMonitor-Key', token);

    // A Request body is a one-shot stream — clone BEFORE the first send so
    // the refresh-on-401 retry below has an intact body to replay. For
    // string/URL inputs, body lives on `init` and Headers merging is enough.
    const requestClone = input instanceof Request ? input.clone() : null;

    const sendWith = (h: Headers, src: typeof input): Promise<Response> => {
      if (src instanceof Request) {
        const cloned = new Request(src, { headers: h });
        return original(cloned, init);
      }
      return original(src, { ...(init ?? {}), headers: h });
    };

    const resp = await sendWith(headers, input);

    // Layer 2 — refresh-on-401. A single transient blip (HMAC-key rotation,
    // expiry race, server-side cache flap) shouldn't strand the tab. If we
    // had no token to begin with OR the token we sent was rejected, mint a
    // fresh one and replay ONCE. Premium routes already returned above; the
    // wms_ token is irrelevant there.
    if (resp.status !== 401) return resp;

    // Invalidate the cached token (and its sessionStorage twin) before
    // re-minting. ensureWmSession() is opportunistic — without invalidation,
    // it would return the same not-yet-clock-expired token that the server
    // just rejected (HMAC-key rotation: token signature is wrong even though
    // `exp` is in the future), and the retry would 401 with the same header.
    if (token && cached?.token === token) {
      cached = null;
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }

    const fresh = await ensureWmSession().catch(() => null);
    // Bail if mint failed, or the "fresh" token is identical to what we just
    // sent (cache returned the same value — retry would 401 again).
    if (!fresh || fresh === token) return resp;

    const retryHeaders = new Headers(headers);
    retryHeaders.set('X-WorldMonitor-Key', fresh);
    return sendWith(retryHeaders, requestClone ?? input);
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
