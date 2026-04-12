#!/usr/bin/env node

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRedisCredentials, loadEnvFile } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALIDATION_DIR = join(__dirname, '..', 'docs', 'methodology', 'country-resilience-index', 'validation');

const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v8:';
const BACKTEST_RESULT_KEY = 'resilience:backtest:outcomes:v1';
const BACKTEST_TTL_SECONDS = 7 * 24 * 60 * 60;

const AUC_THRESHOLD = 0.75;
const GATE_WIDTH = 0.03;

const SOVEREIGN_STRESS_COUNTRIES_2024_2025 = new Set([
  'AR', 'LK', 'GH', 'ZM', 'ET', 'UA', 'LB', 'SV', 'PK', 'BD',
  'BO', 'EG', 'TN', 'KE', 'NG',
]);

const EVENT_FAMILIES = [
  {
    id: 'fx-stress',
    label: 'FX Stress',
    description: 'Currency depreciation >= 15% in 12 months',
    redisKey: 'economic:bis:eer:v1',
    detect: detectFxStress,
    dataSource: 'live',
  },
  {
    id: 'sovereign-stress',
    label: 'Sovereign Stress',
    description: 'Sovereign credit downgrade or debt restructuring 2024-2025',
    redisKey: null,
    detect: detectSovereignStress,
    dataSource: 'hardcoded',
  },
  {
    id: 'power-outages',
    label: 'Power Outages',
    description: 'Major grid outage affecting >= 1M people',
    redisKey: 'infra:outages:v1',
    detect: detectPowerOutages,
    dataSource: 'live',
  },
  {
    id: 'food-crisis',
    label: 'Food Crisis Escalation',
    description: 'IPC Phase 3+ escalation',
    redisKey: 'resilience:static:fao',
    detect: detectFoodCrisis,
    dataSource: 'live',
  },
  {
    id: 'refugee-surges',
    label: 'Refugee Surges',
    description: '>= 100k new displacement in 12 months',
    redisKey: 'displacement:summary:v1',
    detect: detectRefugeeSurges,
    dataSource: 'live',
  },
  {
    id: 'sanctions-shocks',
    label: 'Sanctions Shocks',
    description: 'New comprehensive sanctions package',
    redisKey: 'sanctions:country-counts:v1',
    detect: detectSanctionsShocks,
    dataSource: 'live',
  },
  {
    id: 'conflict-spillover',
    label: 'Conflict Spillover',
    description: 'Armed conflict spreading to a previously-stable neighbor',
    redisKey: 'conflict:ucdp-events:v1',
    detect: detectConflictSpillover,
    dataSource: 'live',
  },
];

function computeAuc(predictions, labels) {
  const n = predictions.length;
  if (n === 0) return 0.5;

  const positiveCount = labels.filter(Boolean).length;
  const negativeCount = n - positiveCount;

  if (positiveCount === 0 || negativeCount === 0) return 0.5;

  const indexed = predictions.map((pred, i) => ({ pred, label: labels[i] }));
  indexed.sort((a, b) => b.pred - a.pred);

  let tp = 0;
  let fp = 0;
  let auc = 0;
  let prevTp = 0;
  let prevFp = 0;
  let prevPred = -Infinity;

  for (let i = 0; i < indexed.length; i++) {
    if (indexed[i].pred !== prevPred && i > 0) {
      auc += trapezoidArea(prevFp, fp, prevTp, tp);
      prevTp = tp;
      prevFp = fp;
    }
    if (indexed[i].label) {
      tp++;
    } else {
      fp++;
    }
    prevPred = indexed[i].pred;
  }
  auc += trapezoidArea(prevFp, fp, prevTp, tp);

  return auc / (positiveCount * negativeCount);
}

function trapezoidArea(x1, x2, y1, y2) {
  return Math.abs(x2 - x1) * (y1 + y2) / 2;
}

function checkGate(auc, threshold, gateWidth) {
  return auc >= (threshold - gateWidth);
}

async function redisGetJson(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data?.result) return null;
  try {
    return JSON.parse(data.result);
  } catch {
    return typeof data.result === 'string' ? data.result : null;
  }
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

async function redisSet(url, token, key, value, ttl) {
  const args = ['SET', key, JSON.stringify(value)];
  if (ttl) args.push('EX', String(ttl));
  const resp = await fetch(`${url}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    console.warn(`[WARN] Failed to write ${key} to Redis: HTTP ${resp.status}`);
  }
}

async function fetchAllResilienceScores(url, token) {
  const ALL_COUNTRIES = [
    'AF','AL','DZ','AD','AO','AG','AR','AM','AU','AT','AZ','BS','BH','BD','BB',
    'BY','BE','BZ','BJ','BT','BO','BA','BW','BR','BN','BG','BF','BI','CV','KH',
    'CM','CA','CF','TD','CL','CN','CO','KM','CG','CD','CR','CI','HR','CU','CY',
    'CZ','DK','DJ','DM','DO','EC','EG','SV','GQ','ER','EE','SZ','ET','FJ','FI',
    'FR','GA','GM','GE','DE','GH','GR','GD','GT','GN','GW','GY','HT','HN','HU',
    'IS','IN','ID','IR','IQ','IE','IL','IT','JM','JP','JO','KZ','KE','KI','KP',
    'KR','KW','KG','LA','LV','LB','LS','LR','LY','LI','LT','LU','MG','MW','MY',
    'MV','ML','MT','MH','MR','MU','MX','FM','MD','MC','MN','ME','MA','MZ','MM',
    'NA','NR','NP','NL','NZ','NI','NE','NG','MK','NO','OM','PK','PW','PA','PG',
    'PY','PE','PH','PL','PT','QA','RO','RU','RW','KN','LC','VC','WS','SM','ST',
    'SA','SN','RS','SC','SL','SG','SK','SI','SB','SO','ZA','SS','ES','LK','SD',
    'SR','SE','CH','SY','TW','TJ','TZ','TH','TL','TG','TO','TT','TN','TR','TM',
    'TV','UG','UA','AE','GB','US','UY','UZ','VU','VE','VN','YE','ZM','ZW',
  ];

  const commands = ALL_COUNTRIES.map((cc) => ['GET', `${RESILIENCE_SCORE_CACHE_PREFIX}${cc}`]);
  const batchSize = 50;
  const scores = new Map();

  for (let i = 0; i < commands.length; i += batchSize) {
    const batch = commands.slice(i, i + batchSize);
    const batchCodes = ALL_COUNTRIES.slice(i, i + batchSize);
    const results = await redisPipeline(url, token, batch);

    for (let j = 0; j < batchCodes.length; j++) {
      const raw = results[j]?.result;
      if (typeof raw !== 'string') continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.overallScore != null) {
          scores.set(batchCodes[j], parsed.overallScore);
        }
      } catch { /* skip */ }
    }
  }

  return scores;
}

function detectFxStress(data, _allCountries) {
  const labels = new Map();
  if (!data || typeof data !== 'object') return labels;

  if (Array.isArray(data)) {
    for (const entry of data) {
      const cc = (entry.country || entry.iso2 || entry.cc || '').toUpperCase();
      if (!cc || cc.length !== 2) continue;
      const change = entry.yoyChange ?? entry.change ?? entry.depreciation;
      if (typeof change === 'number' && Number.isFinite(change)) {
        labels.set(cc, change <= -15);
      }
    }
    return labels;
  }

  const nested = data.countries || data.data;
  if (Array.isArray(nested)) {
    for (const entry of nested) {
      const cc = (entry.country || entry.iso2 || entry.cc || '').toUpperCase();
      if (!cc || cc.length !== 2) continue;
      const change = entry.yoyChange ?? entry.change ?? entry.depreciation;
      if (typeof change === 'number' && Number.isFinite(change)) {
        labels.set(cc, change <= -15);
      }
    }
    return labels;
  }

  for (const [cc, val] of Object.entries(data)) {
    if (cc.length !== 2) continue;
    const series = Array.isArray(val) ? val : (val?.series || val?.values || []);
    if (!Array.isArray(series) || series.length < 2) continue;
    const latest = Number(series[series.length - 1]?.value ?? series[series.length - 1]);
    const yearAgo = Number(series[0]?.value ?? series[0]);
    if (Number.isFinite(latest) && Number.isFinite(yearAgo) && yearAgo !== 0) {
      const change = (latest - yearAgo) / Math.abs(yearAgo);
      labels.set(cc.toUpperCase(), change <= -0.15);
    }
  }

  return labels;
}

function detectSovereignStress(_data, _allCountries) {
  const labels = new Map();
  for (const cc of SOVEREIGN_STRESS_COUNTRIES_2024_2025) {
    labels.set(cc, true);
  }
  return labels;
}

function detectPowerOutages(data, _allCountries) {
  const labels = new Map();
  if (!data || typeof data !== 'object') return labels;

  const events = Array.isArray(data) ? data : (data.events || data.outages || []);
  if (!Array.isArray(events)) return labels;

  for (const event of events) {
    const cc = (event.country || event.iso2 || event.cc || '').toUpperCase();
    if (!cc || cc.length !== 2) continue;
    const affected = event.affected ?? event.customersAffected ?? event.population ?? 0;
    if (typeof affected === 'number' && affected >= 1_000_000) {
      labels.set(cc, true);
    }
  }

  return labels;
}

function detectFoodCrisis(data, _allCountries) {
  const labels = new Map();
  if (!data || typeof data !== 'object') return labels;

  const processEntry = (entry, cc) => {
    if (!cc || cc.length !== 2) return;
    const phase = entry.ipcPhase ?? entry.phase ?? entry.ipc_phase;
    if (typeof phase === 'number' && phase >= 3) {
      labels.set(cc.toUpperCase(), true);
    }
    const text = entry.fcsPhase ?? entry.classification ?? '';
    if (typeof text === 'string' && /phase\s*[345]/i.test(text)) {
      labels.set(cc.toUpperCase(), true);
    }
  };

  if (Array.isArray(data)) {
    for (const entry of data) {
      processEntry(entry, entry.country || entry.iso2 || entry.cc);
    }
  } else if (data.countries) {
    for (const [cc, val] of Object.entries(data.countries)) {
      processEntry(val, cc);
    }
  } else {
    for (const [cc, val] of Object.entries(data)) {
      if (cc.length === 2 && val && typeof val === 'object') {
        processEntry(val, cc);
      }
    }
  }

  return labels;
}

function detectRefugeeSurges(data, _allCountries) {
  const labels = new Map();
  if (!data || typeof data !== 'object') return labels;

  if (Array.isArray(data)) {
    for (const entry of data) {
      const cc = (entry.country || entry.iso2 || entry.cc || entry.origin || '').toUpperCase();
      if (!cc || cc.length !== 2) continue;
      const displaced = entry.newDisplacement ?? entry.displaced ?? entry.totalDisplaced ?? entry.refugees ?? 0;
      if (typeof displaced === 'number' && displaced >= 100_000) {
        labels.set(cc, true);
      }
    }
    return labels;
  }

  const nested = data.countries || data.summaries;
  if (Array.isArray(nested)) {
    for (const entry of nested) {
      const cc = (entry.country || entry.iso2 || entry.cc || entry.origin || '').toUpperCase();
      if (!cc || cc.length !== 2) continue;
      const displaced = entry.newDisplacement ?? entry.displaced ?? entry.totalDisplaced ?? entry.refugees ?? 0;
      if (typeof displaced === 'number' && displaced >= 100_000) {
        labels.set(cc, true);
      }
    }
    return labels;
  }

  for (const [cc, val] of Object.entries(data)) {
    if (cc.length !== 2) continue;
    const displaced = typeof val === 'number' ? val :
      (val?.newDisplacement ?? val?.displaced ?? val?.totalDisplaced ?? 0);
    if (typeof displaced === 'number' && displaced >= 100_000) {
      labels.set(cc.toUpperCase(), true);
    }
  }

  return labels;
}

function detectSanctionsShocks(data, _allCountries) {
  const labels = new Map();
  if (!data || typeof data !== 'object') return labels;

  if (Array.isArray(data)) {
    for (const entry of data) {
      const cc = (entry.country || entry.iso2 || entry.cc || '').toUpperCase();
      if (!cc || cc.length !== 2) continue;
      const count = entry.count ?? entry.sanctions ?? entry.newSanctions ?? 0;
      if (typeof count === 'number' && count > 0) {
        labels.set(cc, true);
      }
    }
  } else {
    for (const [cc, val] of Object.entries(data)) {
      if (cc.length !== 2) continue;
      const count = typeof val === 'number' ? val : (val?.count ?? val?.total ?? 0);
      if (typeof count === 'number' && count > 0) {
        labels.set(cc.toUpperCase(), true);
      }
    }
  }

  return labels;
}

function detectConflictSpillover(data, _allCountries) {
  const labels = new Map();
  if (!data || typeof data !== 'object') return labels;

  if (Array.isArray(data)) {
    const countryCounts = new Map();
    for (const event of data) {
      const cc = (event.country || event.iso2 || event.cc || '').toUpperCase();
      if (!cc || cc.length !== 2) continue;
      countryCounts.set(cc, (countryCounts.get(cc) || 0) + 1);
    }
    for (const [cc, count] of countryCounts) {
      if (count > 0) labels.set(cc, true);
    }
    return labels;
  }

  const nested = data.events || data.conflicts;
  if (Array.isArray(nested)) {
    const countryCounts = new Map();
    for (const event of nested) {
      const cc = (event.country || event.iso2 || event.cc || '').toUpperCase();
      if (!cc || cc.length !== 2) continue;
      countryCounts.set(cc, (countryCounts.get(cc) || 0) + 1);
    }
    for (const [cc, count] of countryCounts) {
      if (count > 0) labels.set(cc, true);
    }
    return labels;
  }

  for (const [cc, val] of Object.entries(data)) {
    if (cc.length !== 2) continue;
    const count = typeof val === 'number' ? val : (val?.events ?? val?.count ?? 0);
    if (typeof count === 'number' && count > 0) {
      labels.set(cc.toUpperCase(), true);
    }
  }

  return labels;
}

function findFalseNegatives(scores, labels, limit = 3) {
  const entries = [];
  for (const [cc, label] of labels) {
    if (label && scores.has(cc)) {
      entries.push({ cc, score: scores.get(cc) });
    }
  }
  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, limit).map((e) => e.cc);
}

function findFalsePositives(scores, labels, allCountries, limit = 3) {
  const entries = [];
  for (const cc of allCountries) {
    if (!labels.get(cc) && scores.has(cc)) {
      entries.push({ cc, score: scores.get(cc) });
    }
  }
  entries.sort((a, b) => a.score - b.score);
  return entries.slice(0, limit).map((e) => e.cc);
}

async function runBacktest() {
  const { url, token } = getRedisCredentials();

  console.log('=== OUTCOME BACKTEST: RESILIENCE vs REAL-WORLD EVENTS ===');
  console.log(`Holdout period: 2024-2025`);
  console.log(`AUC threshold: ${AUC_THRESHOLD} (gate width: ${GATE_WIDTH})`);
  console.log('');

  const scores = await fetchAllResilienceScores(url, token);
  console.log(`Loaded resilience scores for ${scores.size} countries`);
  if (scores.size < 50) {
    console.error('FATAL: Too few resilience scores loaded from Redis');
    return null;
  }
  console.log('');

  const allCountries = [...scores.keys()];
  const familyResults = [];

  for (const family of EVENT_FAMILIES) {
    console.log(`--- ${family.label} (${family.id}) ---`);
    console.log(`  Source: ${family.dataSource === 'hardcoded' ? 'hardcoded reference list' : family.redisKey}`);

    let rawData = null;
    if (family.redisKey) {
      rawData = await redisGetJson(url, token, family.redisKey);
      if (!rawData) {
        console.log(`  [WARN] No data at ${family.redisKey}, using empty set`);
      }
    }

    const eventLabels = family.detect(rawData, allCountries);
    const positiveCountries = [...eventLabels.entries()].filter(([, v]) => v).map(([k]) => k);

    const aligned = [];
    for (const cc of allCountries) {
      if (!scores.has(cc)) continue;
      const score = scores.get(cc);
      const label = eventLabels.get(cc) === true;
      aligned.push({ cc, score, label });
    }

    if (family.id === 'sovereign-stress') {
      let skippedCount = 0;
      for (const cc of SOVEREIGN_STRESS_COUNTRIES_2024_2025) {
        if (!aligned.find((a) => a.cc === cc)) {
          const score = scores.get(cc);
          if (score == null) {
            skippedCount++;
            continue;
          }
          aligned.push({ cc, score, label: true });
        }
      }
      if (skippedCount > 0) {
        console.warn(`[${family.id}] Skipped ${skippedCount} sovereign-stress countries absent from cache`);
      }
    }

    const predictions = aligned.map((a) => 100 - a.score);
    const labels = aligned.map((a) => a.label);
    const positiveCount = labels.filter(Boolean).length;

    let auc = 0.5;
    let pass = false;

    if (positiveCount > 0 && positiveCount < aligned.length) {
      auc = computeAuc(predictions, labels);
      pass = checkGate(auc, AUC_THRESHOLD, GATE_WIDTH);
    } else if (positiveCount === 0) {
      console.log(`  [WARN] No positive events detected, AUC defaults to 0.5`);
      pass = false;
    }

    const topFalseNegatives = findFalseNegatives(scores, eventLabels, 3);
    const topFalsePositives = findFalsePositives(scores, eventLabels, allCountries, 3);

    const result = {
      id: family.id,
      label: family.label,
      description: family.description,
      dataSource: family.dataSource,
      auc: Math.round(auc * 1000) / 1000,
      threshold: AUC_THRESHOLD,
      gateWidth: GATE_WIDTH,
      pass,
      n: aligned.length,
      positives: positiveCount,
      topFalseNegatives,
      topFalsePositives,
    };

    familyResults.push(result);

    console.log(`  Countries aligned: ${aligned.length}`);
    console.log(`  Positive events: ${positiveCount} (${positiveCountries.slice(0, 10).join(', ')}${positiveCountries.length > 10 ? '...' : ''})`);
    console.log(`  AUC: ${result.auc.toFixed(3)}`);
    console.log(`  Gate: ${pass ? 'PASS' : 'FAIL'} (need >= ${(AUC_THRESHOLD - GATE_WIDTH).toFixed(2)})`);
    console.log(`  Top false negatives (high resilience, got hit): ${topFalseNegatives.join(', ') || 'none'}`);
    console.log(`  Top false positives (low resilience, survived): ${topFalsePositives.join(', ') || 'none'}`);
    console.log('');
  }

  const overallPass = familyResults.every((f) => f.pass);
  const passCount = familyResults.filter((f) => f.pass).length;

  const output = {
    generatedAt: Date.now(),
    holdoutPeriod: '2024-2025',
    aucThreshold: AUC_THRESHOLD,
    gateWidth: GATE_WIDTH,
    families: familyResults,
    overallPass,
    summary: {
      totalFamilies: familyResults.length,
      passed: passCount,
      failed: familyResults.length - passCount,
      totalCountries: scores.size,
    },
  };

  try {
    await redisSet(url, token, BACKTEST_RESULT_KEY, output, BACKTEST_TTL_SECONDS);
    console.log(`Results written to Redis: ${BACKTEST_RESULT_KEY} (TTL: ${BACKTEST_TTL_SECONDS}s)`);
  } catch (err) {
    console.warn(`[WARN] Failed to write to Redis: ${err.message}`);
  }

  try {
    mkdirSync(VALIDATION_DIR, { recursive: true });
    const jsonPath = join(VALIDATION_DIR, 'backtest-results.json');
    writeFileSync(jsonPath, JSON.stringify(output, null, 2) + '\n');
    console.log(`Results written to: ${jsonPath}`);
  } catch (err) {
    console.warn(`[WARN] Failed to write JSON: ${err.message}`);
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log('');
  console.log('Family                    AUC    Gate   Status');
  console.log('------------------------  -----  -----  ------');
  for (const f of familyResults) {
    const name = f.label.padEnd(24);
    const auc = f.auc.toFixed(3);
    const gate = (f.threshold - f.gateWidth).toFixed(2);
    const status = f.pass ? 'PASS' : 'FAIL';
    console.log(`${name}  ${auc}  ${gate}   ${status}`);
  }
  console.log('');
  console.log(`Overall: ${passCount}/${familyResults.length} families passed. ${overallPass ? 'ALL GATES MET.' : 'SOME GATES FAILED.'}`);

  return output;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('backtest-resilience-outcomes.mjs');
if (isMain) {
  runBacktest().catch((err) => {
    console.error(`FATAL: ${err.message || err}`);
    process.exitCode = 1;
  });
}

export {
  computeAuc,
  trapezoidArea,
  checkGate,
  detectFxStress,
  detectSovereignStress,
  detectPowerOutages,
  detectFoodCrisis,
  detectRefugeeSurges,
  detectSanctionsShocks,
  detectConflictSpillover,
  findFalseNegatives,
  findFalsePositives,
  EVENT_FAMILIES,
  SOVEREIGN_STRESS_COUNTRIES_2024_2025,
  AUC_THRESHOLD,
  GATE_WIDTH,
  runBacktest,
};
