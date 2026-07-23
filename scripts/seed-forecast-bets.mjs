#!/usr/bin/env node
// @ts-check
//
// Shadow bet-engine seeder (Phase 2 / #5238 re-engine).
//
// Reads resolvable energy, prediction-market, and FRED macro feeds, generates
// crisp resolution-bound bets via the template registry, attaches a calibrated
// ensemble probability (or base-rate when ENSEMBLE_ENABLED=false for Stage A),
// and appends them to a SHADOW stream `forecast:bets:history:v1` tagged
// generationOrigin 'bet_engine'. It NEVER writes the user-facing canonical
// (forecast:predictions:v2) — shadow bets are invisible to users but ingested
// by the resolver so they score into scorecard.byGenerationOrigin='bet_engine'.
// Railway cron; mirrors the seed-forecast-resolutions service.
//
// Stage A (Gate 1.5): BET_ENGINE_ENSEMBLE_ENABLED=false (default) — base-rate only.
// Stage B (Gate 2):   BET_ENGINE_ENSEMBLE_ENABLED=true  — 3-pass LLM ensemble.

import {
  loadEnvFile, getRedisCredentials, CHROME_UA, writeFreshnessMetadata,
  GRACEFUL_FETCH_FAILURE_EXIT_CODE,
} from './_seed-utils.mjs';
import { generateBets } from './_bet-templates.mjs';
import { ENERGY_BET_TEMPLATES, EIA_PETROLEUM_FEED } from './_bet-templates-energy.mjs';
import { COMMODITY_BET_TEMPLATES, COMMODITY_FEED } from './_bet-templates-commodities.mjs';
import { buildMarketTemplates, MARKETS_BOOTSTRAP_FEED, MARKETS_RESOLUTION_FEED } from './_bet-templates-markets.mjs';
import { MACRO_BET_TEMPLATES, MACRO_FEEDS } from './_bet-templates-macro.mjs';
import { baseRateProbability } from './_bet-baserate.mjs';
import { parseMetricKey } from './_forecast-resolution-eval.mjs';
import { runEnsemble } from './_forecast-ensemble.mjs';
import { BETS_HISTORY_KEY } from './_forecast-bets-keys.mjs';
// callForecastLLM is imported lazily (only used when ENSEMBLE_ENABLED=true) to
// keep Stage A free of the 19k-line seed-forecasts dependency in tests.
import { callForecastLLM } from './seed-forecasts.mjs';

const DIRECT_RUN = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (DIRECT_RUN) loadEnvFile(import.meta.url);

export { BETS_HISTORY_KEY };
export { MARKETS_RESOLUTION_FEED };

// Rolling per-metric observation series that the base rate is computed over.
// Deduped by the feed's own `asOf` release date so a daily cron on a weekly
// feed accumulates ONE point per real EIA release (not seven zero-deltas).
export const BETS_SERIES_KEY = 'forecast:bets:eia-series:v1';
// Persistent registry of ALL market slugs ever generated, keyed forever so
// the settlement seeder can query them even after they age out of the 200-run
// bets-history window. TTL = 90d (matches RESOLUTION_TTL_SECONDS in settlement
// seeder). The seeder merges new slugs in on each run (P1 fix).
export const MARKET_SLUGS_KEY = 'forecast:bets:market-slugs:v1';
export const MARKET_SLUGS_TTL_SECONDS = 90 * 24 * 60 * 60;
const BETS_MAX_RUNS = 200;
// 45d TTL mirrors the predictions-history reach so the resolver's LRANGE 200
// window can always find a bet before it rolls out; well under the ledger's
// 180d retention (no re-ingest of pruned terminal windows).
const BETS_TTL_SECONDS = 45 * 24 * 60 * 60;
// The observation series is a long-lived accumulator (base-rate needs many
// releases to be meaningful) — keep it well beyond the bets TTL.
const SERIES_TTL_SECONDS = 400 * 24 * 60 * 60;
const SERIES_CAP = 104; // ~2 years of weekly EIA releases
const EIA_METRICS = ['inventory', 'production', 'wti', 'brent'];

// ── Stage flags ───────────────────────────────────────────────────────────
// Stage A (Gate 1.5): ensemble off — base-rate probability only.
// Stage B (Gate 2):   set BET_ENGINE_ENSEMBLE_ENABLED=true to activate.
const ENSEMBLE_ENABLED = process.env.BET_ENGINE_ENSEMBLE_ENABLED === 'true';
// Per-run budget for the ensemble phase (3 passes × 35s, with concurrency).
const ENSEMBLE_RUN_BUDGET_MS = 120_000;
// Top-K bets selected by userValueScore desc before ensemble is applied.
// Env-tunable: BET_ENGINE_TOP_K (min 1, max 20).
const TOP_K = Math.min(20, Math.max(1, Number(process.env.BET_ENGINE_TOP_K) || 6));

// ── Feed registry ─────────────────────────────────────────────────────────
// All template families + the feeds they read.
// Market templates are built dynamically from the bootstrap feed at run time
// (one template per live market), so they are NOT in this static list.
const STATIC_BET_TEMPLATES = [...ENERGY_BET_TEMPLATES, ...COMMODITY_BET_TEMPLATES, ...MACRO_BET_TEMPLATES];
const BET_FEEDS = [EIA_PETROLEUM_FEED, COMMODITY_FEED, MARKETS_BOOTSTRAP_FEED, ...MACRO_FEEDS];


// Per-feed generation freshness contract. A live-price feed (commodities) kept
// warm through a multi-day outage (extendExistingTtl preserves the old
// _seed.fetchedAt) must NOT mint a "newly dated" bet from a stale price (#5243
// P2). 5 days tolerates any weekend/holiday gap but rejects a real outage.
// Period feeds (EIA weekly) are naturally days old → not listed (no cap).
const FEED_MAX_GENERATION_AGE_MS = { [COMMODITY_FEED]: 5 * 24 * 60 * 60 * 1000 };

// Drop feeds whose envelope predates their freshness contract, so their
// templates receive no data and generate no bet. Pure (no I/O / console).
function filterFreshFeeds(feedsByKey, nowMs) {
  const out = {};
  for (const [key, value] of Object.entries(feedsByKey || {})) {
    const maxAge = FEED_MAX_GENERATION_AGE_MS[key];
    if (maxAge != null) {
      const fetchedAt = Number(value?._seed?.fetchedAt);
      if (Number.isFinite(fetchedAt) && nowMs - fetchedAt > maxAge) continue; // stale → drop
    }
    out[key] = value;
  }
  return out;
}

function unwrapFeeds(feedsByKey) {
  const unwrapped = {};
  for (const [key, value] of Object.entries(feedsByKey || {})) {
    unwrapped[key] = value && typeof value === 'object' && value.data != null ? value.data : value;
  }
  return unwrapped;
}

// Pure: append this run's readings to the rolling series, deduped by asOf date.
// A run whose feed hasn't published a new release (same asOf as the last point)
// updates that point in place instead of adding a duplicate — so consecutive
// daily ticks on a weekly feed never inject spurious zero-move deltas.
export function computeNextSeries(feedsByKey, priorSeries = {}, cap = SERIES_CAP) {
  const data = unwrapFeeds(feedsByKey)[EIA_PETROLEUM_FEED];
  const next = {};
  for (const name of EIA_METRICS) {
    const prior = Array.isArray(priorSeries?.[name])
      ? priorSeries[name].filter((p) => p && Number.isFinite(Number(p.v)))
      : [];
    const current = Number(data?.[name]?.current);
    if (!Number.isFinite(current)) { next[name] = prior.slice(-cap); continue; }
    const point = { d: data?.[name]?.date || null, v: current };
    const last = prior[prior.length - 1];
    if (last && last.d && point.d && last.d === point.d) {
      next[name] = [...prior.slice(0, -1), point].slice(-cap); // same release → replace
    } else {
      next[name] = [...prior, point].slice(-cap);
    }
  }
  return next;
}

// Pure: generate bets and attach a base-rate probability computed over the REAL
// accumulated observation series (thin history honestly falls back to a
// directional prior inside baseRateProbability). Exported for tests (no I/O).
export function buildBetsSnapshot(feedsByKey, nowMs, priorSeries = {}) {
  const fresh = filterFreshFeeds(feedsByKey, nowMs);
  const unwrapped = unwrapFeeds(fresh);
  const series = computeNextSeries(fresh, priorSeries);

  // Dynamic market templates: built from the bootstrap feed each run.
  const marketFeed = unwrapped[MARKETS_BOOTSTRAP_FEED];
  const marketTemplates = marketFeed ? buildMarketTemplates(marketFeed, nowMs) : [];

  const allTemplates = [...STATIC_BET_TEMPLATES, ...marketTemplates];
  const allBets = generateBets(allTemplates, unwrapped, nowMs);

  // Attach base-rate probabilities to every bet (used both in Stage A and as
  // the scorecard's baselineProbability in Stage B for Brier comparison).
  // calibration is already emitted by generateBets() via template.buildCalibration (KTD5).
  // P1 fix: for FRED bets the EIA accumulator has no entries — use the template's
  // own historical observations (stored as bet._baseRateHistory by generateBets).
  for (const bet of allBets) {
    const parsed = parseMetricKey(bet.resolution?.metricKey);
    const accumulatorValues = (series[parsed?.value] || []).map((p) => Number(p.v)).filter(Number.isFinite);
    // Prefer accumulator (rich, release-deduped); fall back to template history
    // (from metric.observations — up to 24 FRED obs) when accumulator is empty.
    const values = accumulatorValues.length > 0
      ? accumulatorValues
      : (Array.isArray(bet._baseRateHistory) ? bet._baseRateHistory : []);
    const { probability } = baseRateProbability(values, bet.resolution);
    bet._baseRateProbability = probability;
    delete bet._baseRateHistory; // clean up before top-K snapshot
  }

  // Sort by userValueScore desc, take top-K.
  const sorted = [...allBets].sort((a, b) => (Number(b.userValueScore) || 0) - (Number(a.userValueScore) || 0));
  const topK = sorted.slice(0, TOP_K);

  // Stage A: base-rate only.
  for (const bet of topK) {
    bet.probability = bet._baseRateProbability;
    bet.baselineProbability = bet._baseRateProbability;
    bet.probabilitySource = 'base_rate';
    delete bet._baseRateProbability;
  }

  return { generatedAt: nowMs, predictions: topK };
}

// Stage B: attach ensemble probabilities to each bet in the snapshot.
// Returns a new snapshot with updated probabilities and pass metadata.
// This is async (3 LLM calls per bet in parallel).
export async function applyEnsembleProbabilities(snapshot, feedsByKey) {
  if (!snapshot?.predictions?.length) return snapshot;
  const nowMs = snapshot.generatedAt || Date.now();
  const deadline = Date.now() + ENSEMBLE_RUN_BUDGET_MS;

  const updated = await Promise.allSettled(
    snapshot.predictions.map(async (bet) => {
      if (Date.now() > deadline) {
        // Budget exhausted — keep base-rate for this bet.
        return bet;
      }
      const context = buildBetContext(bet, feedsByKey);
      try {
        const result = await runEnsemble(
          bet.resolution?.question || bet.question,
          context,
          callForecastLLM,
          { baseRateFallback: bet.baselineProbability, budgetMs: 35_000 },
        );
        return {
          ...bet,
          probability: result.probability,
          probabilitySource: result.method === 'ensemble' ? 'ensemble' : 'base_rate',
          passes: result.passes,
          // baselineProbability is already set from Stage A; keep it for scorecard.
        };
      } catch {
        // All-fail with no baseRateFallback should not happen (we always pass one),
        // but guard defensively: keep the base-rate.
        return bet;
      }
    }),
  );

  const predictions = updated.map((r, i) =>
    r.status === 'fulfilled' ? r.value : snapshot.predictions[i],
  );
  return { ...snapshot, predictions };
}

function buildBetContext(bet, feedsByKey) {
  const parts = [];
  if (bet.resolution?.question) parts.push(bet.resolution.question);
  // Add a brief snippet of the feed value as grounding context.
  const feedKey = bet.resolution?.sourceFeed;
  const feedData = feedsByKey?.[feedKey];
  const baseline = bet.resolution?.baselineValue;
  if (Number.isFinite(baseline)) parts.push(`Current value: ${baseline}`);
  if (feedData) {
    const ts = feedData?._seed?.fetchedAt || feedData?.fetchedAt;
    if (ts) parts.push(`Data as of: ${new Date(Number(ts)).toISOString().slice(0, 10)}`);
  }
  return parts.join('. ').slice(0, 400);
}


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

async function main() {
  const feedsByKey = {};
  for (const key of BET_FEEDS) {
    try {
      feedsByKey[key] = await readRedisJson(key);
    } catch (err) {
      console.warn(`  [bets] feed ${key} unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const priorSeries = (await readRedisJson(BETS_SERIES_KEY).catch(() => null)) || {};
  const nowMs = Date.now();
  let snapshot = buildBetsSnapshot(feedsByKey, nowMs, priorSeries);

  if (ENSEMBLE_ENABLED && snapshot.predictions.length > 0) {
    console.log(`  [bets] ensemble enabled: scoring ${snapshot.predictions.length} bet(s) ...`);
    snapshot = await applyEnsembleProbabilities(snapshot, feedsByKey);
    const ensembleCount = snapshot.predictions.filter((b) => b.probabilitySource === 'ensemble').length;
    console.log(`  [bets] ensemble: ${ensembleCount}/${snapshot.predictions.length} used ensemble (rest: base_rate fallback)`);
  } else if (ENSEMBLE_ENABLED) {
    console.log('  [bets] ensemble enabled but no bets generated — skipping LLM calls');
  }

  const nextSeries = computeNextSeries(feedsByKey, priorSeries);
  const count = snapshot.predictions.length;

  // Redis writes are best-effort for a non-user-facing shadow seeder: a
  // transient Upstash blip must exit graceful (self-heals next run), not page.
  try {
    if (count > 0) {
      await redisPipeline(['LPUSH', BETS_HISTORY_KEY, JSON.stringify(snapshot)]);
      await redisPipeline(['LTRIM', BETS_HISTORY_KEY, 0, BETS_MAX_RUNS - 1]);
      await redisPipeline(['EXPIRE', BETS_HISTORY_KEY, BETS_TTL_SECONDS]);
      await redisPipeline(['SET', BETS_SERIES_KEY, JSON.stringify(nextSeries), 'EX', SERIES_TTL_SECONDS]);

      // P1 fix: persist market slugs in a long-lived registry so the settlement
      // seeder can find them even after they age out of the 200-run bets-history
      // window. Merge new slugs with any existing ones (idempotent — a Set dedupes).
      const newSlugs = snapshot.predictions
        .filter((b) => b.domain === 'prediction_market' && b.resolution?.marketSlug)
        .map((b) => b.resolution.marketSlug);
      if (newSlugs.length > 0) {
        const existingSlugsRaw = await readRedisJson(MARKET_SLUGS_KEY).catch(() => null);
        const existingSlugs = Array.isArray(existingSlugsRaw) ? existingSlugsRaw : [];
        const mergedSlugs = [...new Set([...existingSlugs, ...newSlugs])];
        await redisPipeline(['SET', MARKET_SLUGS_KEY, JSON.stringify(mergedSlugs), 'EX', MARKET_SLUGS_TTL_SECONDS]);
        console.log(`  [bets] slug registry: ${mergedSlugs.length} market slug(s) persisted -> ${MARKET_SLUGS_KEY}`);
      }

      const byDomain = snapshot.predictions.reduce((acc, b) => {
        acc[b.domain] = (acc[b.domain] || 0) + 1;
        return acc;
      }, {});
      const breakdown = Object.entries(byDomain).map(([d, n]) => `${d}:${n}`).join(', ');
      const srcBreakdown = snapshot.predictions.reduce((acc, b) => {
        const src = b.probabilitySource || 'unknown';
        acc[src] = (acc[src] || 0) + 1;
        return acc;
      }, {});
      const srcStr = Object.entries(srcBreakdown).map(([s, n]) => `${s}:${n}`).join(', ');
      console.log(`  [bets] published ${count} shadow bet(s) [domain: ${breakdown}] [source: ${srcStr}] -> ${BETS_HISTORY_KEY}`);
      for (const bet of snapshot.predictions) {
        console.log(`    - ${bet.question} (p=${bet.probability}, src=${bet.probabilitySource})`);
      }
    } else {
      console.warn('  [bets] no bets generated (feeds absent/unusable); nothing appended');
    }
    await writeFreshnessMetadata('forecast', 'bets', count, 'bet-engine:v1', BETS_TTL_SECONDS);
  } catch (err) {
    console.warn(`  [bets] redis write failed (transient — graceful exit): ${err instanceof Error ? err.message : String(err)}`);
    process.exit(GRACEFUL_FETCH_FAILURE_EXIT_CODE);
  }
}


if (DIRECT_RUN) {
  main().catch((err) => {
    console.error(`[bets] fatal: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}
