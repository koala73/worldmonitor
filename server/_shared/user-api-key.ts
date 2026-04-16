/**
 * Validates user-owned API keys by hashing the provided key and looking up
 * the hash in Convex via the internal HTTP action.
 *
 * Uses Redis as a short-lived cache to avoid hitting Convex on every request.
 * Cache entries are keyed by the SHA-256 hash of the API key (never the plaintext).
 */

import { getCachedJson, setCachedJson } from './redis';

interface UserKeyResult {
  userId: string;
  keyId: string;
  name: string;
}

const CACHE_TTL_SECONDS = 300; // 5 min

/** SHA-256 hex digest (Web Crypto API — works in Edge Runtime). */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a user-owned API key.
 *
 * Returns the userId and key metadata if valid, or null if invalid/revoked.
 * Checks Redis cache first, then falls back to Convex internal endpoint.
 */
export async function validateUserApiKey(key: string): Promise<UserKeyResult | null> {
  if (!key || !key.startsWith('wm_')) return null;

  const keyHash = await sha256Hex(key);
  const cacheKey = `user-api-key:${keyHash}`;

  // Check Redis cache
  const cached = await getCachedJson(cacheKey, true);
  if (cached === '__INVALID__') return null;
  if (cached && typeof cached === 'object') return cached as UserKeyResult;

  // Convex fallback
  const convexSiteUrl = process.env.CONVEX_SITE_URL;
  const convexSharedSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
  if (!convexSiteUrl || !convexSharedSecret) return null;

  try {
    const resp = await fetch(`${convexSiteUrl}/api/internal-validate-api-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-gateway/1.0',
        'x-convex-shared-secret': convexSharedSecret,
      },
      body: JSON.stringify({ keyHash }),
      signal: AbortSignal.timeout(3_000),
    });

    if (!resp.ok) return null;

    const result = await resp.json() as UserKeyResult | null;

    if (result) {
      await setCachedJson(cacheKey, result, CACHE_TTL_SECONDS, true);
      return result;
    }

    // Cache negative result briefly to avoid hammering Convex with invalid keys
    await setCachedJson(cacheKey, '__INVALID__', 60, true);
    return null;
  } catch (err) {
    console.warn('[user-api-key] validation failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
