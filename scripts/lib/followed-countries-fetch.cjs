'use strict';

// One-shot fetch helper for the per-user followed-countries watchlist.
//
// POSTs to the `/relay/followed-countries` HTTP action shipped in PR A
// (convex/http.ts) with a Bearer of RELAY_SHARED_SECRET. The relay
// serializes Convex's typed `internalListFollowedForUser({userId})`
// query result into `{ countries: string[] }` — no JSON-string-in-blob
// ambiguity, no shape drift through legacy userPreferences.
//
// Mirrors `scripts/lib/user-context.cjs::fetchUserPreferences` shape
// (auth, 10s timeout, defensive parse) so the digest cron can swap
// callers without learning a second pattern. Returns `string[]` on
// every soft failure mode (missing env, 4xx/5xx, transport error,
// malformed JSON, wrong shape) so the composer never has to wrap the
// call site in a try/catch — the upstream-unavailable / no-rows
// distinction is intentionally collapsed (memory:
// `upstream-unavailable-vs-empty-filter` — graceful degradation IS
// the right call here because the bias is purely a soft uplift; the
// brief still ships unchanged when the fetch silently empties).
//
// Non-string entries inside the `countries` array are filtered out
// defensively. If the Convex relay ever drifts to emit nullable / mixed
// types, the composer still gets clean `string[]` instead of a NaN
// boost path or a `.toUpperCase()` crash.

const CONVEX_SITE_URL =
  process.env.CONVEX_SITE_URL ??
  (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const RELAY_SECRET = process.env.RELAY_SHARED_SECRET ?? '';

/**
 * Fetch the userId's followed countries via the Convex relay.
 *
 * @param {string} userId
 * @returns {Promise<string[]>} ISO-2 country codes ordered by addedAt asc.
 *   Empty array on any failure path. Never throws.
 */
async function fetchFollowedCountries(userId) {
  if (!CONVEX_SITE_URL || !RELAY_SECRET) {
    console.warn('[followed-countries-fetch] CONVEX_SITE_URL or RELAY_SHARED_SECRET not set');
    return [];
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    console.warn('[followed-countries-fetch] userId required');
    return [];
  }
  try {
    const res = await fetch(`${CONVEX_SITE_URL}/relay/followed-countries`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RELAY_SECRET}`,
        'User-Agent': 'worldmonitor-relay/1.0',
      },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return [];
    if (!res.ok) {
      console.warn(`[followed-countries-fetch] HTTP ${res.status}`);
      return [];
    }
    let data;
    try {
      data = await res.json();
    } catch {
      console.warn('[followed-countries-fetch] malformed JSON response');
      return [];
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.countries)) {
      return [];
    }
    return data.countries.filter((c) => typeof c === 'string' && c.length > 0);
  } catch (err) {
    const msg = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
    console.warn(`[followed-countries-fetch] failed: ${msg}`);
    return [];
  }
}

module.exports = { fetchFollowedCountries };
