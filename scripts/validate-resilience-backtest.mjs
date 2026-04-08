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
 *   node scripts/validate-resilience-backtest.mjs
 *
 * Requires: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (via .env.local)
 */

import { getRedisCredentials, loadEnvFile } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v2:';

const BASELINE_DIMENSIONS = new Set([
  'macroFiscal',
  'governanceInstitutional',
  'socialCohesion',
  'infrastructure',
  'healthPublicService',
]);

const MIXED_DIMENSIONS = new Set([
  'logisticsSupply',
  'energy',
  'foodWater',
]);

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
  try { return JSON.parse(data.result); } catch { return null; }
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
  const dimensions = scoreResponse?.domains?.flatMap((d) => d.dimensions) ?? [];
  if (dimensions.length === 0) return null;

  let weightedSum = 0;
  let totalCoverage = 0;

  for (const dim of dimensions) {
    const isBaseline = BASELINE_DIMENSIONS.has(dim.id);
    const isMixed = MIXED_DIMENSIONS.has(dim.id);
    if (!isBaseline && !isMixed) continue;

    const factor = isMixed ? 0.5 : 1.0;
    const effectiveCoverage = dim.coverage * factor;
    weightedSum += dim.score * effectiveCoverage;
    totalCoverage += effectiveCoverage;
  }

  return totalCoverage > 0 ? weightedSum / totalCoverage : null;
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

  const scores = new Map();
  for (let i = 0; i < countryCodes.length; i++) {
    const raw = results[i]?.result;
    if (typeof raw !== 'string') continue;
    try { scores.set(countryCodes[i], JSON.parse(raw)); } catch { /* skip */ }
  }
  return scores;
}

async function runBacktest() {
  const { url, token } = getRedisCredentials();

  console.log('=== BACKTESTING: RESILIENCE PREDICTS RECOVERY ===\n');

  const gateResults = [];

  for (const shock of SHOCKS) {
    const countryCodes = Object.keys(shock.affectedCountries);
    const scores = await fetchScoresForCountries(url, token, countryCodes);

    console.log(`Shock: ${shock.name}`);
    console.log(`  Countries: ${countryCodes.length}`);
    console.log(`  Recovery metric: ${shock.recoveryLabel}`);

    const pairs = [];

    for (const cc of countryCodes) {
      const scoreData = scores.get(cc);
      const baseline = scoreData ? computeBaselineScore(scoreData) : null;
      const recovery = shock.affectedCountries[cc].recovery;

      if (baseline != null) {
        pairs.push({ cc, baseline, recovery, overall: scoreData.overallScore });
      } else {
        console.log(`  [WARN] ${cc}: no cached score in Redis`);
      }
    }

    if (pairs.length < 3) {
      console.log(`  Note: only ${pairs.length} countries with scores, too few for correlation`);
      console.log('');
      continue;
    }

    const baselines = pairs.map((p) => p.baseline);
    const recoveries = pairs.map((p) => p.recovery);
    const r = pearsonCorrelation(baselines, recoveries);
    const direction = r > 0 ? 'POSITIVE' : 'NEGATIVE';
    const interpretation = r > 0 ? 'faster' : 'slower';

    console.log(`  Scored: ${pairs.length}/${countryCodes.length}`);
    console.log(`  Correlation (baseline vs recovery): r = ${r.toFixed(3)}`);
    console.log(`  Direction: ${direction} (expect positive)`);
    console.log(`  Interpretation: Countries with higher baseline recovered ${interpretation}`);

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
