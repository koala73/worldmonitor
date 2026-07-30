#!/usr/bin/env node

/**
 * Seed script: fetches compact snapshot payloads from consumer-prices-core
 * and writes them to Upstash Redis for WorldMonitor bootstrap hydration.
 *
 * Run manually: node scripts/seed-consumer-prices.mjs --force
 *
 * IMPORTANT: This is a MANUAL FALLBACK script only.
 * Do NOT configure as a Railway cron. The consumer-prices-core publish.ts
 * pipeline (scrape → aggregate → publish) is the authoritative writer.
 * Running both as crons causes TTL conflict (this script: 10-60min TTLs,
 * publish.ts: 26h TTL) — whichever runs last wins.
 *
 * --force is required to prevent accidentally overwriting publish.ts TTLs
 * when running interactively.
 */

import { loadEnvFile, CHROME_UA, writeExtraKeyWithMeta } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const FORCE = process.argv.includes('--force');
if (!FORCE) {
  console.error(
    '[consumer-prices] ERROR: --force flag required.\n' +
    'This script overwrites Redis keys with short TTLs (10-60 min), stomping the\n' +
    'authoritative publish.ts 26h TTLs. Only run manually when publish.ts is broken.\n' +
    'Usage: node scripts/seed-consumer-prices.mjs --force',
  );
  process.exit(1);
}

const BASE_URL = process.env.CONSUMER_PRICES_CORE_BASE_URL;
const API_KEY = process.env.CONSUMER_PRICES_CORE_API_KEY;
const MARKET = process.env.CONSUMER_PRICES_DEFAULT_MARKET || 'ae';
const BASKET = 'essentials-ae';

if (!BASE_URL) {
  console.warn('[consumer-prices] CONSUMER_PRICES_CORE_BASE_URL not set — writing empty placeholders');
}

async function fetchSnapshot(path) {
  if (!BASE_URL) return null;
  const url = `${BASE_URL.replace(/\/$/, '')}${path}`;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': CHROME_UA,
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) {
      console.warn(`  [consumer-prices] ${path} HTTP ${resp.status}`);
      return null;
    }
    return resp.json();
  } catch (err) {
    console.warn(`  [consumer-prices] ${path} error: ${err.message}`);
    return null;
  }
}

function emptyOverview(market) {
  return {
    marketCode: market,
    asOf: String(Date.now()),
    currencyCode: 'AED',
    essentialsIndex: 0,
    valueBasketIndex: 0,
    wowPct: 0,
    momPct: 0,
    retailerSpreadPct: 0,
    coveragePct: 0,
    freshnessLagMin: 0,
    topCategories: [],
    upstreamUnavailable: true,
  };
}

function emptyMovers(market, range) {
  return { marketCode: market, asOf: String(Date.now()), range, risers: [], fallers: [], upstreamUnavailable: true };
}

function emptySpread(market, basket) {
  return { marketCode: market, asOf: String(Date.now()), basketSlug: basket, currencyCode: 'AED', retailers: [], spreadPct: 0, upstreamUnavailable: true };
}

function emptyFreshness(market) {
  return { marketCode: market, asOf: String(Date.now()), retailers: [], overallFreshnessMin: 0, stalledCount: 0, upstreamUnavailable: true };
}

function emptyBasketSeries(market, basket, range) {
  return { marketCode: market, basketSlug: basket, asOf: String(Date.now()), currencyCode: 'AED', range, essentialsSeries: [], valueSeries: [], upstreamUnavailable: true };
}

function emptyCategories(market, range) {
  return { marketCode: market, asOf: String(Date.now()), range, categories: [], upstreamUnavailable: true };
}

async function run() {
  console.log(`[consumer-prices] seeding market=${MARKET} basket=${BASKET}`);

  const TTL_OVERVIEW   = 1800;  // 30 min
  const TTL_MOVERS     = 1800;  // 30 min
  const TTL_SPREAD     = 3600;  // 60 min
  const TTL_FRESHNESS  = 600;   // 10 min
  const TTL_SERIES     = 3600;  // 60 min
  const TTL_CATEGORIES = 1800;  // 30 min

  // Fetch all snapshots in parallel
  const [overview, movers30d, movers7d, spread, freshness, series30d, series7d, series90d,
         categories30d, categories7d, categories90d] = await Promise.all([
    fetchSnapshot(`/wm/consumer-prices/v1/overview?market=${MARKET}`),
    fetchSnapshot(`/wm/consumer-prices/v1/movers?market=${MARKET}&days=30`),
    fetchSnapshot(`/wm/consumer-prices/v1/movers?market=${MARKET}&days=7`),
    fetchSnapshot(`/wm/consumer-prices/v1/retailer-spread?market=${MARKET}&basket=${BASKET}`),
    fetchSnapshot(`/wm/consumer-prices/v1/freshness?market=${MARKET}`),
    fetchSnapshot(`/wm/consumer-prices/v1/basket-series?market=${MARKET}&basket=${BASKET}&range=30d`),
    fetchSnapshot(`/wm/consumer-prices/v1/basket-series?market=${MARKET}&basket=${BASKET}&range=7d`),
    fetchSnapshot(`/wm/consumer-prices/v1/basket-series?market=${MARKET}&basket=${BASKET}&range=90d`),
    fetchSnapshot(`/wm/consumer-prices/v1/categories?market=${MARKET}&range=30d`),
    fetchSnapshot(`/wm/consumer-prices/v1/categories?market=${MARKET}&range=7d`),
    fetchSnapshot(`/wm/consumer-prices/v1/categories?market=${MARKET}&range=90d`),
  ]);

  const writes = [
    {
      key: `consumer-prices:overview:${MARKET}`,
      data: overview ?? emptyOverview(MARKET),
      ttl: TTL_OVERVIEW,
      metaKey: `seed-meta:consumer-prices:overview:${MARKET}`,
    },
    {
      key: `consumer-prices:movers:${MARKET}:30d`,
      data: movers30d ?? emptyMovers(MARKET, '30d'),
      ttl: TTL_MOVERS,
      metaKey: `seed-meta:consumer-prices:movers:${MARKET}:30d`,
    },
    {
      key: `consumer-prices:movers:${MARKET}:7d`,
      data: movers7d ?? emptyMovers(MARKET, '7d'),
      ttl: TTL_MOVERS,
      metaKey: `seed-meta:consumer-prices:movers:${MARKET}:7d`,
    },
    {
      key: `consumer-prices:retailer-spread:${MARKET}:${BASKET}`,
      data: spread ?? emptySpread(MARKET, BASKET),
      ttl: TTL_SPREAD,
      metaKey: `seed-meta:consumer-prices:spread:${MARKET}`,
    },
    {
      key: `consumer-prices:freshness:${MARKET}`,
      data: freshness ?? emptyFreshness(MARKET),
      ttl: TTL_FRESHNESS,
      metaKey: `seed-meta:consumer-prices:freshness:${MARKET}`,
    },
    {
      key: `consumer-prices:basket-series:${MARKET}:${BASKET}:30d`,
      data: series30d ?? emptyBasketSeries(MARKET, BASKET, '30d'),
      ttl: TTL_SERIES,
      metaKey: `seed-meta:consumer-prices:basket-series:${MARKET}:${BASKET}:30d`,
    },
    {
      key: `consumer-prices:basket-series:${MARKET}:${BASKET}:7d`,
      data: series7d ?? emptyBasketSeries(MARKET, BASKET, '7d'),
      ttl: TTL_SERIES,
      metaKey: `seed-meta:consumer-prices:basket-series:${MARKET}:${BASKET}:7d`,
    },
    {
      key: `consumer-prices:basket-series:${MARKET}:${BASKET}:90d`,
      data: series90d ?? emptyBasketSeries(MARKET, BASKET, '90d'),
      ttl: TTL_SERIES,
      metaKey: `seed-meta:consumer-prices:basket-series:${MARKET}:${BASKET}:90d`,
    },
    {
      key: `consumer-prices:categories:${MARKET}:30d`,
      data: categories30d ?? emptyCategories(MARKET, '30d'),
      ttl: TTL_CATEGORIES,
      metaKey: `seed-meta:consumer-prices:categories:${MARKET}:30d`,
    },
    {
      key: `consumer-prices:categories:${MARKET}:7d`,
      data: categories7d ?? emptyCategories(MARKET, '7d'),
      ttl: TTL_CATEGORIES,
      metaKey: `seed-meta:consumer-prices:categories:${MARKET}:7d`,
    },
    {
      key: `consumer-prices:categories:${MARKET}:90d`,
      data: categories90d ?? emptyCategories(MARKET, '90d'),
      ttl: TTL_CATEGORIES,
      metaKey: `seed-meta:consumer-prices:categories:${MARKET}:90d`,
    },
  ];

  let failed = 0;
  for (const { key, data, ttl, metaKey } of writes) {
    try {
      let recordCount;
      if (data.upstreamUnavailable === true) {
        // Synthetic placeholder written when upstream fetch failed — keep
        // recordCount=0 so health.js surfaces EMPTY_DATA instead of going green.
        recordCount = 0;
      } else if (Array.isArray(data.risers) || Array.isArray(data.fallers)) {
        const sum = (data.risers?.length ?? 0) + (data.fallers?.length ?? 0);
        recordCount = Math.max(1, sum);
      } else if (Array.isArray(data.retailers ?? data.essentialsSeries ?? data.categories)) {
        recordCount = (data.retailers ?? data.essentialsSeries ?? data.categories).length;
      } else {
        recordCount = 1;
      }
      await writeExtraKeyWithMeta(key, data, ttl, recordCount, metaKey);
      console.log(`  [consumer-prices] wrote ${key} (${recordCount} records)`);
    } catch (err) {
      console.error(`  [consumer-prices] failed ${key}: ${err.message}`);
      failed++;
    }
  }

  console.log(`[consumer-prices] done. ${writes.length - failed}/${writes.length} keys written.`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('[consumer-prices] seed failed:', err);
  process.exit(1);
});
