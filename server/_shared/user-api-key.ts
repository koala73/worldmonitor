/**
 * Validates user-owned API keys by hashing the provided key and looking up
 * the hash in Convex via the internal HTTP action.
 *
 * Uses cachedFetchJson for Redis caching with in-flight coalescing and
 * environment-partitioned keys (no raw=true — keys are prefixed by deploy).
 */

import { cachedFetchJson, deleteRedisKey } from './redis';

interface UserKeyResult {
  userId: string;
  keyId: string;
  name: string;
}

const CACHE_TTL_SECONDS = 60; // 1 min — short to limit staleness on revocation
const NEG_TTL_SECONDS = 60;   // negative cache: avoid hammering Convex with invalid keys
const CACHE_KEY_PREFIX = 'user-api-key:';

/** SHA-256 hex digest (Web Crypto API — works in Edge Runtime). */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a user-owned API key.
 *
 * Returns the userId and key metadata if valid, or null if invalid/revoked.
 * Uses cachedFetchJson for Redis caching with request coalescing and
 * standard NEG_SENTINEL for negative results.
 */
export async function validateUserApiKey(key: string): Promise<UserKeyResult | null> {
  if (!key || !key.startsWith('wm_')) return null;

  const keyHash = await sha256Hex(key);
  const cacheKey = `${CACHE_KEY_PREFIX}${keyHash}`;

  try {
    return await cachedFetchJson<UserKeyResult>(
      cacheKey,
      CACHE_TTL_SECONDS,
      () => fetchFromConvex(keyHash),
      NEG_TTL_SECONDS,
    );
  } catch (err) {
    // Fail-soft: transient Convex/network errors degrade to unauthorized
    // rather than bubbling a 500 through the gateway or isCallerPremium.
    console.warn('[user-api-key] validateUserApiKey failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Fetch key validation from Convex internal endpoint. */
async function fetchFromConvex(keyHash: string): Promise<UserKeyResult | null> {
  const convexSiteUrl = process.env.CONVEX_SITE_URL;
  const convexSharedSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
  if (!convexSiteUrl || !convexSharedSecret) return null;

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
  return resp.json() as Promise<UserKeyResult | null>;
}

/**
 * Delete the Redis cache entry for a specific API key hash.
 * Called after revocation to ensure the key cannot be used during the TTL window.
 * Uses prefixed keys (no raw=true) matching the cache writes above.
 */
export async function invalidateApiKeyCache(keyHash: string): Promise<void> {
  await deleteRedisKey(`${CACHE_KEY_PREFIX}${keyHash}`);
}
