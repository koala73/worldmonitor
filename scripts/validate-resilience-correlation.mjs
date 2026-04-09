#!/usr/bin/env node

import { loadEnvFile, getRedisCredentials } from './_seed-utils.mjs';

// Source of truth: server/worldmonitor/resilience/v1/_shared.ts → RESILIENCE_SCORE_CACHE_PREFIX
const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v6:';

const REFERENCE_INDICES = {
  ndgain: {
    NO: 0.76, IS: 0.72, NZ: 0.71, DK: 0.74, SE: 0.73, FI: 0.72, CH: 0.73, AU: 0.70,
    CA: 0.70, US: 0.67, DE: 0.68, GB: 0.67, FR: 0.65, JP: 0.66, KR: 0.63, IT: 0.59,
    ES: 0.60, PL: 0.57, BR: 0.45, MX: 0.44, TR: 0.47, TH: 0.44, MY: 0.50, CN: 0.47,
    IN: 0.37, ZA: 0.41, EG: 0.38, PK: 0.30, NG: 0.26, KE: 0.33, BD: 0.31, VN: 0.40,
    PH: 0.38, ID: 0.42, UA: 0.43, RU: 0.44, AF: 0.20, YE: 0.17, SO: 0.15, HT: 0.22,
    SS: 0.14, CF: 0.18, SD: 0.19, ML: 0.25, NE: 0.22, TD: 0.20, SY: 0.21, IQ: 0.30,
    MM: 0.28, VE: 0.30, IR: 0.35, ET: 0.26,
  },
  inform: {
    NO: 1.8, IS: 1.5, NZ: 2.1, DK: 1.7, SE: 1.9, FI: 1.6, CH: 1.4, AU: 2.3,
    CA: 2.0, US: 3.1, DE: 2.2, GB: 2.4, FR: 2.5, JP: 3.0, KR: 2.3, IT: 2.6,
    ES: 2.4, PL: 2.1, BR: 4.1, MX: 4.5, TR: 4.0, TH: 3.5, MY: 3.0, CN: 4.2,
    IN: 5.5, ZA: 4.3, EG: 4.8, PK: 6.2, NG: 6.5, KE: 5.0, BD: 5.8, VN: 3.8,
    PH: 5.2, ID: 4.8, UA: 5.5, RU: 4.5, AF: 8.0, YE: 8.5, SO: 8.8, HT: 7.2,
    SS: 8.3, CF: 8.1, SD: 8.4, ML: 6.8, NE: 7.0, TD: 7.5, SY: 7.8, IQ: 6.8,
    MM: 7.0, VE: 5.8, IR: 5.0, ET: 7.2,
  },
};

const SAMPLE_COUNTRIES = Object.keys(REFERENCE_INDICES.ndgain);

async function redisPipeline(url, token, commands) {
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`Redis pipeline HTTP ${resp.status}`);
  return resp.json();
}

function toRanks(values) {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array(values.length);
  let pos = 0;
  while (pos < indexed.length) {
    let end = pos + 1;
    while (end < indexed.length && indexed[end].v === indexed[pos].v) end++;
    const avgRank = (pos + end + 1) / 2;
    for (let k = pos; k < end; k++) ranks[indexed[k].i] = avgRank;
    pos = end;
  }
  return ranks;
}

function pearson(x, y) {
  const n = x.length;
  if (n < 3) return NaN;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denominator === 0) return 0;
  return numerator / denominator;
}

function spearmanRho(x, y) {
  return pearson(toRanks(x), toRanks(y));
}

async function fetchWorldMonitorScores(url, token, countryCodes) {
  const commands = countryCodes.map((c) => ['GET', `${RESILIENCE_SCORE_CACHE_PREFIX}${c}`]);
  const results = await redisPipeline(url, token, commands);

  const scores = new Map();
  for (let i = 0; i < countryCodes.length; i++) {
    const raw = results[i]?.result;
    if (typeof raw !== 'string') continue;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.overallScore === 'number' && parsed.overallScore > 0) {
        scores.set(countryCodes[i], parsed.overallScore);
      }
    } catch { /* skip */ }
  }
  return scores;
}

function computeCorrelation(wmScores, referenceScores, invert = false) {
  const paired = [];
  for (const [iso2, wmScore] of wmScores.entries()) {
    const refScore = referenceScores[iso2];
    if (refScore == null) continue;
    paired.push({
      iso2,
      wm: wmScore,
      ref: invert ? -refScore : refScore,
    });
  }

  if (paired.length < 10) {
    return { rho: NaN, n: paired.length, divergences: [] };
  }

  const wmValues = paired.map((p) => p.wm);
  const refValues = paired.map((p) => p.ref);
  const rho = spearmanRho(wmValues, refValues);

  const wmRanks = toRanks(wmValues);
  const refRanks = toRanks(refValues);
  const divergences = paired.map((p, i) => ({
    iso2: p.iso2,
    wmRank: Math.round(wmRanks[i]),
    refRank: Math.round(refRanks[i]),
    delta: Math.abs(Math.round(wmRanks[i]) - Math.round(refRanks[i])),
  }));
  divergences.sort((a, b) => b.delta - a.delta);

  return { rho, n: paired.length, divergences };
}

function padRight(str, len) {
  return str + ' '.repeat(Math.max(0, len - str.length));
}

async function run() {
  loadEnvFile(import.meta.url);
  const { url, token } = getRedisCredentials();

  console.log(`Fetching WorldMonitor resilience scores for ${SAMPLE_COUNTRIES.length} countries...`);
  const wmScores = await fetchWorldMonitorScores(url, token, SAMPLE_COUNTRIES);
  console.log(`Retrieved scores for ${wmScores.size}/${SAMPLE_COUNTRIES.length} countries\n`);

  if (wmScores.size < 20) {
    console.error('Too few scores available. Ensure resilience scores are cached in Redis.');
    process.exit(1);
  }

  const ndgainResult = computeCorrelation(wmScores, REFERENCE_INDICES.ndgain, false);
  const informResult = computeCorrelation(wmScores, REFERENCE_INDICES.inform, true);

  console.log('=== EXTERNAL INDEX CORRELATION ===\n');

  const ndgainPass = ndgainResult.rho > 0.65;
  const informPass = informResult.rho > 0.60;

  console.log(`WorldMonitor vs ND-GAIN Readiness:  rho = ${ndgainResult.rho.toFixed(3)} (n=${ndgainResult.n}, target > 0.65) ${ndgainPass ? 'PASS' : 'FAIL'}`);
  console.log(`WorldMonitor vs INFORM Risk:        rho = ${informResult.rho.toFixed(3)} (n=${informResult.n}, target > 0.60, inverted) ${informPass ? 'PASS' : 'FAIL'}`);

  const passingCount = [ndgainPass, informPass].filter(Boolean).length;
  const gatePass = passingCount >= 2;
  console.log(`\nGATE CHECK: rho > 0.6 for at least 2 indices? ${gatePass ? 'YES' : 'NO'} (${passingCount}/2 passing)\n`);

  for (const [label, result] of [['ND-GAIN', ndgainResult], ['INFORM', informResult]]) {
    console.log(`Top divergences vs ${label} (countries that rank very differently):`);
    const top5 = result.divergences.slice(0, 5);
    for (const d of top5) {
      console.log(`  ${padRight(d.iso2 + ':', 5)} WM rank ${padRight(String(d.wmRank), 3)}, ${label} rank ${padRight(String(d.refRank), 3)} (delta ${d.delta})`);
    }
    console.log('');
  }

  const allCountriesSorted = [...wmScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([iso2, score], i) => ({ iso2, score, rank: i + 1 }));

  console.log('WorldMonitor score ranking (sample):');
  console.log('  Rank  ISO2  Score');
  for (const entry of allCountriesSorted) {
    console.log(`  ${padRight(String(entry.rank), 6)}${padRight(entry.iso2, 6)}${entry.score.toFixed(1)}`);
  }

  return { ndgainRho: ndgainResult.rho, informRho: informResult.rho, gatePass };
}

const isMain = process.argv[1]?.endsWith('validate-resilience-correlation.mjs');
if (isMain) {
  run().catch((err) => {
    console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export { run, spearmanRho, toRanks, pearson, computeCorrelation, REFERENCE_INDICES, SAMPLE_COUNTRIES };
