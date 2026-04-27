#!/usr/bin/env node

/**
 * Backtesting framework: tests whether baseline resilience predicts recovery
 * speed after known historical shocks.
 *
 * For each shock, computes Pearson correlation between each affected country's
 * baseline resilience score (from live Redis) and its GDP growth at T+2 (from
 * IMF WEO hardcoded values). A positive correlation means countries with higher
 * baseline capacity recovered faster.
 *
 * Limitation: baseline scores are current (live Redis), not historical at T-1.
 * This is directionally useful because baseline dimensions (governance, infra,
 * health, macro) move slowly, but it is not a true time-series backtest.
 *
 * Usage:
 *   npx tsx scripts/validate-resilience-backtest.mjs
 *
 * Requires: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (via .env.local)
 * Note: Uses tsx so it can import the TypeScript scorer as a fallback when
 *       cached scores are missing from Redis.
 */

import { getRedisCredentials, loadEnvFile } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

// Source of truth: server/worldmonitor/resilience/v1/_shared.ts
const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v16:';

// Mirror of _shared.ts#currentCacheFormula — must stay in lockstep so
// the backtest only ingests same-formula cache entries. A mixed-formula
// cohort would confound the recovery-prediction correlations.
function currentCacheFormulaLocal() {
  const combine = (process.env.RESILIENCE_PILLAR_COMBINE_ENABLED ?? 'false').toLowerCase() === 'true';
  const v2 = (process.env.RESILIENCE_SCHEMA_V2_ENABLED ?? 'true').toLowerCase() === 'true';
  return combine && v2 ? 'pc' : 'd6';
}

const MIN_SCORED_COUNTRIES = 5;

let _scoreAllDimensions = null;
let _RESILIENCE_DIMENSION_TYPES = null;
try {
  const mod = await import('../server/worldmonitor/resilience/v1/_dimension-scorers.ts');
  _scoreAllDimensions = mod.scoreAllDimensions;
  _RESILIENCE_DIMENSION_TYPES = mod.RESILIENCE_DIMENSION_TYPES;
} catch {
  console.warn('[WARN] Could not import scorer (run with npx tsx for live fallback)');
}

const SHOCKS = [
  {
    name: 'COVID-19 pandemic (2020)',
    year: 2020,
    recoveryLabel: 'GDP growth 2022 (T+2)',
    affectedCountries: {
      US: { recovery: 1.9 },
      DE: { recovery: 1.8 },
      GB: { recovery: 4.3 },
      FR: { recovery: 2.5 },
      JP: { recovery: 1.0 },
      IT: { recovery: 3.7 },
      BR: { recovery: 2.9 },
      IN: { recovery: 7.2 },
      MX: { recovery: 3.9 },
      ZA: { recovery: 1.9 },
      TR: { recovery: 5.5 },
      ID: { recovery: 5.3 },
      PH: { recovery: 7.6 },
      TH: { recovery: 2.6 },
      NG: { recovery: 3.3 },
      KE: { recovery: 4.8 },
      EG: { recovery: 6.7 },
      PK: { recovery: 6.2 },
    },
  },
  {
    name: 'Energy crisis (2022)',
    year: 2022,
    recoveryLabel: 'GDP growth 2024 (T+2)',
    affectedCountries: {
      DE: { recovery: 0.0 },
      FR: { recovery: 1.1 },
      IT: { recovery: 0.7 },
      GB: { recovery: 0.1 },
      PL: { recovery: 2.9 },
      ES: { recovery: 2.5 },
      NL: { recovery: 0.7 },
      SE: { recovery: 0.9 },
      FI: { recovery: -0.2 },
      NO: { recovery: 0.7 },
      DK: { recovery: 2.6 },
      CH: { recovery: 1.5 },
      US: { recovery: 2.8 },
      JP: { recovery: -0.2 },
      KR: { recovery: 2.2 },
    },
  },
  {
    name: 'Turkey earthquake (2023)',
    year: 2023,
    recoveryLabel: 'GDP growth 2024 (T+1)',
    affectedCountries: {
      TR: { recovery: 3.2 },
      GR: { recovery: 2.1 },
      BG: { recovery: 1.9 },
      RO: { recovery: 1.4 },
    },
  },
];

const MIN_SAMPLE_FOR_GATE = 8;

async function redisGetJson(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data?.result) return null;
  try {
    // Envelope-aware: unwrapEnvelope returns bare payload for contract-mode
    // {_seed, data} shapes (PR #3097) and passes legacy raw payloads through.
    return unwrapEnvelope(JSON.parse(data.result)).data;
  } catch { return null; }
}

async function redisPipeline(url, token, commands) {
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

function computeBaselineScore(scoreResponse) {
  const score = scoreResponse?.baselineScore;
  return (typeof score === 'number' && Number.isFinite(score)) ? score : null;
}

async function getBaselineScore(url, token, countryCode, scoreData) {
  const cached = scoreData ? computeBaselineScore(scoreData) : null;
  if (cached != null) return cached;

  if (!_scoreAllDimensions || !_RESILIENCE_DIMENSION_TYPES) return null;

  try {
    const reader = async (key) => redisGetJson(url, token, key);
    const dims = await _scoreAllDimensions(countryCode, reader);
    const baselineDims = Object.entries(dims)
      .filter(([id]) => {
        const type = _RESILIENCE_DIMENSION_TYPES[id];
        return type === 'baseline' || type === 'mixed';
      })
      .map(([, d]) => d);
    const totalCov = baselineDims.reduce((s, d) => s + d.coverage, 0);
    if (totalCov === 0) return null;
    return baselineDims.reduce((s, d) => s + d.score * d.coverage, 0) / totalCov;
  } catch (err) {
    console.log(`  [WARN] ${countryCode}: live scoring failed (${err.message})`);
    return null;
  }
}

function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;

  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;

  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  const denom = Math.sqrt(sumX2 * sumY2);
  return denom > 0 ? sumXY / denom : 0;
}

async function fetchScoresForCountries(url, token, countryCodes) {
  const commands = countryCodes.map((cc) => ['GET', `${RESILIENCE_SCORE_CACHE_PREFIX}${cc}`]);
  const results = await redisPipeline(url, token, commands);
  const current = currentCacheFormulaLocal();
  let staleFormulaSkipped = 0;

  const scores = new Map();
  for (let i = 0; i < countryCodes.length; i++) {
    const raw = results[i]?.result;
    if (typeof raw !== 'string') continue;
    try {
      const parsed = JSON.parse(raw);
      // Cross-formula gate: only ingest same-formula entries. A
      // mixed-formula cohort would produce a meaningless correlation
      // between baseline resilience and post-shock recovery.
      if (parsed?._formula !== current) {
        staleFormulaSkipped++;
        continue;
      }
      scores.set(countryCodes[i], parsed);
    } catch { /* skip */ }
  }
  if (staleFormulaSkipped > 0) {
    console.warn(`[validate-resilience-backtest] skipped ${staleFormulaSkipped} stale-formula entries (current=${current})`);
  }
  return scores;
}

async function runBacktest() {
  const { url, token } = getRedisCredentials();

  console.log('=== BACKTESTING: RESILIENCE PREDICTS RECOVERY ===\n');

  const gateResults = [];
  let evaluatedShocks = 0;

  for (const shock of SHOCKS) {
    const countryCodes = Object.keys(shock.affectedCountries);
    const scores = await fetchScoresForCountries(url, token, countryCodes);

    console.log(`Shock: ${shock.name}`);
    console.log(`  Countries: ${countryCodes.length}`);
    console.log(`  Recovery metric: ${shock.recoveryLabel}`);

    const pairs = [];

    for (const cc of countryCodes) {
      const scoreData = scores.get(cc);
      const baseline = await getBaselineScore(url, token, cc, scoreData);
      const recovery = shock.affectedCountries[cc].recovery;

      if (baseline != null) {
        const overall = scoreData?.overallScore ?? baseline;
        pairs.push({ cc, baseline, recovery, overall });
      } else {
        console.log(`  [WARN] ${cc}: no cached score and live scoring unavailable`);
      }
    }

    if (pairs.length < MIN_SCORED_COUNTRIES) {
      console.log(`  Skipped: only ${pairs.length} countries scored (need >= ${MIN_SCORED_COUNTRIES})`);
      console.log('');
      continue;
    }

    const baselines = pairs.map((p) => p.baseline);
    const recoveries = pairs.map((p) => p.recovery);
    const r = pearsonCorrelation(baselines, recoveries);
    const direction = r > 0 ? 'POSITIVE' : r === 0 ? 'NEUTRAL' : 'NEGATIVE';
    const interpretation = r > 0
      ? 'Countries with higher baseline recovered faster'
      : r === 0
        ? 'No clear relationship between baseline and recovery'
        : 'Countries with higher baseline recovered slower';

    evaluatedShocks++;
    console.log(`  Scored: ${pairs.length}/${countryCodes.length}`);
    console.log(`  Correlation (baseline vs recovery): r = ${r.toFixed(3)}`);
    console.log(`  Direction: ${direction} (expect positive)`);
    console.log(`  Interpretation: ${interpretation}`);

    if (pairs.length < MIN_SAMPLE_FOR_GATE) {
      console.log(`  Note: sample too small (${pairs.length} < ${MIN_SAMPLE_FOR_GATE}) for gate check`);
    } else {
      gateResults.push({ name: shock.name, r, direction, n: pairs.length });
    }

    console.log('');
    console.log('  Per-country detail:');
    const sorted = [...pairs].sort((a, b) => b.baseline - a.baseline);
    for (const p of sorted) {
      console.log(`    ${p.cc}  baseline=${p.baseline.toFixed(1)}  overall=${p.overall.toFixed(1)}  recovery=${p.recovery.toFixed(1)}%`);
    }
    console.log('');
  }

  if (evaluatedShocks === 0) {
    console.error('FATAL: No shocks had enough scored countries. Check Redis/scorer.');
    process.exit(1);
  }

  const positiveCount = gateResults.filter((g) => g.r > 0).length;
  const totalGatable = gateResults.length;
  const gatePass = totalGatable >= 2 && positiveCount >= Math.ceil(totalGatable * 2 / 3);

  console.log('=== SUMMARY ===\n');
  for (const g of gateResults) {
    console.log(`  ${g.name}: r=${g.r.toFixed(3)} (${g.direction}, n=${g.n})`);
  }
  if (gateResults.length === 0) {
    console.log('  No shocks had sufficient sample size for gate check');
  }

  console.log('');
  console.log(`GATE CHECK: Positive correlation for >= 2/${totalGatable} gatable shocks? ${gatePass ? 'YES' : 'NO'} (${positiveCount}/${totalGatable} positive)`);

  return { gatePass, positiveCount, totalGatable, gateResults };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('validate-resilience-backtest.mjs');
if (isMain) {
  runBacktest().catch((err) => {
    console.error(`FATAL: ${err.message || err}`);
    process.exit(1);
  });
}

export { runBacktest, computeBaselineScore, pearsonCorrelation, SHOCKS };
