/**
 * Shared ConvexClient singleton for frontend services.
 *
 * Both the entitlement subscription and the checkout service need a
 * ConvexClient instance. This module provides a single lazy-loaded
 * client to avoid duplicate WebSocket connections.
 *
 * The client and API reference are loaded via dynamic import so they
 * don't impact the initial bundle size.
 */

import type { ConvexClient } from 'convex/browser';
import { getClerkToken, clearClerkTokenCache, getCurrentClerkUser } from './clerk';

// Use typeof to get the exact generated API type without importing statically
type ConvexApi = typeof import('../../convex/_generated/api').api;

let client: ConvexClient | null = null;
let apiRef: ConvexApi | null = null;
let authReadyResolve: (() => void) | null = null;
let authReadyPromise: Promise<void> | null = null;

// Per-Clerk-userId trigger for users:ensureRecord. The boolean flag is
// per-app-lifetime; the userId guard is per-user. Sign-out clears the
// userId so a different user signing in re-fires. Same-user repeat
// auth-ready (token refresh, hot reload after WS reconnect) is a no-op.
let lastEnsuredUserId: string | null = null;
let ensureRecordInFlight = false;

/**
 * Returns the shared ConvexClient instance, creating it on first call.
 * Returns null if VITE_CONVEX_URL is not configured.
 */
export async function getConvexClient(): Promise<ConvexClient | null> {
  if (client) return client;

  const convexUrl = import.meta.env.VITE_CONVEX_URL;
  if (!convexUrl) return null;

  authReadyPromise = new Promise<void>((resolve) => { authReadyResolve = resolve; });

  const { ConvexClient: CC } = await import('convex/browser');
  try {
    client = new CC(convexUrl);
  } catch (err) {
    // Firefox 149/Linux has been observed to reject the Convex constructor with
    // "t is not a constructor" (WORLDMONITOR-N0/MX). Degrade to the null-client
    // path instead of letting init error-bubble into Sentry — subscription features
    // silently no-op, which matches the behavior when VITE_CONVEX_URL is unset.
    // Also reset authReadyPromise: it was just created at the top of this function
    // and would otherwise leave waitForConvexAuth() blocking for the full timeout
    // for any future caller that doesn't pre-check the client is non-null.
    console.warn('[convex-client] ConvexClient constructor rejected:', (err as Error).message);
    authReadyPromise = null;
    authReadyResolve = null;
    return null;
  }
  client.setAuth(
    async ({ forceRefreshToken }: { forceRefreshToken?: boolean } = {}) => {
      if (forceRefreshToken) {
        clearClerkTokenCache();
      }
      return getClerkToken();
    },
    (isAuthenticated: boolean) => {
      if (isAuthenticated) {
        if (authReadyResolve) {
          authReadyResolve();
          authReadyResolve = null;
        }
        // Fire-and-forget: capture locale/timezone/country for this user.
        // Failure must not break the auth path. See callEnsureRecord docstring.
        if (client) void callEnsureRecord(client);
      } else {
        // Sign-out or token expiry: reset the promise so the next
        // waitForConvexAuth() blocks until re-authentication completes.
        authReadyPromise = new Promise<void>((resolve) => { authReadyResolve = resolve; });
        // Clear the ensureRecord flag so a subsequent sign-in (same OR
        // different user) re-fires. Cheap and safe; same-user re-sign-in
        // just rewrites the same data.
        lastEnsuredUserId = null;
      }
    },
  );
  return client;
}

/**
 * Send the authenticated user's locale, timezone, and approximate country
 * to Convex on first session. Fire-and-forget — never throws to the auth
 * path. Idempotent per Clerk userId for the lifetime of this client
 * singleton.
 *
 * Failure modes:
 * - Validation rejected by server → warn-log, leave flag unset (retries
 *   on next sign-in / page load with a possibly-different value).
 * - Network / WebSocket error → same.
 * - Concurrent fire (e.g., token refresh storm) → ensureRecordInFlight
 *   guard short-circuits the second call.
 */
async function callEnsureRecord(c: ConvexClient): Promise<void> {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') {
    // Non-browser env (Vitest in node, Tauri sidecar, etc.). No-op.
    return;
  }

  const user = getCurrentClerkUser();
  if (!user) return;
  const userId = user.id;
  if (userId === lastEnsuredUserId) return;
  if (ensureRecordInFlight) return;

  ensureRecordInFlight = true;
  try {
    // Use `||` (not `??`) — empty string `''` from privacy browsers
    // (Tor, hardened Firefox) or Linux contexts with `LC_ALL=C` is not
    // nullish but IS unusable. `??` only triggers on null/undefined; `||`
    // also triggers on empty string. Without this, the client sends
    // `localePrimary: ''` to the server, which rejects with invalid-input
    // and never sets `lastEnsuredUserId` — retries forever on every page
    // load.
    let localeTag = navigator.language || 'en';
    let localePrimary = (localeTag.split('-')[0] || 'en').toLowerCase();
    // Defensive: client-side validation matching the server's regex.
    // Falls back to 'en' on non-standard input ('C', 'POSIX', extension
    // tags) so the server never rejects what we send and we never enter
    // an eternal-retry loop. Rejected by the server is observable in
    // logs; rejected by the client falls back gracefully.
    if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(localeTag) || localeTag.length > 64) {
      localeTag = 'en';
    }
    if (!/^[a-z]{2,3}$/.test(localePrimary)) {
      localePrimary = 'en';
    }

    let timezone: string | undefined;
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timezone = undefined;
    }

    // Cloudflare's `cf-ipcountry` cookie is client-readable iff the WM
    // edge has been configured to set it. Server-side authoritative
    // derivation is a v2 concern; v1 stores what the client passes for
    // analytics use only. Schema docstring marks `country` as
    // client-reported, NOT authoritative.
    let country: string | undefined;
    const cookieMatch = document.cookie.match(/(?:^|;\s*)cf-ipcountry=([A-Z]{2})/);
    if (cookieMatch?.[1]) country = cookieMatch[1];

    const api = await getConvexApi();
    if (!api) return;

    const result = await c.mutation(api.users.ensureRecord, {
      localeTag,
      localePrimary,
      timezone,
      country,
    });

    if (result?.ok === true) {
      lastEnsuredUserId = userId;
    } else {
      console.warn('[convex-client] users:ensureRecord rejected:', result);
      // Do NOT set lastEnsuredUserId so a future session retries.
    }
  } catch (err) {
    console.warn('[convex-client] users:ensureRecord threw:', (err as Error)?.message ?? err);
    // Do NOT set lastEnsuredUserId; auth path continues unaffected.
  } finally {
    ensureRecordInFlight = false;
    // Race recovery: if the current Clerk user changed during the await
    // (sign-out + different sign-in within the mutation's latency window),
    // setAuth's `isAuthenticated=true` callback for the new user will have
    // fired AND been blocked by `ensureRecordInFlight`. Re-fire here so the
    // new user's record gets created. Bounded recursion: the next call's
    // top-of-function `userId === lastEnsuredUserId` guard short-circuits
    // if they didn't actually change.
    const currentUser = getCurrentClerkUser();
    if (currentUser && currentUser.id !== userId) {
      void callEnsureRecord(c);
    }
  }
}

/**
 * Wait for ConvexClient auth to be established.
 * Resolves when the server confirms the client is authenticated.
 * Times out after 10s to prevent indefinite hangs for unauthenticated users.
 */
export async function waitForConvexAuth(timeoutMs = 10_000): Promise<boolean> {
  if (!authReadyPromise) return false;
  const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));
  const result = await Promise.race([authReadyPromise.then(() => 'ready' as const), timeout]);
  return result === 'ready';
}

/**
 * Returns the generated Convex API reference, loading it on first call.
 * Returns null if the import fails.
 */
export async function getConvexApi(): Promise<ConvexApi | null> {
  if (apiRef) return apiRef;

  const { api } = await import('../../convex/_generated/api');
  apiRef = api;
  return apiRef;
}
