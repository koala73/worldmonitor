/**
 * Risk Scores API - Cached CII and Strategic Risk computation
 * Eliminates 15-minute "learning mode" for users by pre-computing scores
 * Uses Upstash Redis for cross-user caching (10-minute TTL)
 */

import { Redis } from '@upstash/redis';

export const config = {
  runtime: 'edge',
};

const CACHE_TTL_SECONDS = 600; // 10 minutes
const STALE_CACHE_TTL_SECONDS = 3600; // 1 hour - serve stale when API fails
const CACHE_KEY = 'risk:scores:v2';
const STALE_CACHE_KEY = 'risk:scores:stale:v2';

// Tier 1 countries for CII
const TIER1_COUNTRIES = {
  US: 'United States', RU: 'Russia', CN: 'China', UA: 'Ukraine', IR: 'Iran',
  IL: 'Israel', TW: 'Taiwan', KP: 'North Korea', SA: 'Saudi Arabia', TR: 'Turkey',
  PL: 'Poland', DE: 'Germany', FR: 'France', GB: 'United Kingdom', IN: 'India',
  PK: 'Pakistan', SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
};

// Baseline geopolitical risk (0-50)
const BASELINE_RISK = {
  US: 5, RU: 35, CN: 25, UA: 50, IR: 40, IL: 45, TW: 30, KP: 45,
  SA: 20, TR: 25, PL: 10, DE: 5, FR: 10, GB: 5, IN: 20, PK: 35,
  SY: 50, YE: 50, MM: 45, VE: 40,
};

// Event significance multipliers
const EVENT_MULTIPLIER = {
  US: 0.3, RU: 2.0, CN: 2.5, UA: 0.8, IR: 2.0, IL: 0.7, TW: 1.5, KP: 3.0,
  SA: 2.0, TR: 1.2, PL: 0.8, DE: 0.5, FR: 0.6, GB: 0.5, IN: 0.8, PK: 1.5,
  SY: 0.7, YE: 0.7, MM: 1.8, VE: 1.8,
};

// Country keywords for matching
const COUNTRY_KEYWORDS = {
  US: ['united states', 'usa', 'america', 'washington', 'biden', 'trump', 'pentagon'],
  RU: ['russia', 'moscow', 'kremlin', 'putin'],
  CN: ['china', 'beijing', 'xi jinping', 'prc'],
  UA: ['ukraine', 'kyiv', 'zelensky', 'donbas'],
  IR: ['iran', 'tehran', 'khamenei', 'irgc'],
  IL: ['israel', 'tel aviv', 'netanyahu', 'idf', 'gaza'],
  TW: ['taiwan', 'taipei'],
  KP: ['north korea', 'pyongyang', 'kim jong'],
  SA: ['saudi arabia', 'riyadh'],
  TR: ['turkey', 'ankara', 'erdogan'],
  PL: ['poland', 'warsaw'],
  DE: ['germany', 'berlin'],
  FR: ['france', 'paris', 'macron'],
  GB: ['britain', 'uk', 'london'],
  IN: ['india', 'delhi', 'modi'],
  PK: ['pakistan', 'islamabad'],
  SY: ['syria', 'damascus'],
  YE: ['yemen', 'sanaa', 'houthi'],
  MM: ['myanmar', 'burma'],
  VE: ['venezuela', 'caracas', 'maduro'],
};

// Initialize Redis (lazy)
let redis = null;
function getRedis() {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    redis = new Redis({ url, token });
  }
  return redis;
}

function normalizeCountryName(text) {
  const lower = text.toLowerCase();
  for (const [code, keywords] of Object.entries(COUNTRY_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return code;
  }
  return null;
}

function getScoreLevel(score) {
  if (score >= 70) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 40) return 'elevated';
  if (score >= 25) return 'normal';
  return 'low';
}

async function fetchACLEDProtests() {
  try {
    // Fetch recent protests from ACLED (last 7 days)
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

    // ACLED API now requires authentication - new endpoint as of Jan 2026
    const token = process.env.ACLED_ACCESS_TOKEN;
    const headers = { 'Accept': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // Updated endpoint: acleddata.com/api/ instead of api.acleddata.com
    const response = await fetch(
      `https://acleddata.com/api/acled/read?_format=json&event_type=Protests&event_type=Riots&event_date=${startDate}|${endDate}&event_date_where=BETWEEN&limit=500`,
      {
        headers,
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.warn('[RiskScores] ACLED fetch failed:', response.status, text.slice(0, 200));
      // Check for auth errors specifically
      if (response.status === 401 || response.status === 403) {
        throw new Error('ACLED API requires valid authentication token');
      }
      throw new Error(`ACLED API error: ${response.status}`);
    }

    const data = await response.json();

    // Check for API-level error in response
    if (data.message) {
      console.warn('[RiskScores] ACLED API returned message:', data.message);
      throw new Error(data.message);
    }
    if (data.error || data.success === false) {
      console.warn('[RiskScores] ACLED API returned error:', data.error || 'unknown');
      throw new Error(data.error || 'ACLED API error');
    }

    return data.data || [];
  } catch (error) {
    console.warn('[RiskScores] ACLED error:', error.message);
    throw error; // Re-throw to trigger stale cache fallback
  }
}

function computeCIIScores(protests) {
  const countryEvents = new Map();

  // Count events per country
  for (const event of protests) {
    const country = event.country;
    const code = normalizeCountryName(country);
    if (code && TIER1_COUNTRIES[code]) {
      const count = countryEvents.get(code) || { protests: 0, riots: 0 };
      if (event.event_type === 'Riots') {
        count.riots++;
      } else {
        count.protests++;
      }
      countryEvents.set(code, count);
    }
  }

  // Compute scores for all Tier 1 countries
  const scores = [];
  const now = new Date();

  for (const [code, name] of Object.entries(TIER1_COUNTRIES)) {
    const events = countryEvents.get(code) || { protests: 0, riots: 0 };
    const baseline = BASELINE_RISK[code] || 20;
    const multiplier = EVENT_MULTIPLIER[code] || 1.0;

    // Unrest component: protests + riots (riots weighted 2x)
    const unrestRaw = (events.protests + events.riots * 2) * multiplier;
    const unrest = Math.min(100, Math.round(unrestRaw * 2));

    // Security component: baseline + riot contribution
    const security = Math.min(100, baseline + events.riots * multiplier * 5);

    // Information component: based on event count (proxy for news coverage)
    const totalEvents = events.protests + events.riots;
    const information = Math.min(100, totalEvents * multiplier * 3);

    // Composite score: weighted average + baseline
    const composite = Math.min(100, Math.round(
      baseline +
      (unrest * 0.4 + security * 0.35 + information * 0.25) * 0.5
    ));

    scores.push({
      code,
      name,
      score: composite,
      level: getScoreLevel(composite),
      trend: 'stable', // Would need historical data for real trend
      change24h: 0,
      components: { unrest, security, information },
      lastUpdated: now.toISOString(),
    });
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

function computeStrategicRisk(ciiScores) {
  // Top 5 CII scores weighted average
  const top5 = ciiScores.slice(0, 5);
  const weights = top5.map((_, i) => 1 - (i * 0.15)); // [1.0, 0.85, 0.70, 0.55, 0.40]
  const totalWeight = weights.reduce((sum, w) => sum + w, 0); // 3.5
  const weightedSum = top5.reduce((sum, s, i) => sum + s.score * weights[i], 0);
  const ciiComponent = weightedSum / totalWeight;

  // Overall strategic risk
  const overallScore = Math.round(ciiComponent * 0.7 + 15); // 30% baseline

  return {
    score: Math.min(100, overallScore),
    level: getScoreLevel(overallScore),
    trend: 'stable',
    lastUpdated: new Date().toISOString(),
    contributors: top5.map(s => ({
      country: s.name,
      code: s.code,
      score: s.score,
      level: s.level,
    })),
  };
}

export default async function handler(request) {
  // Allow GET only
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!process.env.ACLED_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ error: 'ACLED_ACCESS_TOKEN not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const redisClient = getRedis();

  // Check cache first
  if (redisClient) {
    try {
      const cached = await redisClient.get(CACHE_KEY);
      if (cached && typeof cached === 'object') {
        console.log('[RiskScores] Cache hit');
        return new Response(JSON.stringify({
          ...cached,
          cached: true,
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300',
          },
        });
      }
    } catch (cacheError) {
      console.warn('[RiskScores] Cache read error:', cacheError.message);
    }
  }

  try {
    // Fetch ACLED protests
    console.log('[RiskScores] Computing scores...');
    const protests = await fetchACLEDProtests();

    // Compute CII scores
    const ciiScores = computeCIIScores(protests);

    // Compute strategic risk
    const strategicRisk = computeStrategicRisk(ciiScores);

    const result = {
      cii: ciiScores,
      strategicRisk,
      protestCount: protests.length,
      computedAt: new Date().toISOString(),
    };

    // Cache in Redis (both regular and stale backup)
    if (redisClient) {
      try {
        await Promise.all([
          redisClient.set(CACHE_KEY, result, { ex: CACHE_TTL_SECONDS }),
          redisClient.set(STALE_CACHE_KEY, result, { ex: STALE_CACHE_TTL_SECONDS }),
        ]);
        console.log('[RiskScores] Cached scores');
      } catch (cacheError) {
        console.warn('[RiskScores] Cache write error:', cacheError.message);
      }
    }

    return new Response(JSON.stringify({
      ...result,
      cached: false,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    });

  } catch (error) {
    console.error('[RiskScores] Error:', error);

    // Try to return stale cached data
    if (redisClient) {
      try {
        const stale = await redisClient.get(STALE_CACHE_KEY);
        if (stale && typeof stale === 'object') {
          console.log('[RiskScores] Returning stale cache due to error');
          return new Response(JSON.stringify({
            ...stale,
            cached: true,
            stale: true,
            error: 'Using cached data - ACLED temporarily unavailable',
          }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=60',
            },
          });
        }
      } catch (cacheError) {
        console.warn('[RiskScores] Stale cache read error:', cacheError.message);
      }
    }

    // Final fallback: return baseline scores without unrest data
    console.log('[RiskScores] Returning baseline scores (no ACLED data)');
    const baselineScores = computeCIIScores([]);  // Empty protests = baseline only
    const baselineStrategic = computeStrategicRisk(baselineScores);

    return new Response(JSON.stringify({
      cii: baselineScores,
      strategicRisk: baselineStrategic,
      protestCount: 0,
      computedAt: new Date().toISOString(),
      baseline: true,
      error: 'ACLED unavailable - showing baseline risk assessments',
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });
  }
}
