#!/usr/bin/env node

import { loadEnvFile, runSeed, getRedisCredentials } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'energy:chokepoint-flows:v1';
const PORTWATCH_KEY = 'supply_chain:portwatch:v1';
const BASELINES_KEY = 'energy:chokepoint-baselines:v1';
const TTL = 259_200; // 3d — upstream seeder runs every 6h

// 7 chokepoints that have EIA baseline mb/d figures
const CHOKEPOINT_MAP = [
  { canonicalId: 'hormuz_strait',  baselineId: 'hormuz'  },
  { canonicalId: 'malacca_strait', baselineId: 'malacca' },
  { canonicalId: 'suez',           baselineId: 'suez'    },
  { canonicalId: 'bab_el_mandeb',  baselineId: 'babelm'  },
  { canonicalId: 'bosphorus',      baselineId: 'turkish' },
  { canonicalId: 'dover_strait',   baselineId: 'danish'  },
  { canonicalId: 'panama',         baselineId: 'panama'  },
];

async function redisGet(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? JSON.parse(data.result) : null;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export async function fetchAll() {
  const { url, token } = getRedisCredentials();

  const [portwatch, baselines] = await Promise.all([
    redisGet(url, token, PORTWATCH_KEY),
    redisGet(url, token, BASELINES_KEY),
  ]);

  if (!portwatch || typeof portwatch !== 'object' || Object.keys(portwatch).length === 0) {
    throw new Error('PortWatch data unavailable — run seed-portwatch.mjs first');
  }

  const result = {};

  for (const cp of CHOKEPOINT_MAP) {
    const pw = portwatch[cp.canonicalId];
    if (!pw?.history?.length) continue;

    const baseline = baselines?.chokepoints?.find(b => b.id === cp.baselineId);
    if (!baseline?.mbd) continue;

    const history = [...pw.history].sort((a, b) => a.date.localeCompare(b.date));

    // Require at least 40 days of data to compute a meaningful baseline
    if (history.length < 40) continue;

    const last7 = history.slice(-7);
    const prev90 = history.slice(-97, -7); // days [-97..-7], up to 90 days
    if (last7.length < 3 || prev90.length < 20) continue;

    // Prefer DWT (capTanker) when the baseline window has majority DWT coverage.
    // Decision is based on the 90-day baseline, NOT the recent window — zero
    // recent capTanker is the disruption signal, not a reason to abandon DWT.
    // Majority guard: partial DWT roll-out (1-2 days non-zero) should not
    // activate DWT mode and pull down the baseline average via zero-filled gaps.
    const dwtBaselineDays = prev90.filter(d => (d.capTanker ?? 0) > 0).length;
    const useDwt = dwtBaselineDays >= Math.ceil(prev90.length / 2);

    const current7d = useDwt
      ? avg(last7.map(d => d.capTanker ?? 0))
      : avg(last7.map(d => d.tanker ?? 0));

    const baseline90d = useDwt
      ? avg(prev90.map(d => d.capTanker ?? 0))
      : avg(prev90.map(d => d.tanker ?? 0));

    // Skip if baseline is too thin to be meaningful
    if (baseline90d < (useDwt ? 1 : 0.5)) continue;

    const flowRatio = Math.min(1.5, Math.max(0, current7d / baseline90d));
    const currentMbd = Math.round(baseline.mbd * flowRatio * 10) / 10;

    // Disrupted = each of last 3 individual days has day_ratio < 0.85
    const last3 = history.slice(-3);
    const disrupted = last3.length === 3 && last3.every(d => {
      const dayVal = useDwt ? (d.capTanker ?? 0) : (d.tanker ?? 0);
      return baseline90d > 0 && (dayVal / baseline90d) < 0.85;
    });

    result[cp.canonicalId] = {
      currentMbd,
      baselineMbd: baseline.mbd,
      flowRatio: Math.round(flowRatio * 1000) / 1000,
      disrupted,
      source: useDwt ? 'portwatch-dwt' : 'portwatch-counts',
      hazardAlertLevel: null,
      hazardAlertName: null,
    };
  }

  if (Object.keys(result).length === 0) {
    throw new Error('No flow estimates computed — check PortWatch and baselines data');
  }

  return result;
}

export function validateFn(data) {
  return data && typeof data === 'object' && Object.keys(data).length >= 3;
}

const isMain = process.argv[1]?.endsWith('seed-chokepoint-flows.mjs');
if (isMain) {
  runSeed('energy', 'chokepoint-flows', CANONICAL_KEY, fetchAll, {
    validateFn,
    ttlSeconds: TTL,
    sourceVersion: 'portwatch-eia-flows-v1',
    recordCount: (data) => Object.keys(data).length,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
