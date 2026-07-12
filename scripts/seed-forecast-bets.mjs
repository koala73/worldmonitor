#!/usr/bin/env node
// @ts-check
//
// Shadow bet-engine seeder (Phase 1 / #5233 re-engine).
//
// Reads resolvable energy feeds, generates crisp resolution-bound bets via the
// template registry, attaches an honest base-rate probability, and appends them
// to a SHADOW stream `forecast:bets:history:v1` tagged generationOrigin
// 'bet_engine'. It NEVER writes the user-facing canonical (forecast:predictions:
// v2) — shadow bets are invisible to users but ingested by the resolver so they
// score into the scorecard's byGenerationOrigin='bet_engine' slice (the Gate-1
// evidence). Railway cron; mirrors the seed-forecast-resolutions service.

import { loadEnvFile, getRedisCredentials, CHROME_UA, writeFreshnessMetadata } from './_seed-utils.mjs';
import { generateBets } from './_bet-templates.mjs';
import { ENERGY_BET_TEMPLATES, EIA_PETROLEUM_FEED } from './_bet-templates-energy.mjs';
import { baseRateProbability } from './_bet-baserate.mjs';
import { parseMetricKey } from './_forecast-resolution-eval.mjs';

const DIRECT_RUN = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (DIRECT_RUN) loadEnvFile(import.meta.url);

export const BETS_HISTORY_KEY = 'forecast:bets:history:v1';
const BETS_MAX_RUNS = 200;
// 45d TTL mirrors the predictions-history reach so the resolver's LRANGE 200
// window can always find a bet before it rolls out; well under the ledger's
// 180d retention (no re-ingest of pruned terminal windows).
const BETS_TTL_SECONDS = 45 * 24 * 60 * 60;
const ENERGY_FEEDS = [EIA_PETROLEUM_FEED];

// Pure: turn a feed snapshot into a resolver-ingestible bets snapshot with
// base-rate probabilities attached. Exported for tests (no I/O here).
export function buildBetsSnapshot(feedsByKey, nowMs) {
  const bets = generateBets(ENERGY_BET_TEMPLATES, feedsByKey, nowMs);
  for (const bet of bets) attachBaseRateProbability(bet, feedsByKey);
  return { generatedAt: nowMs, predictions: bets };
}

function attachBaseRateProbability(bet, feedsByKey) {
  const parsed = parseMetricKey(bet.resolution?.metricKey);
  const feed = feedsByKey?.[bet.feedKey];
  const data = feed?.data ?? feed;
  const metric = parsed ? data?.[parsed.value] : null;
  const series = [];
  const previous = Number(metric?.previous);
  if (Number.isFinite(previous)) series.push(previous);
  const baseline = Number(bet.resolution?.baselineValue);
  if (Number.isFinite(baseline)) series.push(baseline);
  const { probability } = baseRateProbability(series, bet.resolution);
  bet.probability = probability;
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

  const snapshot = buildBetsSnapshot(feedsByKey, Date.now());
  const count = snapshot.predictions.length;

  if (count > 0) {
    await redisPipeline(['LPUSH', BETS_HISTORY_KEY, JSON.stringify(snapshot)]);
    await redisPipeline(['LTRIM', BETS_HISTORY_KEY, 0, BETS_MAX_RUNS - 1]);
    await redisPipeline(['EXPIRE', BETS_HISTORY_KEY, BETS_TTL_SECONDS]);
    console.log(`  [bets] published ${count} shadow energy bet(s) -> ${BETS_HISTORY_KEY}`);
    for (const bet of snapshot.predictions) {
      console.log(`    - ${bet.question} (p=${bet.probability})`);
    }
  } else {
    console.warn('  [bets] no energy bets generated (feeds absent/unusable); nothing appended');
  }

  // Seed-meta so /api/health can monitor the shadow seeder's freshness.
  await writeFreshnessMetadata('forecast', 'bets', count, 'bet-engine:v1', BETS_TTL_SECONDS).catch((err) => {
    console.warn(`  [bets] seed-meta write failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

if (DIRECT_RUN) {
  main().catch((err) => {
    console.error(`[bets] fatal: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}
