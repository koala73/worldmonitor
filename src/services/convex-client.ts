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
type ConvexClientFactory = (url: string) => ConvexClient | Promise<ConvexClient>;

let client: ConvexClient | null = null;
let clientInitPromise: Promise<ConvexClient | null> | null = null;
let clientFactoryForTests: ConvexClientFactory | null = null;
let apiRef: ConvexApi | null = null;

interface ConvexAuthBarrier {
  generation: number;
  userId: string | null;
  promise: Promise<boolean>;
  settle: (ready: boolean) => void;
}

let authGeneration = 0;
let authBarrier: ConvexAuthBarrier | null = null;
let authRebindRequestGeneration = 0;
let forceSignedOutAuth = false;

const AUTH_REBIND_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000] as const;

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
function createAuthBarrier(
  generation: number,
  userId: string | null,
): ConvexAuthBarrier {
  let settled = false;
  let resolvePromise: (ready: boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    generation,
    userId,
    promise,
    settle: (ready) => {
      if (settled) return;
      settled = true;
      resolvePromise(ready);
    },
  };
}

/**
 * Install a fresh Convex auth configuration and return the barrier owned by
 * that exact configuration. Replacing the config pauses the SDK WebSocket
 * while it fetches a token and waits for the server's auth transition.
 */
function installConvexAuth(
  c: ConvexClient,
  userId = getCurrentClerkUser()?.id ?? null,
): ConvexAuthBarrier {
  // Release any waiter owned by the superseded identity immediately. Its
  // callback is generation-guarded below and can never settle this new barrier.
  authBarrier?.settle(false);
  const generation = ++authGeneration;
  const barrier = createAuthBarrier(generation, userId);
  authBarrier = barrier;

  c.setAuth(
    async ({ forceRefreshToken }: { forceRefreshToken?: boolean } = {}) => {
      if (forceRefreshToken) {
        clearClerkTokenCache();
      }
      return getClerkToken();
    },
    (isAuthenticated: boolean) => {
      // setAuth configs can overlap during a rapid A -> B -> C switch. A late
      // server response from A/B belongs only to its captured generation.
      if (
        generation !== authGeneration ||
        authBarrier !== barrier
      ) {
        return;
      }

      if (isAuthenticated) {
        barrier.settle(true);
        // Fire-and-forget: capture locale/timezone/country for this user.
        // Failure must not break the auth path. See callEnsureRecord docstring.
        void callEnsureRecord(c);
      } else {
        // Auth failure is terminal for this SDK config. Replace even an
        // already-confirmed barrier with a false barrier so a true -> false
        // callback pair cannot attach watches from the stale true result.
        barrier.settle(false);
        const failedBarrier = createAuthBarrier(generation, userId);
        failedBarrier.settle(false);
        authBarrier = failedBarrier;
        // Clear the ensureRecord flag so a subsequent sign-in (same OR
        // different user) re-fires. Cheap and safe; same-user re-sign-in
        // just rewrites the same data.
        lastEnsuredUserId = null;
      }
    },
  );

  return barrier;
}

function installSignedOutConvexAuth(c: ConvexClient): ConvexAuthBarrier {
  authBarrier?.settle(false);
  const generation = ++authGeneration;
  const barrier = createAuthBarrier(generation, null);
  authBarrier = barrier;

  c.setAuth(
    async () => null,
    () => {
      if (
        generation !== authGeneration ||
        authBarrier !== barrier
      ) {
        return;
      }
      // This config never supplies a credential. Treat every callback as
      // signed-out and never run authenticated-user side effects.
      barrier.settle(false);
      lastEnsuredUserId = null;
    },
  );
  return barrier;
}

async function createConvexClient(): Promise<ConvexClient | null> {
  const convexUrl = typeof import.meta.env !== 'undefined'
    ? import.meta.env.VITE_CONVEX_URL
    : undefined;
  if (!convexUrl && !clientFactoryForTests) return null;

  try {
    if (clientFactoryForTests) {
      client = await clientFactoryForTests(convexUrl ?? 'test://convex');
    } else {
      const { ConvexClient: CC } = await import('convex/browser');
      client = new CC(convexUrl!);
    }
  } catch (err) {
    // Firefox 149/Linux has been observed to reject the Convex constructor with
    // "t is not a constructor" (WORLDMONITOR-N0/MX). Degrade to the null-client
    // path instead of letting init error-bubble into Sentry — subscription features
    // silently no-op, which matches the behavior when VITE_CONVEX_URL is unset.
    console.warn('[convex-client] ConvexClient constructor rejected:', (err as Error).message);
    return null;
  }
  if (forceSignedOutAuth) {
    installSignedOutConvexAuth(client);
  } else {
    installConvexAuth(client);
  }
  return client;
}

export async function getConvexClient(): Promise<ConvexClient | null> {
  if (client) return client;
  if (clientInitPromise) return clientInitPromise;

  clientInitPromise = createConvexClient();
  try {
    return await clientInitPromise;
  } finally {
    clientInitPromise = null;
  }
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
  const barrier = authBarrier;
  if (!barrier) return false;

  return waitForAuthBarrier(barrier, timeoutMs);
}

/**
 * Wait for the exact Clerk user that initiated an account-bound operation.
 *
 * ConvexClient is shared across account switches. A plain auth wait can be
 * superseded by another user's `setAuth`, so callers that mutate or reveal
 * user-scoped data must capture their initiating user ID before any await and
 * use this identity-bound gate immediately before the client operation.
 */
export async function waitForConvexAuthForUser(
  userId: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const barrier = authBarrier;
  if (
    !barrier ||
    barrier.userId !== userId ||
    getCurrentClerkUser()?.id !== userId
  ) {
    return false;
  }

  const ready = await waitForAuthBarrier(barrier, timeoutMs);
  return (
    ready &&
    authBarrier === barrier &&
    barrier.userId === userId &&
    getCurrentClerkUser()?.id === userId
  );
}

async function waitForAuthBarrier(
  barrier: ConvexAuthBarrier,
  timeoutMs: number,
): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<boolean>((resolve) => {
    timeoutId = setTimeout(() => resolve(false), timeoutMs);
  });
  const ready = await Promise.race([barrier.promise, timeout]);
  if (timeoutId !== null) clearTimeout(timeoutId);
  return (
    ready &&
    barrier.generation === authGeneration &&
    authBarrier === barrier
  );
}

/**
 * Rebind the singleton WebSocket to the Clerk identity that is current now.
 *
 * Clearing Clerk's cache invalidates both cached and in-flight tokens from the
 * previous user. Repeating setAuth makes the Convex SDK pause the socket, fetch
 * that current token, and wait for server confirmation. Each call owns a new
 * generation, so an older callback cannot satisfy a newer user's barrier.
 */
async function startConvexAuthRebind(
  isCurrent?: () => boolean,
): Promise<ConvexAuthBarrier | null> {
  // This must precede the first await. App starts the rebind before cloud-prefs
  // work so both consumers can safely share the new user's subsequent token
  // fetch; clearing again after an await would invalidate that in-flight token.
  const requestGeneration = ++authRebindRequestGeneration;
  const userId = getCurrentClerkUser()?.id ?? null;
  forceSignedOutAuth = false;
  clearClerkTokenCache();
  try {
    const c = await getConvexClient();
    if (!c) return null;
    if (
      requestGeneration !== authRebindRequestGeneration ||
      (isCurrent && !isCurrent()) ||
      (userId !== null && getCurrentClerkUser()?.id !== userId)
    ) {
      return null;
    }

    return installConvexAuth(c, userId);
  } catch (err) {
    console.warn('[convex-client] Auth rebind failed:', (err as Error)?.message ?? err);
    return null;
  }
}

/**
 * Complete a user-switch auth handoff before attaching user-scoped watches.
 * `isCurrent` also covers sign-out, which does not need another setAuth call
 * but must still invalidate an in-flight watch attachment.
 */
export async function rebindConvexAuthForWatchHandoff(
  isCurrent: () => boolean,
  attachWatches: () => void,
  timeoutMs = 10_000,
  retryDelaysMs: readonly number[] = AUTH_REBIND_RETRY_DELAYS_MS,
): Promise<boolean> {
  let attached = false;
  const attachIfCurrent = (barrier: ConvexAuthBarrier): boolean => {
    if (attached) return true;
    if (
      authBarrier !== barrier ||
      barrier.generation !== authGeneration ||
      !isCurrent()
    ) {
      return false;
    }
    attached = true;
    attachWatches();
    return true;
  };

  for (let attempt = 0; isCurrent(); attempt += 1) {
    const barrier = await startConvexAuthRebind(isCurrent);
    if (!barrier) return false;

    const ready = await waitForAuthBarrier(barrier, timeoutMs);
    if (ready) return attachIfCurrent(barrier);
    if (!isCurrent()) return false;

    // A slow/offline handshake may confirm just after the bounded wait. Keep a
    // generation-scoped continuation so watches attach promptly while the
    // bounded retry delay runs.
    if (authBarrier === barrier) {
      void barrier.promise.then((lateReady) => {
        if (lateReady) attachIfCurrent(barrier);
      }).catch((err: unknown) => {
        console.warn('[convex-client] Late auth handoff failed:', (err as Error)?.message ?? err);
      });
    }

    const retryDelayMs = retryDelaysMs[attempt];
    if (retryDelayMs === undefined) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, retryDelayMs);
    });
    if (attached) return true;
  }
  return false;
}

/**
 * Invalidate every previous-user credential as soon as Clerk reports sign-out.
 *
 * Clearing the WebSocket identity and installing a fresh null-token config
 * prevents both cached HTTP JWT reuse and late prior-generation Convex auth.
 */
export function invalidateConvexAuthForSignOut(): void {
  forceSignedOutAuth = true;
  clearClerkTokenCache();
  authRebindRequestGeneration++;
  authBarrier?.settle(false);
  authBarrier = null;
  authGeneration++;
  lastEnsuredUserId = null;
  ensureRecordInFlight = false;

  if (!client) return;
  try {
    // setAuth synchronously resets the SDK auth manager and pauses its socket;
    // this dedicated config can only return null, so the departing Clerk
    // session can never be fetched again during the transition.
    installSignedOutConvexAuth(client);
  } catch (err) {
    console.warn('[convex-client] Failed to install signed-out auth config:', (err as Error)?.message ?? err);
  }
}

/**
 * Install a structural Convex auth client for focused node tests.
 * Production callers must never use this hook.
 */
export function __setConvexClientForTests(
  testClient: Pick<ConvexClient, 'setAuth'> | null,
): void {
  authBarrier?.settle(false);
  authBarrier = null;
  authGeneration = 0;
  authRebindRequestGeneration = 0;
  forceSignedOutAuth = false;
  clientInitPromise = null;
  client = testClient as ConvexClient | null;
  apiRef = null;
  lastEnsuredUserId = null;
  ensureRecordInFlight = false;
  if (client) installConvexAuth(client);
}

/** Inject a cold-start client factory for singleton serialization tests. */
export function __setConvexClientFactoryForTests(
  factory: ConvexClientFactory | null,
): void {
  __setConvexClientForTests(null);
  clientFactoryForTests = factory;
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
