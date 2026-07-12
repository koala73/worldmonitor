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
const ENERGY_FEEDS = [EIA_PETROLEUM_FEED];

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
  const unwrapped = unwrapFeeds(feedsByKey);
  const series = computeNextSeries(unwrapped, priorSeries);
  const bets = generateBets(ENERGY_BET_TEMPLATES, unwrapped, nowMs);
  for (const bet of bets) {
    const parsed = parseMetricKey(bet.resolution?.metricKey);
    const values = (series[parsed?.value] || []).map((p) => Number(p.v)).filter(Number.isFinite);
    const { probability } = baseRateProbability(values, bet.resolution);
    bet.probability = probability;
  }
  return { generatedAt: nowMs, predictions: bets };
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
  for (const key of ENERGY_FEEDS) {
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

  // Redis writes are best-effort for a non-user-facing shadow seeder: a
  // transient Upstash blip must exit graceful (self-heals next run), not page.
  try {
    if (count > 0) {
      await redisPipeline(['LPUSH', BETS_HISTORY_KEY, JSON.stringify(snapshot)]);
      await redisPipeline(['LTRIM', BETS_HISTORY_KEY, 0, BETS_MAX_RUNS - 1]);
      await redisPipeline(['EXPIRE', BETS_HISTORY_KEY, BETS_TTL_SECONDS]);
      await redisPipeline(['SET', BETS_SERIES_KEY, JSON.stringify(nextSeries), 'EX', SERIES_TTL_SECONDS]);
      console.log(`  [bets] published ${count} shadow energy bet(s) -> ${BETS_HISTORY_KEY}`);
      for (const bet of snapshot.predictions) {
        console.log(`    - ${bet.question} (p=${bet.probability})`);
      }
    } else {
      console.warn('  [bets] no energy bets generated (feeds absent/unusable); nothing appended');
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
