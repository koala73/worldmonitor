#!/usr/bin/env node
// @ts-check
//
// Shadow bet-engine seeder (Phase 1 / #5233 re-engine).
//
// Reads resolvable energy feeds, generates crisp resolution-bound bets via the
// template registry, attaches a base-rate probability, and appends them to a
// SHADOW stream `forecast:bets:history:v1` tagged generationOrigin 'bet_engine'.
// It NEVER writes the user-facing canonical (forecast:predictions:v2) — shadow
// bets are invisible to users but ingested by the resolver so they score into
// the scorecard's byGenerationOrigin='bet_engine' slice (the Gate-1 evidence).
// Railway cron; mirrors the seed-forecast-resolutions service.

import {
  loadEnvFile, getRedisCredentials, CHROME_UA, writeFreshnessMetadata,
  GRACEFUL_FETCH_FAILURE_EXIT_CODE,
} from './_seed-utils.mjs';
import { generateBets } from './_bet-templates.mjs';
import { ENERGY_BET_TEMPLATES, EIA_PETROLEUM_FEED } from './_bet-templates-energy.mjs';
import { COMMODITY_BET_TEMPLATES, COMMODITY_FEED } from './_bet-templates-commodities.mjs';
import { MARKET_BET_TEMPLATES, MARKET_FEED, MARKET_SLOT_COUNT } from './_bet-templates-markets.mjs';
import { MARKET_GEO_BET_TEMPLATES, MARKET_GEO_SLOT_COUNT } from './_bet-templates-markets-geo.mjs';
import { MACRO_BET_TEMPLATES, FRED_FEED_KEYS } from './_bet-templates-macro.mjs';
import { ensembleProbability } from './_forecast-ensemble.mjs';
import { baseRateProbability } from './_bet-baserate.mjs';
import { parseMetricKey } from './_forecast-resolution-eval.mjs';
import { BETS_HISTORY_KEY } from './_forecast-bets-keys.mjs';

const DIRECT_RUN = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (DIRECT_RUN) loadEnvFile(import.meta.url);

export { BETS_HISTORY_KEY };
// Rolling per-metric observation series that the base rate is computed over.
// Deduped by the feed's own `asOf` release date so a daily cron on a weekly
// feed accumulates ONE point per real EIA release (not seven zero-deltas).
export const BETS_SERIES_KEY = 'forecast:bets:eia-series:v1';
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
// All template families + the feeds they read. Energy (EIA, weekly) has an
// accumulator-backed base rate; commodities (daily prices) are the fast-
// resolving lane; prediction-markets are the market-anchored calibration slice
// and FRED macro the market-free independence slice (#5525 Phase 2). The
// geopolitical slice (#5733) is the flagship: it reads the SAME market feed as
// the general family but on a long horizon, and is listed first so its bets
// lead the registry (slug partition keeps the two market families disjoint).
const ALL_BET_TEMPLATES = [
  ...MARKET_GEO_BET_TEMPLATES,
  ...ENERGY_BET_TEMPLATES,
  ...COMMODITY_BET_TEMPLATES,
  ...MARKET_BET_TEMPLATES,
  ...MACRO_BET_TEMPLATES,
];
const BET_FEEDS = [EIA_PETROLEUM_FEED, COMMODITY_FEED, MARKET_FEED, ...FRED_FEED_KEYS];

// Per-feed generation freshness contract. A live-price feed (commodities) kept
// warm through a multi-day outage (extendExistingTtl preserves the old
// _seed.fetchedAt) must NOT mint a "newly dated" bet from a stale price (#5243
// P2). 5 days tolerates any weekend/holiday gap but rejects a real outage.
// Period feeds (EIA weekly) are naturally days old → not listed (no cap).
// The markets feed refreshes ~30min — a >1d-old envelope means the producer is
// down and its prices are stale; FRED envelopes refresh daily → 7d cap.
const FEED_MAX_GENERATION_AGE_MS = {
  [COMMODITY_FEED]: 5 * 24 * 60 * 60 * 1000,
  [MARKET_FEED]: 24 * 60 * 60 * 1000,
  ...Object.fromEntries(FRED_FEED_KEYS.map((key) => [key, 7 * 24 * 60 * 60 * 1000])),
};

// Phase-2 ensemble stage (#5525) — OFF by default: U15 Stage A ships templates
// with base-rate probabilities and proves the new slices resolve (Gate 1.5)
// before any LLM spend is enabled (Stage B sets FORECAST_BETS_ENSEMBLE=1).
const ENSEMBLE_ENABLED = process.env.FORECAST_BETS_ENSEMBLE === '1';// Ensemble breadth. Score-only ranking puts geo (0.9) then general markets
// (0.8) ahead of energy (0.75) / commodity (0.7) / macro (0.7). Default is
// therefore: full geo slate + full general-market slate + headroom for the
// fast-resolving Gate-2 lanes (energy prices, oil commodities, top macro).
// 6 + 6 + 6 = 18. Env-overridable; the deadline guard still bounds spend, so
// this is a ceiling, not a fixed cost. Geo still ranks first and is never
// starved when the budget allows fewer attempts than K.
export const ENSEMBLE_TOP_K_DEFAULT = MARKET_GEO_SLOT_COUNT + MARKET_SLOT_COUNT + 6;
const ENSEMBLE_TOP_K = envPositiveInt('FORECAST_BETS_ENSEMBLE_TOP_K', ENSEMBLE_TOP_K_DEFAULT);
const ENSEMBLE_BUDGET_MS = envPositiveInt('FORECAST_BETS_ENSEMBLE_BUDGET_MS', 120_000);
const RESOLUTIONS_LEDGER_KEY = 'forecast:resolutions:v1';

function envPositiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

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
  const bets = generateBets(ALL_BET_TEMPLATES, unwrapped, nowMs);
  for (const bet of bets) {
    const parsed = parseMetricKey(bet.resolution?.metricKey);
    // Base rate is computed over the accumulated series keyed by the metric
    // subject (EIA metric name). Commodity symbols have no accumulator yet, so
    // their series is empty → baseRateProbability returns the honest prior.
    const values = (series[parsed?.value] || []).map((p) => Number(p.v)).filter(Number.isFinite);
    const { probability } = baseRateProbability(values, bet.resolution);
    bet.probability = probability;
    // Three-baseline contract (#5525 KTD5): the base-rate is RETAINED as the
    // recorded baseline even when the ensemble later replaces `probability`,
    // so the ensemble-vs-base-rate Brier delta stays computable per slice.
    bet.baselineProbability = probability;
    bet.probabilitySource = 'base_rate';
  }
  return { generatedAt: nowMs, predictions: bets };
}

// Phase-2 ensemble stage (#5525 U13). Ranks the snapshot's bets by
// userValueScore, runs the 3-pass ensemble on up to top-K *new* attempts, and
// replaces their probability (source 'ensemble') while keeping
// baselineProbability intact.
//
// Open-ledger skips: bets whose OPEN LEDGER WINDOW already holds a full
// ensemble probability are skipped (updateOpenWindow never downgrades, so a
// re-run adds nothing) but do NOT consume a top-K slot. Otherwise long-horizon
// geo pending windows (up to 210d) would freeze the high-score slice for
// months and starve every lower-score Gate-2 family. topK therefore means
// "up to K successful new ensemble attempts", not "first K rows of the ranked
// list including already-ensembled skips".
//
// Injected callLLM/news/openWindows keep this testable.
export async function attachEnsembleProbabilities(snapshot, options = {}) {
  const bets = snapshot?.predictions || [];
  if (!bets.length || typeof options.callLLM !== 'function') return { attempted: 0, ensembled: 0, skipped: 0 };
  const topK = Number.isFinite(options.topK) ? options.topK : ENSEMBLE_TOP_K;
  const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : Date.now() + ENSEMBLE_BUDGET_MS;
  const openEnsembleIds = options.openEnsembleIds instanceof Set ? options.openEnsembleIds : new Set();
  const news = Array.isArray(options.news) ? options.news : [];

  const ranked = [...bets].sort((a, b) => (b.userValueScore || 0) - (a.userValueScore || 0));
  let attempted = 0;
  let ensembled = 0;
  let partial = 0;
  let skipped = 0;
  for (const bet of ranked) {
    if (openEnsembleIds.has(bet.id)) { skipped += 1; continue; }
    if (attempted >= topK) break; // K new attempts filled; remaining keep base-rate
    if (Date.now() >= deadlineMs) break; // remaining bets keep the base-rate
    attempted += 1;
    try {
      const result = await ensembleProbability(bet, {
        signal: `${bet.title} — spec: ${bet.resolution?.operator} ${bet.resolution?.threshold} from baseline ${bet.resolution?.baselineValue}`,
        baseRate: bet.baselineProbability,
        news,
        marketPrice: bet.calibration?.marketPrice,
      }, options.callLLM, { deadlineMs, cache: options.cache, stageBudgetMs: options.stageBudgetMs });
      // A partial round (1-2 finite passes) is still better evidence than the
      // base rate, but it attaches under its OWN provenance: only a full
      // 'ensemble' pins the open ledger window (skip + no-downgrade guard), so
      // an 'ensemble_partial' bet is re-scored next run and upgradeable.
      if ((result.source === 'ensemble' || result.source === 'ensemble_partial') && Number.isFinite(result.probability)) {
        bet.probability = result.probability;
        bet.probabilitySource = result.source;
        bet.passes = result.passes;
      }
      if (result.source === 'ensemble') ensembled += 1;
      else if (result.source === 'ensemble_partial') partial += 1;
    } catch (err) {
      console.warn(`  [bets] ensemble failed for ${bet.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { attempted, ensembled, partial, skipped };
}

// Ids of pending ledger entries whose open window already carries a FULL
// ensemble-sourced probability (re-scoring them would be wasted spend — the
// resolver's updateOpenWindow guard would ignore a downgrade anyway).
// 'ensemble_partial' windows are deliberately NOT indexed: a degraded 1-2 pass
// round must be retried until a full round lands.
export function collectOpenEnsembleIds(ledger) {
  const entries = ledger && typeof ledger === 'object'
    ? (Array.isArray(ledger) ? ledger : Object.values(ledger.data ?? ledger))
    : [];
  const ids = new Set();
  for (const entry of entries) {
    if (entry && entry.status === 'pending' && entry.probabilitySource === 'ensemble' && entry.id) ids.add(entry.id);
  }
  return ids;
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
  const snapshot = buildBetsSnapshot(feedsByKey, nowMs, priorSeries);
  const nextSeries = computeNextSeries(feedsByKey, priorSeries);
  const count = snapshot.predictions.length;

  // Stage B (#5525 U15): the LLM ensemble replaces the base-rate for top-K
  // bets. Dynamic imports keep Stage A (flag off) light — the seeder never
  // loads the 18k-line forecast module or the resolver until enabled. Any
  // failure here leaves every bet on its honest base-rate.
  if (ENSEMBLE_ENABLED && count > 0) {
    try {
      const [{ callForecastLLM }, resolutions] = await Promise.all([
        import('./seed-forecasts.mjs'),
        import('./seed-forecast-resolutions.mjs'),
      ]);
      const ledger = await readRedisJson(RESOLUTIONS_LEDGER_KEY).catch(() => null);
      const openEnsembleIds = collectOpenEnsembleIds(ledger || {});
      let news = [];
      try {
        const archive = await resolutions.readDigestAccumulatorArchive(nowMs - 3 * 24 * 60 * 60 * 1000, nowMs, { maxHashes: 300 });
        news = (archive?.items || []).map((item) => item?.title).filter(Boolean).slice(0, 12);
      } catch (err) {
        console.warn(`  [bets] news archive unavailable for ensemble evidence: ${err instanceof Error ? err.message : String(err)}`);
      }
      const stats = await attachEnsembleProbabilities(snapshot, {
        callLLM: callForecastLLM,
        openEnsembleIds,
        news,
        topK: ENSEMBLE_TOP_K,
        deadlineMs: Date.now() + ENSEMBLE_BUDGET_MS,
      });
      console.log(`  [bets] ensemble: attempted=${stats.attempted} ensembled=${stats.ensembled} partial=${stats.partial} skipped-open=${stats.skipped} (K=${ENSEMBLE_TOP_K})`);
    } catch (err) {
      console.warn(`  [bets] ensemble stage failed (bets keep base-rate): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Redis writes are best-effort for a non-user-facing shadow seeder: a
  // transient Upstash blip must exit graceful (self-heals next run), not page.
  try {
    if (count > 0) {
      await redisPipeline(['LPUSH', BETS_HISTORY_KEY, JSON.stringify(snapshot)]);
      await redisPipeline(['LTRIM', BETS_HISTORY_KEY, 0, BETS_MAX_RUNS - 1]);
      await redisPipeline(['EXPIRE', BETS_HISTORY_KEY, BETS_TTL_SECONDS]);
      await redisPipeline(['SET', BETS_SERIES_KEY, JSON.stringify(nextSeries), 'EX', SERIES_TTL_SECONDS]);
      const byDomain = snapshot.predictions.reduce((acc, b) => {
        acc[b.domain] = (acc[b.domain] || 0) + 1;
        return acc;
      }, {});
      const breakdown = Object.entries(byDomain).map(([d, n]) => `${d}:${n}`).join(', ');
      console.log(`  [bets] published ${count} shadow bet(s) [${breakdown}] -> ${BETS_HISTORY_KEY}`);
      for (const bet of snapshot.predictions) {
        console.log(`    - ${bet.question} (p=${bet.probability})`);
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
