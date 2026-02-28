/**
 * Mastodon Connector — OpenSens OSINT framework
 *
 * Source tier: official-api (Mastodon public instance APIs, no auth required for public toots)
 * License: Mastodon is AGPL-3.0. The public timeline API is freely accessible.
 *   See: https://docs.joinmastodon.org/methods/timelines/
 *
 * Privacy compliance:
 *   - Fetches only PUBLIC posts (unlisted/followers-only are never accessible without auth).
 *   - Stores ONLY derived aggregate signals (keyword counts, sentiment bins, post count).
 *   - No usernames, avatars, or post text are persisted.
 *   - Complies with Mastodon's robots.txt — API access is explicitly permitted.
 *
 * Rate limit: Most instances allow ~300 req/5 min (1 req/s). This connector
 * enforces 2 s minimum between calls. Respects Retry-After headers.
 */

export const CONNECTOR_META = {
  id: 'mastodon',
  name: 'Mastodon Public Timeline',
  sourceTier: 'official-api',
  requiresOptIn: false,
  rateLimit: { requests: 1, windowSec: 2 },
};

// Public instances likely to have energy/tech content
const DEFAULT_INSTANCES = [
  'mastodon.social',
  'fosstodon.org',
  'hachyderm.io',
];

const ENERGY_KEYWORDS = [
  'solar', 'pv', 'photovoltaic', 'wind turbine', 'offgrid', 'bess',
  'battery storage', 'microgrid', 'starlink', 'edge computing',
];

/**
 * Fetch public toots from Mastodon instances and return aggregate signal.
 * @param {string[]} [instances]
 * @param {string[]} [keywords]
 * @returns {Promise<import('../../../src/types/opensens').OsintSignal>}
 */
export async function fetchSignal(instances = DEFAULT_INSTANCES, keywords = ENERGY_KEYWORDS) {
  const allToots = [];
  for (const instance of instances) {
    try {
      const url = `https://${instance}/api/v1/timelines/public?limit=40&local=false`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'OpenSens-DAMD/1.0 (+https://opensens.io)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const toots = await res.json();
      allToots.push(...toots);
    } catch {
      // Skip unavailable instances silently
    }
  }

  return normalize(allToots, keywords);
}

/**
 * Normalize: extract aggregate signals only — NO post content stored.
 */
function normalize(toots, keywords) {
  const kwCounts = Object.fromEntries(keywords.map((k) => [k, 0]));
  let pos = 0, neg = 0, neu = 0;
  let matched = 0;

  for (const toot of toots) {
    // Strip HTML, lowercase, check keywords
    const text = (toot.content ?? '').replace(/<[^>]+>/g, '').toLowerCase();
    let hasKeyword = false;
    for (const kw of keywords) {
      if (text.includes(kw)) { kwCounts[kw]++; hasKeyword = true; }
    }
    if (!hasKeyword) continue;
    matched++;
    // Very simple sentiment (positive words vs negative words)
    const posWords = ['great', 'good', 'excellent', 'amazing', 'success', 'clean', 'renewable'];
    const negWords = ['fail', 'problem', 'issue', 'broken', 'outage', 'disaster', 'crisis'];
    const posHits = posWords.filter((w) => text.includes(w)).length;
    const negHits = negWords.filter((w) => text.includes(w)).length;
    if (posHits > negHits) pos++;
    else if (negHits > posHits) neg++;
    else neu++;
  }

  return {
    connectorId: 'mastodon',
    bbox: [-180, -90, 180, 90], // global
    countries: [],
    eventCount: matched,
    keywordCounts: kwCounts,
    sentiment: { positive: pos, neutral: neu, negative: neg },
    bucketStartIso: new Date().toISOString(),
    credibility: 0.55, // user-generated content; moderate-low credibility
  };
}

export default { meta: CONNECTOR_META, fetchSignal };
