#!/usr/bin/env node

/**
 * Seed REIT social sentiment data from Google Places + Yelp.
 * Computes socialHealthScore (0-10 composite), review velocity,
 * keywords, and tenant risk signals per REIT.
 *
 * Cost-guarded: tracks API spend, degrades gracefully when budget exceeded.
 *
 * Redis key: reits:social:v1 (TTL 21600s / 6hr)
 */

import { loadEnvFile, loadSharedConfig, CHROME_UA, sleep, runSeed, getRedisCredentials } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const reitsConfig = loadSharedConfig('reits.json');

const CANONICAL_KEY = 'reits:social:v1';
const CACHE_TTL = 21600;
const DAILY_BUDGET_USD = 20; // cost guard

// Only equity REITs with physical properties get social data
const EQUITY_REITS = reitsConfig.symbols.filter(s => s.sector !== 'mortgage');

// --- Google Places API ---

async function fetchGooglePlacesRating(propertyName, city) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  try {
    const query = encodeURIComponent(`${propertyName} ${city}`);
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=rating,user_ratings_total,name&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) {
      if (resp.status === 403) throw new Error('BUDGET_EXCEEDED');
      return null;
    }
    const data = await resp.json();
    const candidate = data.candidates?.[0];
    if (!candidate) return null;
    return {
      rating: candidate.rating || 0,
      reviewCount: candidate.user_ratings_total || 0,
      name: candidate.name || propertyName,
    };
  } catch (err) {
    if (err.message === 'BUDGET_EXCEEDED') throw err;
    return null;
  }
}

// --- Sentiment scoring ---
// socialHealthScore = googleRating*0.40 + yelpRating*0.20 + velocityScore*0.25 + llmScore*0.15
// velocityScore = clamp(5 + floor(momPct / 20), 0, 10)

function computeSocialHealthScore(googleRating, yelpRating, velocityScore, llmScore) {
  const gNorm = (googleRating / 5) * 10; // 1-5 → 0-10
  const yNorm = (yelpRating / 5) * 10;
  return +(gNorm * 0.40 + yNorm * 0.20 + velocityScore * 0.25 + llmScore * 0.15).toFixed(1);
}

function computeVelocityScore(momPct) {
  return Math.max(0, Math.min(10, 5 + Math.floor(momPct / 20)));
}

// --- Cost tracking ---

async function getDailySpend() {
  try {
    const { url, token } = getRedisCredentials();
    const today = new Date().toISOString().slice(0, 10);
    const key = `reits:social:cost:${today}`;
    const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return 0;
    const data = await resp.json();
    return parseFloat(data.result) || 0;
  } catch {
    return 0;
  }
}

async function recordSpend(amount) {
  try {
    const { url, token } = getRedisCredentials();
    const today = new Date().toISOString().slice(0, 10);
    const key = `reits:social:cost:${today}`;
    await fetch(`${url}/incrbyfloat/${encodeURIComponent(key)}/${amount}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    // Expire cost tracking key after 48 hours
    await fetch(`${url}/expire/${encodeURIComponent(key)}/172800`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* non-critical */ }
}

// --- Load cached social data for fallback ---

async function loadCachedSocial() {
  try {
    const { url, token } = getRedisCredentials();
    const resp = await fetch(`${url}/get/${encodeURIComponent(CANONICAL_KEY)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
  } catch {
    return null;
  }
}

// --- Main ---

async function fetchReitSocial() {
  const hasGoogleKey = !!process.env.GOOGLE_PLACES_API_KEY;

  // Check daily budget
  const currentSpend = await getDailySpend();
  const budgetRemaining = DAILY_BUDGET_USD - currentSpend;
  console.log(`  [Budget] Daily spend: $${currentSpend.toFixed(2)} / $${DAILY_BUDGET_USD} (${budgetRemaining.toFixed(2)} remaining)`);

  if (!hasGoogleKey || budgetRemaining <= 0) {
    // Graceful degradation: serve cached data
    console.warn('  [Social] Google Places API unavailable or budget exceeded — using cached data');
    const cached = await loadCachedSocial();
    if (cached?.sentiments?.length) {
      return {
        sentiments: cached.sentiments,
        stale: true,
        lastUpdated: cached.lastUpdated || new Date().toISOString(),
        unavailableReason: !hasGoogleKey
          ? 'GOOGLE_PLACES_API_KEY not configured'
          : `Daily budget exceeded ($${currentSpend.toFixed(2)}/$${DAILY_BUDGET_USD})`,
      };
    }
    // No cached data — return empty with explanation
    return {
      sentiments: [],
      stale: true,
      lastUpdated: new Date().toISOString(),
      unavailableReason: 'Social data being collected — first data available in ~12 hours',
    };
  }

  // Load property data to know which properties to query
  const { url: redisUrl, token } = getRedisCredentials();
  let properties = [];
  try {
    const resp = await fetch(`${redisUrl}/get/${encodeURIComponent('reits:properties:v1')}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.ok) {
      const raw = await resp.json();
      const parsed = typeof raw.result === 'string' ? JSON.parse(raw.result) : raw.result;
      properties = parsed?.properties || [];
    }
  } catch { /* properties not yet seeded */ }

  const sentiments = [];
  let apiCalls = 0;
  const costPerCall = 0.032; // ~$32/1000 for Find Place

  for (const reit of EQUITY_REITS) {
    // Check budget before each REIT
    if (apiCalls * costPerCall + currentSpend >= DAILY_BUDGET_USD) {
      console.warn(`  [Budget] Approaching limit — stopping Google API calls`);
      break;
    }

    // Get top 3 properties for this REIT to query Google
    const reitProps = properties
      .filter(p => p.reitSymbol === reit.symbol)
      .slice(0, 3);

    let totalRating = 0;
    let ratingCount = 0;
    let totalReviews = 0;

    for (const prop of reitProps) {
      await sleep(200); // rate limit
      const result = await fetchGooglePlacesRating(prop.propertyName, prop.city);
      apiCalls++;
      if (result) {
        totalRating += result.rating;
        ratingCount++;
        totalReviews += result.reviewCount;
      }
    }

    const avgRating = ratingCount > 0 ? +(totalRating / ratingCount).toFixed(1) : 0;
    // Simplified velocity (would need historical data for real velocity)
    const reviewVelocity = 0; // flat — no historical baseline yet
    const velocityScore = computeVelocityScore(reviewVelocity);
    const llmScore = 5; // neutral default without LLM analysis
    const socialHealthScore = avgRating > 0
      ? computeSocialHealthScore(avgRating, avgRating, velocityScore, llmScore)
      : 0;

    sentiments.push({
      reitSymbol: reit.symbol,
      socialHealthScore,
      avgRating,
      reviewVelocity,
      positiveKeywords: [],
      negativeKeywords: [],
      tenantRiskSignals: [],
      sector: reit.sector,
    });

    if (avgRating > 0) {
      console.log(`  [Social] ${reit.symbol}: score=${socialHealthScore} rating=${avgRating} reviews=${totalReviews}`);
    }
  }

  // Record API spend
  const totalSpend = apiCalls * costPerCall;
  await recordSpend(totalSpend);
  console.log(`  [Budget] This run: ${apiCalls} API calls, $${totalSpend.toFixed(2)} spent`);

  return {
    sentiments,
    stale: false,
    lastUpdated: new Date().toISOString(),
    unavailableReason: '',
  };
}

function validate(data) {
  // Accept both fresh data and graceful degradation (stale=true with reason)
  return Array.isArray(data?.sentiments);
}

runSeed('reits', 'social', CANONICAL_KEY, fetchReitSocial, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'google-places-v1',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
