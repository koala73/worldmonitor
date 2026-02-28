/**
 * GDELT Connector — OpenSens OSINT framework
 *
 * Source tier: official-api (GDELT Project public APIs, free, no API key required)
 * License: GDELT data is free for non-commercial research use.
 *   See: https://www.gdeltproject.org/about.html#termsofuse
 *
 * Fetches GKG (Global Knowledge Graph) counts and themes for a bounding box,
 * returning only AGGREGATE signals — no individual post/article content stored.
 *
 * Rate limit: GDELT recommends <1 req/s. This connector enforces 2 s minimum
 * between calls via the rateLimit policy. Upstream handles ~5 req/s.
 *
 * Privacy: No personal data processed. GDELT aggregates over millions of articles;
 * this connector further aggregates to keyword counts and sentiment bins per tile.
 */

export const CONNECTOR_META = {
  id: 'gdelt',
  name: 'GDELT Project (Global Knowledge Graph)',
  sourceTier: 'official-api',
  requiresOptIn: false,
  rateLimit: { requests: 1, windowSec: 2 },
};

const GDELT_DOC_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_GEO_BASE = 'https://api.gdeltproject.org/api/v2/geo/geo';

/**
 * Fetch GDELT event counts for a bounding box, filtered to energy/infrastructure themes.
 * @param {number} minLat
 * @param {number} minLon
 * @param {number} maxLat
 * @param {number} maxLon
 * @param {string} timespan  e.g. '1d', '3d', '7d'
 * @returns {Promise<import('../../../src/types/opensens').OsintSignal>}
 */
export async function fetch(minLat, minLon, maxLat, maxLon, timespan = '3d') {
  const query = [
    'theme:ENV_SOLAR',
    'theme:ENV_WIND',
    'theme:ENV_POWER',
    'theme:ECON_AFFORD_ENERGY',
    'theme:INFRASTRUCTURE',
  ].join(' OR ');

  const params = new URLSearchParams({
    query,
    mode: 'artlist',
    maxrecords: '250',
    timespan,
    format: 'json',
    // Bounding box filter (GDELT GEO API)
    lat: String((minLat + maxLat) / 2),
    lon: String((minLon + maxLon) / 2),
    radius: String(Math.max(maxLat - minLat, maxLon - minLon) * 111 / 2), // approx km
  });

  const url = `${GDELT_GEO_BASE}?${params}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'OpenSens-DAMD/1.0 (+https://opensens.io)' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`GDELT returned ${res.status}`);
  const data = await res.json();

  return normalize(data, [minLon, minLat, maxLon, maxLat]);
}

/**
 * Normalize raw GDELT GEO response to OsintSignal aggregate.
 * Only keyword counts and sentiment bins are returned — no article content.
 */
function normalize(raw, bbox) {
  const articles = raw?.articles ?? [];
  const themes = {};
  let posCount = 0, negCount = 0, neuCount = 0;

  for (const art of articles) {
    // Extract themes (list of GDELT theme codes)
    for (const theme of (art.themes ?? '').split(';')) {
      if (theme) themes[theme] = (themes[theme] || 0) + 1;
    }
    // Tone: GDELT provides comma-separated values; first is overall tone
    const tone = parseFloat((art.tone ?? '').split(',')[0]);
    if (tone > 1) posCount++;
    else if (tone < -1) negCount++;
    else neuCount++;
  }

  return {
    connectorId: 'gdelt',
    bbox,
    countries: [],
    eventCount: articles.length,
    keywordCounts: themes,
    sentiment: { positive: posCount, neutral: neuCount, negative: negCount },
    bucketStartIso: new Date().toISOString(),
    credibility: 0.70, // GDELT aggregates from unverified media; moderate credibility
  };
}

export default { meta: CONNECTOR_META, fetch };
