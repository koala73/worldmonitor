/**
 * Reddit Connector STUB — OpenSens OSINT framework
 *
 * Source tier: gated-opt-in
 * Status: STUB — requires user-supplied Reddit OAuth2 credentials.
 *
 * COMPLIANCE NOTES:
 *   - Reddit API ToS: https://www.redditinc.com/policies/data-api-terms
 *   - Requires OAuth2 app registration at https://www.reddit.com/prefs/apps
 *   - Rate limit: 100 req/min with OAuth (10 req/min without).
 *   - Do NOT store post content — only derived keyword counts.
 *   - User must explicitly enable this connector in settings.
 *   - Requires REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET env vars.
 *
 * Safe mode default: DISABLED. Activate only with explicit user opt-in
 * and valid credentials.
 */

export const CONNECTOR_META = {
  id: 'reddit',
  name: 'Reddit (OAuth2 — gated)',
  sourceTier: 'gated-opt-in',
  requiresOptIn: true,
  rateLimit: { requests: 100, windowSec: 60 },
};

const SUBREDDITS = ['solar', 'offgrid', 'SolarDIY', 'homeautomation', 'StarlinkEngineering', 'mildlyinfuriating'];

export async function fetchSignal() {
  const clientId     = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      connectorId: 'reddit',
      bbox: [-180, -90, 180, 90],
      countries: [],
      eventCount: 0,
      keywordCounts: {},
      sentiment: { positive: 0, neutral: 0, negative: 0 },
      bucketStartIso: new Date().toISOString(),
      credibility: 0,
      error: 'Reddit connector not configured — set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET env vars and enable via user settings.',
    };
  }

  // Step 1: Get OAuth2 token (client_credentials for read-only)
  const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'OpenSens-DAMD/1.0 (+https://opensens.io)',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(8000),
  });

  if (!tokenRes.ok) throw new Error(`Reddit OAuth failed: ${tokenRes.status}`);
  const { access_token: token } = await tokenRes.json();

  // Step 2: Fetch hot posts from relevant subreddits (aggregate only)
  const kwCounts = {};
  let pos = 0, neg = 0, neu = 0, total = 0;

  for (const sr of SUBREDDITS) {
    try {
      const listRes = await fetch(`https://oauth.reddit.com/r/${sr}/hot?limit=25`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'OpenSens-DAMD/1.0 (+https://opensens.io)',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!listRes.ok) continue;
      const data = await listRes.json();
      for (const child of data?.data?.children ?? []) {
        const title = (child.data?.title ?? '').toLowerCase();
        total++;
        // Count keywords — do NOT store title or any identifiable info
        for (const kw of ['solar', 'pv', 'battery', 'starlink', 'wind', 'offgrid', 'grid']) {
          if (title.includes(kw)) kwCounts[kw] = (kwCounts[kw] || 0) + 1;
        }
        const score = child.data?.score ?? 0;
        if (score > 100) pos++; else if (score < 0) neg++; else neu++;
      }
    } catch { /* skip individual subreddit errors */ }
  }

  return {
    connectorId: 'reddit',
    bbox: [-180, -90, 180, 90],
    countries: [],
    eventCount: total,
    keywordCounts: kwCounts,
    sentiment: { positive: pos, neutral: neu, negative: neg },
    bucketStartIso: new Date().toISOString(),
    credibility: 0.60,
  };
}

export default { meta: CONNECTOR_META, fetchSignal };
