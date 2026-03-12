/**
 * ACLED OAuth token manager with automatic refresh.
 *
 * ACLED switched to OAuth tokens that expire every 24 hours.
 * This module handles the token lifecycle:
 *
 *   1. If ACLED_EMAIL + ACLED_PASSWORD are set → exchange for an OAuth
 *      access token (24 h) + refresh token (14 d), cache in Redis,
 *      and auto-refresh before expiry.
 *
 *   2. If only ACLED_ACCESS_TOKEN is set → use the static token as-is
 *      (backward-compatible, but will expire after 24 h).
 *
 *   3. If neither is set → return null (graceful degradation).
 *
 * See: https://acleddata.com/api-documentation/getting-started
 * Fixes: https://github.com/koala73/worldmonitor/issues/1283
 */

import { CHROME_UA } from './constants';
import { getCachedJson, setCachedJson } from './redis';

const ACLED_TOKEN_URL = 'https://acleddata.com/oauth/token';
const ACLED_CLIENT_ID = 'acled';

/** Refresh 5 minutes before the token actually expires. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** Redis cache key for the ACLED OAuth token state. */
const REDIS_CACHE_KEY = 'acled:oauth:token';

/** Cache token in Redis for 23 hours (token lasts 24 h, minus margin). */
const REDIS_TTL_SECONDS = 23 * 60 * 60;

interface TokenState {
  accessToken: string;
  refreshToken: string;
  /** Absolute timestamp (ms) when the access token expires. */
  expiresAt: number;
}

/**
 * In-memory fast-path cache.
 * Acts as L1 cache; Redis is L2 and survives Vercel Edge cold starts.
 */
let memCached: TokenState | null = null;
let refreshPromise: Promise<string | null> | null = null;

/**
 * Exchange ACLED credentials for an OAuth token pair.
 */
async function exchangeCredentials(
  email: string,
  password: string,
): Promise<TokenState> {
  const body = new URLSearchParams({
    username: email,
    password,
    grant_type: 'password',
    client_id: ACLED_CLIENT_ID,
  });

  const resp = await fetch(ACLED_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': CHROME_UA,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `ACLED OAuth token exchange failed (${resp.status}): ${text.slice(0, 200)}`,
    );
  }

  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token || !data.refresh_token) {
    throw new Error('ACLED OAuth response missing access_token or refresh_token');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 86_400) * 1000,
  };
}

/**
 * Use a refresh token to obtain a new access token.
 */
async function refreshAccessToken(refreshToken: string): Promise<TokenState> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    client_id: ACLED_CLIENT_ID,
  });

  const resp = await fetch(ACLED_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': CHROME_UA,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `ACLED OAuth token refresh failed (${resp.status}): ${text.slice(0, 200)}`,
    );
  }

  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error('ACLED OAuth refresh response missing access_token');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 86_400) * 1000,
  };
}

/**
 * Persist token state to Redis so it survives Vercel Edge cold starts.
 */
async function cacheToRedis(state: TokenState): Promise<void> {
  try {
    await setCachedJson(REDIS_CACHE_KEY, state, REDIS_TTL_SECONDS);
  } catch (err) {
    console.warn('[acled-auth] Failed to cache token in Redis', err);
  }
}

/**
 * Restore token state from Redis (L2 cache for cold starts).
 */
async function restoreFromRedis(): Promise<TokenState | null> {
  try {
    const data = await getCachedJson(REDIS_CACHE_KEY);
    if (
      data &&
      typeof data === 'object' &&
      'accessToken' in (data as Record<string, unknown>) &&
      'refreshToken' in (data as Record<string, unknown>) &&
      'expiresAt' in (data as Record<string, unknown>)
    ) {
      return data as TokenState;
    }
  } catch (err) {
    console.warn('[acled-auth] Failed to restore token from Redis', err);
  }
  return null;
}

/**
 * Returns a valid ACLED access token, refreshing if necessary.
 *
 * Priority:
 *   1. ACLED_EMAIL + ACLED_PASSWORD → OAuth flow with auto-refresh
 *   2. ACLED_ACCESS_TOKEN          → static token (legacy)
 *   3. Neither                     → null
 *
 * Caching:
 *   L1: In-memory `memCached` (fast-path within same isolate)
 *   L2: Redis via `getCachedJson`/`setCachedJson` (survives cold starts)
 */
export async function getAcledAccessToken(): Promise<string | null> {
  const email = process.env.ACLED_EMAIL?.trim();
  const password = process.env.ACLED_PASSWORD?.trim();

  // -- OAuth flow --
  if (email && password) {
    // L1: Return in-memory token if still fresh.
    if (memCached && Date.now() < memCached.expiresAt - EXPIRY_MARGIN_MS) {
      return memCached.accessToken;
    }

    // L2: Try Redis (survives Vercel Edge cold starts).
    // Also check L2 when L1 is expired, in case another isolate wrote a fresher token.
    if (!memCached || Date.now() >= memCached.expiresAt - EXPIRY_MARGIN_MS) {
      const fromRedis = await restoreFromRedis();
      if (fromRedis && Date.now() < fromRedis.expiresAt - EXPIRY_MARGIN_MS) {
        memCached = fromRedis;
        return memCached.accessToken;
      }
      // If Redis had a token but it's near-expiry, keep it for fallback.
      if (fromRedis) memCached = fromRedis;
    }

    // Deduplicate concurrent refresh attempts.
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      try {
        // Try refreshing with the existing refresh token first.
        if (memCached?.refreshToken) {
          try {
            memCached = await refreshAccessToken(memCached.refreshToken);
            await cacheToRedis(memCached);
            return memCached.accessToken;
          } catch (refreshErr) {
            console.warn('[acled-auth] Refresh token expired, re-authenticating', refreshErr);
          }
        }

        // Full re-authentication with email/password.
        memCached = await exchangeCredentials(email, password);
        await cacheToRedis(memCached);
        return memCached.accessToken;
      } catch (err) {
        console.error('[acled-auth] Failed to obtain ACLED access token', err);
        // If we still have a cached token (even if near-expiry), try using it.
        return memCached?.accessToken ?? null;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  }

  // -- Static token fallback (legacy) --
  const staticToken = process.env.ACLED_ACCESS_TOKEN?.trim();
  return staticToken || null;
}
