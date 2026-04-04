/**
 * Product catalog API endpoint.
 *
 * Fetches product prices from Dodo Payments and returns a structured
 * tier view model for the /pro pricing page. Cached in Redis with
 * configurable TTL.
 *
 * GET /api/product-catalog → { tiers: [...], fetchedAt, cachedUntil }
 * DELETE /api/product-catalog → purge cache (requires RELAY_SHARED_SECRET)
 */

// @ts-check

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — generated JS module
import { FALLBACK_PRICES } from './_product-fallback-prices.js';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';
const DODO_API_KEY = process.env.DODO_API_KEY ?? '';
const DODO_ENV = process.env.DODO_PAYMENTS_ENVIRONMENT ?? 'test_mode';
const RELAY_SECRET = process.env.RELAY_SHARED_SECRET ?? '';

const CACHE_KEY = 'product-catalog:v2';
const CACHE_TTL = 3600; // 1 hour

// Product IDs and their catalog metadata (non-price fields).
// Prices come from Dodo at runtime, everything else from this map.
const CATALOG = {
  'pdt_0Nbtt71uObulf7fGXhQup': { planKey: 'pro_monthly', tierGroup: 'pro', billingPeriod: 'monthly' },
  'pdt_0NbttMIfjLWC10jHQWYgJ': { planKey: 'pro_annual', tierGroup: 'pro', billingPeriod: 'annual' },
  'pdt_0NbttVmG1SERrxhygbbUq': { planKey: 'api_starter', tierGroup: 'api_starter', billingPeriod: 'monthly' },
  'pdt_0Nbu2lawHYE3dv2THgSEV': { planKey: 'api_starter_annual', tierGroup: 'api_starter', billingPeriod: 'annual' },
  'pdt_0Nbttg7NuOJrhbyBGCius': { planKey: 'api_business', tierGroup: 'api_business', billingPeriod: 'monthly' },
  'pdt_0Nbttnqrfh51cRqhMdVLx': { planKey: 'enterprise', tierGroup: 'enterprise', billingPeriod: 'none' },
};

// Marketing features and display config (doesn't change with Dodo prices)
const TIER_CONFIG = {
  free: {
    name: 'Free',
    description: 'Get started with the essentials',
    features: ['Core dashboard panels', 'Global news feed', 'Earthquake & weather alerts', 'Basic map view'],
    cta: 'Get Started',
    href: 'https://worldmonitor.app',
    highlighted: false,
  },
  pro: {
    name: 'Pro',
    description: 'Full intelligence dashboard',
    features: ['Everything in Free', 'AI stock analysis & backtesting', 'Daily market briefs', 'Military & geopolitical tracking', 'Custom widget builder', 'MCP data connectors', 'Priority data refresh'],
    highlighted: true,
  },
  api_starter: {
    name: 'API',
    description: 'Programmatic access to intelligence data',
    features: ['REST API access', 'Real-time data streams', '1,000 requests/day', 'Webhook notifications', 'Custom data exports'],
    highlighted: false,
  },
  enterprise: {
    name: 'Enterprise',
    description: 'Custom solutions for organizations',
    features: ['Everything in Pro + API', 'Unlimited API requests', 'Dedicated support', 'Custom integrations', 'SLA guarantee', 'On-premise option'],
    cta: 'Contact Sales',
    href: 'mailto:enterprise@worldmonitor.app',
    highlighted: false,
  },
};

// Tier groups shown on the /pro page (ordered)
const PUBLIC_TIER_GROUPS = ['free', 'pro', 'api_starter', 'enterprise'];

function json(body, status, cors, cacheControl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
      ...cors,
    },
  });
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
    return result ? JSON.parse(result) : null;
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
    if (!RELAY_SECRET || authHeader !== `Bearer ${RELAY_SECRET}`) {
      return json({ error: 'Unauthorized' }, 401, cors);
    }
    await purgeCache();
    return json({ purged: true }, 200, cors);
  }

  // GET = return cached or fresh catalog
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, cors);
  }

  // Try cache first
  const cached = await getFromCache();
  if (cached) {
    return json(cached, 200, cors, 'public, max-age=300, s-maxage=600, stale-while-revalidate=300');
  }

  // Fetch from Dodo
  if (!DODO_API_KEY) {
    return json({ error: 'DODO_API_KEY not configured' }, 503, cors);
  }

  const dodoPrices = await fetchPricesFromDodo();
  // Count only public priced products that buildTiers actually renders
  const pricedPublicIds = Object.entries(CATALOG)
    .filter(([, v]) => PUBLIC_TIER_GROUPS.includes(v.tierGroup) && v.tierGroup !== 'free' && v.tierGroup !== 'enterprise')
    .map(([id]) => id);
  const dodoPriceCount = pricedPublicIds.filter(id => dodoPrices[id]).length;
  const expectedCount = pricedPublicIds.length;
  const priceSource = dodoPriceCount === expectedCount ? 'dodo' : dodoPriceCount > 0 ? 'partial' : 'fallback';
  if (priceSource !== 'dodo') {
    console.warn(`[product-catalog] priceSource=${priceSource}: got ${dodoPriceCount}/${expectedCount} prices from Dodo`);
  }
  const tiers = buildTiers(dodoPrices);
  const now = Date.now();
  const result = { tiers, fetchedAt: now, cachedUntil: now + CACHE_TTL * 1000, priceSource };

  // Cache the result
  await setCache(result);

  return json(result, 200, cors, 'public, max-age=300, s-maxage=600, stale-while-revalidate=300');
}
