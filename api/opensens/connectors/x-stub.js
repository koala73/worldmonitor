/**
 * X (Twitter) API Connector STUB — OpenSens OSINT framework
 *
 * Source tier: gated-opt-in
 * Status: STUB ONLY — full implementation requires a paid X API v2 plan.
 *
 * COMPLIANCE NOTES:
 *   - X API ToS: https://developer.x.com/en/developer-terms/agreement-and-policy
 *   - Requires X Developer App with at least Basic tier ($100/month as of 2025).
 *   - Rate limits: 100 search queries/15 min (Basic); 500,000 posts/month cap.
 *   - Do NOT store tweet text, author IDs, or any personal data.
 *   - Only derived aggregate signals (keyword counts, sentiment distribution) may be retained.
 *   - Must honour X's data deletion webhooks — not yet implemented in this stub.
 *   - Safe mode default: DISABLED. Must be explicitly enabled by user AND have OPENSENS_X_BEARER_TOKEN set.
 *
 * This stub returns an empty signal with an explanatory error when not configured.
 */

export const CONNECTOR_META = {
  id: 'x-twitter',
  name: 'X (Twitter) API v2 — gated, paid',
  sourceTier: 'gated-opt-in',
  requiresOptIn: true,
  rateLimit: { requests: 100, windowSec: 900 }, // 15-minute window
};

const SEARCH_QUERY = '(solar OR offgrid OR "battery storage" OR starlink OR microgrid OR "edge AI") lang:en -is:retweet';

export async function fetchSignal() {
  const bearerToken = process.env.OPENSENS_X_BEARER_TOKEN;

  if (!bearerToken) {
    return {
      connectorId: 'x-twitter',
      bbox: [-180, -90, 180, 90],
      countries: [],
      eventCount: 0,
      keywordCounts: {},
      sentiment: { positive: 0, neutral: 0, negative: 0 },
      bucketStartIso: new Date().toISOString(),
      credibility: 0,
      error: 'X connector disabled. Set OPENSENS_X_BEARER_TOKEN and enable via user settings. Requires X API Basic plan or higher.',
    };
  }

  const params = new URLSearchParams({
    query: SEARCH_QUERY,
    max_results: '100',
    'tweet.fields': 'public_metrics,created_at', // No author info requested
  });

  const res = await fetch(`https://api.twitter.com/2/tweets/search/recent?${params}`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'User-Agent': 'OpenSens-DAMD/1.0 (+https://opensens.io)',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`X API returned ${res.status}`);
  const data = await res.json();
  const tweets = data?.data ?? [];

  // Aggregate only — no tweet text stored
  const kwCounts = {};
  let pos = 0, neg = 0, neu = 0;
  for (const tw of tweets) {
    const text = (tw.text ?? '').toLowerCase();
    for (const kw of ['solar', 'pv', 'offgrid', 'battery', 'starlink', 'wind', 'microgrid']) {
      if (text.includes(kw)) kwCounts[kw] = (kwCounts[kw] || 0) + 1;
    }
    const likes = tw.public_metrics?.like_count ?? 0;
    if (likes > 50) pos++; else if (likes === 0) neg++; else neu++;
  }

  return {
    connectorId: 'x-twitter',
    bbox: [-180, -90, 180, 90],
    countries: [],
    eventCount: tweets.length,
    keywordCounts: kwCounts,
    sentiment: { positive: pos, neutral: neu, negative: neg },
    bucketStartIso: new Date().toISOString(),
    credibility: 0.65,
  };
}

export default { meta: CONNECTOR_META, fetchSignal };
