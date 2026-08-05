/**
 * Product catalog API endpoint.
 *
 * Fetches product prices from Dodo Payments and returns a structured
 * tier view model for the /pro pricing page. Cached in Redis with
 * configurable TTL.
 *
 * GET /api/product-catalog → { product, currency, plans, capabilities, tiers, fetchedAt, cachedUntil }
 * DELETE /api/product-catalog → purge cache (requires RELAY_SHARED_SECRET)
 */

// @ts-check

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module
import { timingSafeEqualSecret } from './_crypto.js';
// @ts-expect-error — generated JS module
import {
  FALLBACK_PRICES,
  PRODUCT_CATALOG as CATALOG,
  PUBLIC_PRODUCT_FACTS,
  PUBLIC_TIER_GROUPS,
  TIER_CONFIG,
} from './_product-catalog.generated.js';
// @ts-expect-error — JS module
import { unwrapEnvelope } from './_seed-envelope.js';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';
const DODO_API_KEY = process.env.DODO_API_KEY ?? '';
const DODO_ENV = process.env.DODO_PAYMENTS_ENVIRONMENT ?? 'test_mode';
const RELAY_SECRET = process.env.RELAY_SHARED_SECRET ?? '';

const CACHE_KEY = 'product-catalog:v2';
const CACHE_TTL = 3600; // 1 hour

function json(body, status, cors, cacheControl, source) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
      // Signals which code-path served the response so operators + the
      // seed-contract probe can distinguish cache hits from Dodo/fallback.
      // Without this header a green probe would not prove the cached-reader
      // path is healthy — it could be silently falling through to fallback.
      ...(source ? { 'X-Product-Catalog-Source': source } : {}),
      ...cors,
    },
  });
}

function withPublicFacts(payload) {
  return { ...payload, ...PUBLIC_PRODUCT_FACTS };
}

async function getFromCache() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(CACHE_KEY)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const { result } = await res.json();
    if (!result) return null;
    // Envelope-aware: ais-relay now writes `product-catalog:v2` as {_seed, data}
    // (PR #3097). Return the bare payload so clients see the legacy
    // {tiers, fetchedAt, cachedUntil, priceSource} shape. Pre-contract bare
    // values pass through unchanged.
    return unwrapEnvelope(JSON.parse(result)).data;
  } catch { return null; }
}

async function setCache(data) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', CACHE_KEY, JSON.stringify(data), 'EX', String(CACHE_TTL)]),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* non-fatal */ }
}

async function purgeCache() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['DEL', CACHE_KEY]),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* non-fatal */ }
}

async function fetchPricesFromDodo() {
  const baseUrl = DODO_ENV === 'live_mode'
    ? 'https://live.dodopayments.com'
    : 'https://test.dodopayments.com';

  const productIds = Object.keys(CATALOG);
  const results = await Promise.allSettled(
    productIds.map(async (productId) => {
      const res = await fetch(`${baseUrl}/products/${productId}`, {
        headers: {
          Authorization: `Bearer ${DODO_API_KEY}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { productId, product: await res.json() };
    }),
  );

  const prices = {};
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { productId, product } = result.value;
      const priceData = product.price;
      if (priceData) {
        prices[productId] = {
          priceCents: priceData.price ?? priceData.fixed_price ?? 0,
          currency: priceData.currency ?? 'USD',
          name: product.name,
        };
      }
    } else {
      console.warn(`[product-catalog] Dodo fetch failed:`, result.reason?.message);
    }
  }
  return prices;
}

function buildTiers(dodoPrices) {
  const tiers = [];

  for (const group of PUBLIC_TIER_GROUPS) {
    const config = TIER_CONFIG[group];
    if (!config) continue;

    if (group === 'free') {
      tiers.push({ ...config, price: 0, period: 'forever' });
      continue;
    }

    if (group === 'enterprise') {
      tiers.push({ ...config, price: null });
      continue;
    }

    // Find monthly and annual products for this tier group
    const monthlyEntry = Object.entries(CATALOG).find(([, v]) => v.tierGroup === group && v.billingPeriod === 'monthly');
    const annualEntry = Object.entries(CATALOG).find(([, v]) => v.tierGroup === group && v.billingPeriod === 'annual');

    const tier = { ...config };

    if (monthlyEntry) {
      const [monthlyId] = monthlyEntry;
      const monthlyPrice = dodoPrices[monthlyId];
      if (monthlyPrice) {
        tier.monthlyPrice = monthlyPrice.priceCents / 100;
      } else if (FALLBACK_PRICES[monthlyId] != null) {
        tier.monthlyPrice = FALLBACK_PRICES[monthlyId] / 100;
        console.warn(`[product-catalog] FALLBACK price for ${monthlyId} ($${tier.monthlyPrice}) — Dodo fetch failed`);
      }
      tier.monthlyProductId = monthlyId;
    }

    if (annualEntry) {
      const [annualId] = annualEntry;
      const annualPrice = dodoPrices[annualId];
      if (annualPrice) {
        tier.annualPrice = annualPrice.priceCents / 100;
      } else if (FALLBACK_PRICES[annualId] != null) {
        tier.annualPrice = FALLBACK_PRICES[annualId] / 100;
        console.warn(`[product-catalog] FALLBACK price for ${annualId} ($${tier.annualPrice}) — Dodo fetch failed`);
      }
      tier.annualProductId = annualId;
    }

    tiers.push(tier);
  }

  return tiers;
}

export default async function handler(req) {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
  }

  // DELETE = purge cache (authenticated)
  if (req.method === 'DELETE') {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!RELAY_SECRET || !(await timingSafeEqualSecret(authHeader, `Bearer ${RELAY_SECRET}`))) {
      return json({ error: 'Unauthorized' }, 401, cors);
    }
    await purgeCache();
    return json({ purged: true }, 200, cors);
  }

  // GET = return cached or fresh catalog
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, cors);
  }

  // Read from Redis (populated by Railway ais-relay seed loop)
  const cached = await getFromCache();
  if (cached) {
    return json(withPublicFacts(cached), 200, cors, 'public, max-age=300, s-maxage=600, stale-while-revalidate=300', 'cache');
  }

  // Redis empty (purged or seed hasn't run). Try Dodo directly as backup.
  // May fail from Vercel IPs (401) — falls back to static prices.
  if (DODO_API_KEY) {
    const dodoPrices = await fetchPricesFromDodo();
    const pricedPublicIds = Object.entries(CATALOG)
      .filter(([, v]) => PUBLIC_TIER_GROUPS.includes(v.tierGroup) && v.tierGroup !== 'free' && v.tierGroup !== 'enterprise')
      .map(([id]) => id);
    const dodoPriceCount = pricedPublicIds.filter(id => dodoPrices[id]).length;
    if (dodoPriceCount > 0) {
      const priceSource = dodoPriceCount === pricedPublicIds.length ? 'dodo' : 'partial';
      const tiers = buildTiers(dodoPrices);
      const now = Date.now();
      const result = withPublicFacts({ tiers, fetchedAt: now, cachedUntil: now + CACHE_TTL * 1000, priceSource });
      // Don't write to Redis — let the Railway seed own that key with its longer TTL.
      // Just return the result with short cache so the next Railway cycle repopulates properly.
      // Header must carry the SAME source as the body: a partial Dodo read
      // stamped 'dodo' here made probes read a degraded response as fully live.
      return json(result, 200, cors, 'public, max-age=60, s-maxage=60', priceSource);
    }
  }

  // All sources failed. Return fallback with short cache.
  const tiers = buildTiers({});
  const now = Date.now();
  return json(withPublicFacts({ tiers, fetchedAt: now, cachedUntil: now + 60_000, priceSource: 'fallback' }), 200, cors, 'public, max-age=60, s-maxage=60', 'fallback');
}
