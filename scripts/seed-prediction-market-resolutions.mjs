#!/usr/bin/env node
// @ts-check
//
// Prediction-market settlement seeder (Phase 2 / #5238 U11 — settlement half).
//
// Reads the bet-engine's BETS_HISTORY_KEY for any pending prediction-market
// bets, extracts their market slugs, queries Gamma (Polymarket) and Kalshi for
// CLOSED prices, and writes the results to prediction:markets-resolution:v1.
// This is the write side of the KTD2 settlement feed; the bet-engine's
// _bet-templates-markets.mjs is the read side.
//
// Architecture (mirrors ACLED precedent in seed-acled-conflict.mjs):
//   - Bootstrap feed  (seed-prediction-markets.mjs) → closed:false → open markets
//   - Settlement feed (this script)                 → closed:true  → settled prices
//
// Settlement shape written to prediction:markets-resolution:v1:
//   [{ market: "<slug>", yesPrice: 0|100, settledAt: "<ISO>" }, ...]
//
// The resolver's shapeResolutionFeed reads Array.isArray(d) ? d : [] and the
// eval's yesPrice(market==<slug>) function matches on the `market` field.
//
// Railway cron: runs alongside seed-forecast-bets (30 min interval).
// Graceful exit on any Upstash/API transient: self-heals next run.

import { loadEnvFile, CHROME_UA, getRedisCredentials, GRACEFUL_FETCH_FAILURE_EXIT_CODE } from './_seed-utils.mjs';
import { BETS_HISTORY_KEY } from './_forecast-bets-keys.mjs';
import { MARKETS_RESOLUTION_FEED } from './_bet-templates-markets.mjs';

const DIRECT_RUN = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (DIRECT_RUN) loadEnvFile(import.meta.url);

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const FETCH_TIMEOUT = 10_000;
// Keep resolved market prices for 90d so the resolver can settle bets.
const RESOLUTION_TTL_SECONDS = 90 * 24 * 60 * 60;
// Maximum number of BETS_HISTORY_KEY snapshots to scan for pending market slugs.
const HISTORY_SCAN_RUNS = 20;

// ── Slug resolution ───────────────────────────────────────────────────────

/** @returns {{ source: 'polymarket'|'kalshi', id: string } | null} */
function parseSlug(slug) {
  if (typeof slug !== 'string') return null;
  const [source, ...rest] = slug.split(':');
  if (!rest.length) return null;
  return { source, id: rest.join(':') };
}

// ── Gamma (Polymarket) settlement ─────────────────────────────────────────

/**
 * Query Gamma for a single event by slug. Returns settled yesPrice (0 or 100)
 * or null if not yet settled.
 * @param {string} eventSlug  e.g. "will-x-happen"
 */
async function fetchGammaSettlement(eventSlug) {
  try {
    const params = new URLSearchParams({ slug: eventSlug });
    const resp = await fetch(`${GAMMA_BASE}/events?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) {
      console.warn(`  [settlement:polymarket] HTTP ${resp.status} for slug ${eventSlug}`);
      return null;
    }
    const data = await resp.json();
    const events = Array.isArray(data) ? data : [];
    const event = events.find((e) => e.slug === eventSlug);
    if (!event) return null;
    // Settled market: resolved is true and the winning outcome's price is 1.0 (100).
    if (!event.resolved) return null;
    // Find the resolved outcome.
    const markets = Array.isArray(event.markets) ? event.markets : [];
    const yes = markets.find((m) => m.outcomePrices && Array.isArray(m.outcomes)
      && m.outcomes.some((o) => (o === 'Yes' || o === 'YES')));
    if (!yes) return null;
    const outcomePrices = Array.isArray(yes.outcomePrices) ? yes.outcomePrices : [];
    const yesIndex = (yes.outcomes || []).findIndex((o) => o === 'Yes' || o === 'YES');
    const rawPrice = yesIndex >= 0 ? Number(outcomePrices[yesIndex]) : NaN;
    // Polymarket prices are [0,1] fractions. Convert to 0|100.
    const yesPrice = Number.isFinite(rawPrice) ? (rawPrice >= 0.5 ? 100 : 0) : null;
    if (yesPrice === null) return null;
    const settledAt = event.endDate || event.end_date_iso || new Date().toISOString();
    return { yesPrice, settledAt };
  } catch (err) {
    console.warn(`  [settlement:polymarket] error for ${eventSlug}: ${err.message}`);
    return null;
  }
}

// ── Kalshi settlement ─────────────────────────────────────────────────────

/**
 * Query Kalshi for a single market by ticker. Returns settled yesPrice or null.
 * @param {string} ticker  e.g. "FED-25DEC"
 */
async function fetchKalshiSettlement(ticker) {
  try {
    const resp = await fetch(`${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) {
      console.warn(`  [settlement:kalshi] HTTP ${resp.status} for ticker ${ticker}`);
      return null;
    }
    const data = await resp.json();
    const market = data?.market ?? data;
    if (!market || market.status !== 'settled') return null;
    // Kalshi result: 'yes'|'no' in market.result.
    const result = String(market.result || '').toLowerCase();
    if (result !== 'yes' && result !== 'no') return null;
    const yesPrice = result === 'yes' ? 100 : 0;
    const settledAt = market.close_time || new Date().toISOString();
    return { yesPrice, settledAt };
  } catch (err) {
    console.warn(`  [settlement:kalshi] error for ${ticker}: ${err.message}`);
    return null;
  }
}

// ── Redis helpers ─────────────────────────────────────────────────────────

async function redisPipeline(command) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Redis ${command[0]} failed: HTTP ${resp.status}`);
  return (await resp.json())?.result ?? null;
}

async function readRedisJson(key) {
  const result = await redisPipeline(['GET', key]);
  if (result == null) return null;
  try { return JSON.parse(result); } catch { return null; }
}

// ── Slug extraction from bets history ────────────────────────────────────

/**
 * Read up to HISTORY_SCAN_RUNS snapshots from the bets history and collect all
 * unique prediction_market slugs whose bets are still pending.
 */
async function collectPendingMarketSlugs() {
  const slugs = new Set();
  try {
    const raw = await redisPipeline(['LRANGE', BETS_HISTORY_KEY, 0, HISTORY_SCAN_RUNS - 1]);
    if (!Array.isArray(raw)) return slugs;
    for (const item of raw) {
      let snapshot;
      try { snapshot = typeof item === 'string' ? JSON.parse(item) : item; } catch { continue; }
      const predictions = Array.isArray(snapshot?.predictions) ? snapshot.predictions : [];
      for (const bet of predictions) {
        if (bet?.domain !== 'prediction_market') continue;
        const slug = bet?.resolution?.marketSlug;
        if (typeof slug === 'string') slugs.add(slug);
      }
    }
  } catch (err) {
    console.warn(`  [settlement] error reading bets history: ${err.message}`);
  }
  return slugs;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const pendingSlugs = await collectPendingMarketSlugs();
  if (pendingSlugs.size === 0) {
    console.log('  [settlement] no pending prediction-market slugs found; nothing to settle');
    return;
  }
  console.log(`  [settlement] checking ${pendingSlugs.size} market slug(s) for settlement...`);

  const settlements = [];
  const nowMs = Date.now();

  for (const slug of pendingSlugs) {
    const parsed = parseSlug(slug);
    if (!parsed) {
      console.warn(`  [settlement] unrecognised slug format: ${slug}`);
      continue;
    }

    let result = null;
    if (parsed.source === 'polymarket') {
      result = await fetchGammaSettlement(parsed.id);
    } else if (parsed.source === 'kalshi') {
      result = await fetchKalshiSettlement(parsed.id);
    } else {
      console.warn(`  [settlement] unknown source '${parsed.source}' in slug: ${slug}`);
    }

    if (result) {
      settlements.push({ market: slug, yesPrice: result.yesPrice, settledAt: result.settledAt });
      console.log(`  [settlement] ${slug} → yesPrice=${result.yesPrice} (settled ${result.settledAt})`);
    }
  }

  if (settlements.length === 0) {
    console.log('  [settlement] no markets settled yet; nothing written');
    return;
  }

  // Merge with any existing settlements so we don't lose previously settled markets.
  let existing = [];
  try {
    existing = (await readRedisJson(MARKETS_RESOLUTION_FEED)) ?? [];
    if (!Array.isArray(existing)) existing = [];
  } catch { existing = []; }

  const bySlug = new Map(existing.map((s) => [s.market, s]));
  for (const s of settlements) bySlug.set(s.market, s);
  const merged = [...bySlug.values()];

  try {
    await redisPipeline(['SET', MARKETS_RESOLUTION_FEED, JSON.stringify(merged), 'EX', RESOLUTION_TTL_SECONDS]);
    console.log(`  [settlement] wrote ${merged.length} settlement record(s) → ${MARKETS_RESOLUTION_FEED} (${RESOLUTION_TTL_SECONDS}s TTL)`);
  } catch (err) {
    console.warn(`  [settlement] redis write failed (transient — graceful exit): ${err.message}`);
    process.exit(GRACEFUL_FETCH_FAILURE_EXIT_CODE);
  }
}

if (DIRECT_RUN) {
  main().catch((err) => {
    console.error(`[settlement] fatal: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

export { collectPendingMarketSlugs, parseSlug };
