#!/usr/bin/env node
// @ts-check
/**
 * Seed economic stress composite index (0-100) from 6 FRED series.
 * Reads pre-seeded FRED keys from Redis (written by seed-economy.mjs).
 * Redis key: economic:stress-index:v1, TTL: 6h
 *
 * Components:
 *   T10Y2Y  — 10Y-2Y Yield Curve Spread    (weight 0.20)
 *   T10Y3M  — 10Y-3M Yield Curve Spread    (weight 0.15)
 *   VIXCLS  — VIX Volatility Index         (weight 0.20)
 *   STLFSI4 — St. Louis Fed FSI v2         (weight 0.20)
 *   GSCPI   — NY Fed Supply Chain Pressure (weight 0.15)
 *   ICSA    — Initial Jobless Claims       (weight 0.10)
 */
import { loadEnvFile, runSeed, getRedisCredentials } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:stress-index:v1';
const CACHE_TTL = 21600; // 6h

const FRED_KEY_PREFIX = 'economic:fred:v1';

/** @param {number} v */
function clamp(v) {
  return Math.min(100, Math.max(0, v));
}

const COMPONENTS = [
  {
    id: 'T10Y2Y',
    label: 'Yield Curve',
    weight: 0.20,
    /** @param {number} v */
    score: (v) => clamp((0.5 - v) / (0.5 - (-1.5)) * 100),
  },
  {
    id: 'T10Y3M',
    label: 'Bank Spread',
    weight: 0.15,
    /** @param {number} v */
    score: (v) => clamp((0.5 - v) / (0.5 - (-1.0)) * 100),
  },
  {
    id: 'VIXCLS',
    label: 'Volatility',
    weight: 0.20,
    /** @param {number} v */
    score: (v) => clamp((v - 15) / (80 - 15) * 100),
  },
  {
    id: 'STLFSI4',
    label: 'Financial Stress',
    weight: 0.20,
    /** @param {number} v */
    score: (v) => clamp((v - (-1)) / (5 - (-1)) * 100),
  },
  {
    id: 'GSCPI',
    label: 'Supply Chain',
    weight: 0.15,
    /** @param {number} v */
    score: (v) => clamp((v - (-2)) / (4 - (-2)) * 100),
  },
  {
    id: 'ICSA',
    label: 'Job Claims',
    weight: 0.10,
    /** @param {number} v */
    score: (v) => clamp((v - 180000) / (500000 - 180000) * 100),
  },
];

/**
 * @param {number} score
 * @returns {string}
 */
function getLabel(score) {
  if (score < 20) return 'Low';
  if (score < 40) return 'Moderate';
  if (score < 60) return 'Elevated';
  if (score < 80) return 'Severe';
  return 'Critical';
}

/**
 * Batch-read all 6 FRED keys from Redis in a single pipeline request.
 * @returns {Promise<(unknown)[]>}
 */
async function batchReadFredKeys() {
  const { url, token } = getRedisCredentials();
  const fredKeys = COMPONENTS.map((c) => `${FRED_KEY_PREFIX}:${c.id}:0`);
  const pipeline = fredKeys.map((k) => ['GET', k]);

  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`Redis pipeline failed: HTTP ${resp.status}`);
  }

  const results = /** @type {{ result: string | null }[]} */ (await resp.json());
  return results.map((r) => {
    if (!r?.result) return null;
    try {
      return JSON.parse(r.result);
    } catch {
      return null;
    }
  });
}

/**
 * Extract the most recent non-null numeric observation from a FRED series cache entry.
 * Stored format: { series: { observations: [{ date, value }] } }
 * GSCPI format: { observations: [{ date, value }] } (no series wrapper)
 * @param {unknown} cached
 * @returns {number | null}
 */
function extractLatestValue(cached) {
  if (!cached || typeof cached !== 'object') return null;
  const c = /** @type {Record<string, unknown>} */ (cached);

  const seriesObj = c['series'] ?? c;
  if (!seriesObj || typeof seriesObj !== 'object') return null;

  const s = /** @type {Record<string, unknown>} */ (seriesObj);
  const observations = Array.isArray(s['observations']) ? s['observations'] : [];

  for (let j = observations.length - 1; j >= 0; j--) {
    const obs = observations[j];
    if (!obs || typeof obs !== 'object') continue;
    const o = /** @type {Record<string, unknown>} */ (obs);
    const v = typeof o['value'] === 'number' ? o['value'] : parseFloat(String(o['value'] ?? ''));
    if (Number.isFinite(v)) return v;
  }
  return null;
}

async function fetchEconomicStress() {
  const rawResults = await batchReadFredKeys();

  const components = [];
  let weightedSum = 0;
  let totalWeight = 0;
  let missingCount = 0;

  for (let i = 0; i < COMPONENTS.length; i++) {
    const comp = COMPONENTS[i];
    const rawValue = extractLatestValue(rawResults[i]);

    if (rawValue === null) {
      missingCount++;
      if (comp.id === 'GSCPI') {
        console.warn(`  [WARN] GSCPI missing from Redis (publication lag ~6 weeks is normal) — excluding from composite`);
      } else {
        console.warn(`  [WARN] ${comp.id} missing from Redis — excluding from composite`);
      }
      components.push({
        id: comp.id,
        label: comp.label,
        rawValue: null,
        missing: true,
        score: 0,
        weight: comp.weight,
      });
      continue;
    }

    const score = comp.score(rawValue);
    weightedSum += score * comp.weight;
    totalWeight += comp.weight;

    console.log(`  ${comp.id}: raw=${rawValue.toFixed(4)} score=${score.toFixed(1)}`);
    components.push({
      id: comp.id,
      label: comp.label,
      rawValue,
      score,
      weight: comp.weight,
    });
  }

  if (totalWeight === 0) {
    throw new Error('No FRED data available — all 6 series missing from Redis');
  }

  // Normalize composite to account for missing components
  const compositeScore = Math.round((weightedSum / totalWeight) * 10) / 10;
  const label = getLabel(compositeScore);

  console.log(`  Composite: ${compositeScore} (${label}) — ${COMPONENTS.length - missingCount}/${COMPONENTS.length} components`);

  return {
    compositeScore,
    label,
    components,
    seededAt: new Date().toISOString(),
    unavailable: false,
  };
}

if (process.argv[1]?.endsWith('seed-economic-stress.mjs')) {
  runSeed('economic', 'stress-index', CANONICAL_KEY, fetchEconomicStress, {
    validateFn: (d) => d != null && typeof d.compositeScore === 'number' && d.compositeScore >= 0,
    ttlSeconds: CACHE_TTL,
    recordCount: () => 6,
    sourceVersion: 'fred-composite-v1',
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
