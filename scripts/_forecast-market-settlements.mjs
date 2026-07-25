// Prediction-market settlement loader for the forecast resolver (#5525 KTD2).
//
// The bootstrap feed only ever contains open markets, so due market bets query
// their venue for an adjudicated outcome and append it to the dedicated
// settlement feed. Live I/O remains injectable so the parser, failure, dedupe,
// and health-meta paths stay hermetic in tests.

import { CHROME_UA } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { MARKET_SETTLEMENT_FEED_KEY } from './_forecast-resolution-eval.mjs';

const GAMMA_SETTLEMENT_BASE = 'https://gamma-api.polymarket.com';
const KALSHI_SETTLEMENT_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const SETTLEMENT_TTL_SECONDS = 45 * 24 * 60 * 60;
const SETTLEMENT_FETCH_CAP_PER_RUN = 10;

// Health-monitoring companion for the settlement feed (AGENTS.md: Redis seed
// scripts MUST write seed-meta:<key>). Registered in api/health.js SEED_META.
export const MARKET_SETTLEMENT_META_KEY = 'seed-meta:prediction:markets-resolution';

// Pure: extract a settled yesPrice (0-100) from a Gamma events-by-slug reply.
// Returns null while unsettled/ambiguous — never a guess. A multi-market event
// whose children don't title-match the bet is ambiguous: settling on the first
// closed child would grade the bet with another market's outcome.
export function parseGammaSettlement(eventsJson, title) {
  const events = Array.isArray(eventsJson) ? eventsJson : [];
  const wanted = normalizeTitle(title);
  for (const event of events) {
    const markets = Array.isArray(event?.markets) ? event.markets : [];
    const byTitle = markets.find((market) => normalizeTitle(market?.question) === wanted);
    const candidate = byTitle ?? (markets.length === 1 ? markets[0] : null);
    if (!candidate || !candidate.closed) continue;
    const outcomes = parseJsonArray(candidate.outcomes);
    const prices = parseJsonArray(candidate.outcomePrices);
    if (!outcomes.length || outcomes.length !== prices.length) continue;
    const yesIndex = outcomes.findIndex((outcome) => String(outcome).trim().toLowerCase() === 'yes');
    if (yesIndex < 0) continue;
    const price = Number(prices[yesIndex]);
    if (!Number.isFinite(price)) continue;
    return Math.round(price * 100);
  }
  return null;
}

// Pure: extract a settled yesPrice (0-100) from a Kalshi market reply.
export function parseKalshiSettlement(marketJson) {
  const market = marketJson?.market ?? marketJson;
  const status = String(market?.status || '').toLowerCase();
  if (status !== 'settled' && status !== 'finalized') return null;
  const result = String(market?.result || '').toLowerCase();
  if (result === 'yes') return 100;
  if (result === 'no') return 0;
  return null;
}

function normalizeTitle(value) {
  // Trailing '?' is stripped because the bet title is normalizeQuestion(venue
  // title) — a '?' appended to statement-form titles.
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?\s]+$/, '');
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchVenueSettlement(entry) {
  const headers = { 'User-Agent': CHROME_UA };
  if (entry.marketSource === 'kalshi') {
    const resp = await fetch(`${KALSHI_SETTLEMENT_BASE}/markets/${encodeURIComponent(entry.marketSlug)}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`kalshi ${entry.marketSlug}: HTTP ${resp.status}`);
    return parseKalshiSettlement(await resp.json());
  }
  const resp = await fetch(`${GAMMA_SETTLEMENT_BASE}/events?slug=${encodeURIComponent(entry.marketSlug)}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`gamma ${entry.marketSlug}: HTTP ${resp.status}`);
  return parseGammaSettlement(await resp.json(), entry.title);
}

async function writeRedisJson(key, value, ttlSeconds) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(['SET', key, JSON.stringify(value), 'EX', ttlSeconds]),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Redis SET ${key} failed: HTTP ${resp.status}`);
}

// Best-effort: fetch adjudicated outcomes for due market bets and append them
// to the settlement feed. Failures warn and skip — bets stay pending inside the
// settlement grace, so a missed run self-heals on the next cycle.
export async function updateMarketSettlements(ledger, nowMs, options = {}) {
  const fetchSettlement = options.fetchSettlement || fetchVenueSettlement;
  const readJson = options.readJson;
  const writeJson = options.writeJson || writeRedisJson;
  if (typeof readJson !== 'function') throw new TypeError('updateMarketSettlements requires readJson');

  // Write the seed-meta companion on every run, including zero-due and
  // fail-closed cycles, so health tracks the writer rather than market cadence.
  const finalize = async (stats, recordCount) => {
    await Promise.resolve(writeJson(MARKET_SETTLEMENT_META_KEY, {
      fetchedAt: nowMs,
      recordCount,
      ...stats,
    }, SETTLEMENT_TTL_SECONDS))
      .catch((err) => console.warn(`  [forecast-resolutions] settlement seed-meta write failed: ${err?.message || err}`));
    return stats;
  };

  const due = Object.values(normalizeLedger(ledger)).filter((entry) => entry?.status === 'pending'
    && entry.spec?.sourceFeed === MARKET_SETTLEMENT_FEED_KEY
    && Number(entry.deadline) <= nowMs
    && typeof entry.marketSlug === 'string' && entry.marketSlug)
    // Oldest deadline first: a backlog above the cap must drain the entries
    // nearest their VOID grace.
    .sort((a, b) => Number(a.deadline) - Number(b.deadline));
  if (!due.length) return finalize({ fetched: 0, settled: 0 }, null);

  // Fail closed on read errors: rebuilding from [] could wipe adjudications.
  let existing;
  try {
    existing = await Promise.resolve(readJson(MARKET_SETTLEMENT_FEED_KEY));
  } catch (err) {
    console.warn(`  [forecast-resolutions] settlement feed read failed — skipping settlement cycle: ${err?.message || err}`);
    return finalize({ fetched: 0, settled: 0 }, null);
  }
  const records = Array.isArray(existing?.records) ? [...existing.records] : [];
  const have = new Set(records.map((record) => record?.slug).filter(Boolean));
  // A venue-moved endDate can create multiple ledger windows for one slug.
  const targets = [...new Map(
    due.filter((entry) => !have.has(entry.marketSlug)).map((entry) => [entry.marketSlug, entry]),
  ).values()].slice(0, SETTLEMENT_FETCH_CAP_PER_RUN);

  let settled = 0;
  for (const entry of targets) {
    try {
      const yesPrice = await fetchSettlement(entry);
      if (yesPrice == null) continue;
      records.push({ market: entry.title, slug: entry.marketSlug, yesPrice, asOf: nowMs });
      settled += 1;
    } catch (err) {
      console.warn(`  [forecast-resolutions] settlement fetch failed for ${entry.marketSlug}: ${err?.message || err}`);
    }
  }
  if (settled > 0) {
    await Promise.resolve(writeJson(
      MARKET_SETTLEMENT_FEED_KEY,
      { records, updatedAt: nowMs },
      SETTLEMENT_TTL_SECONDS,
    )).catch((err) => console.warn(`  [forecast-resolutions] settlement write failed: ${err?.message || err}`));
  }
  return finalize({ fetched: targets.length, settled }, records.length);
}

function normalizeLedger(ledger) {
  const data = unwrapEnvelope(ledger).data;
  if (!data) return {};
  if (Array.isArray(data)) {
    return Object.fromEntries(data.filter(Boolean).map((entry) => [
      entry.key || `${entry.id}@${entry.deadline}`,
      entry,
    ]));
  }
  return typeof data === 'object' ? data : {};
}
