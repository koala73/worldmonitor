#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:eu-gas-storage:v1';
const TTL = 259200; // 3× daily (86400s/day)

const GIE_API_BASE = 'https://agsi.gie.eu/api';

async function fetchGieData(params) {
  const apiKey = process.env.GIE_API_KEY || process.env.AGSI_API_KEY || '';
  const url = `${GIE_API_BASE}?${params.toString()}`;
  const headers = {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
  };
  if (apiKey) headers['x-key'] = apiKey;

  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`GIE AGSI+ HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

function parseFillEntry(entry) {
  const fill = parseFloat(entry.full ?? entry.fillLevel ?? entry.pct ?? '0');
  const gwh = parseFloat(entry.gasInStorage ?? entry.gasTwh ?? entry.volume ?? '0');
  const date = entry.gasDayStart ?? entry.date ?? '';
  return { fill, gwh, date };
}

async function fetchEuGasStorage() {
  const apiKey = process.env.GIE_API_KEY || process.env.AGSI_API_KEY || '';

  if (!apiKey) {
    console.warn('  WARNING: GIE_API_KEY / AGSI_API_KEY not set — attempting unauthenticated request');
  }

  // Fetch latest 5 days of EU aggregate data
  const latestParams = new URLSearchParams({ type: 'eu', size: '5' });
  const latestData = await fetchGieData(latestParams);

  // AGSI+ returns { data: [...], name, code, url, type } at the root
  let entries = [];
  if (Array.isArray(latestData)) {
    entries = latestData;
  } else if (Array.isArray(latestData?.data)) {
    entries = latestData.data;
  } else if (latestData?.gasDayStart) {
    entries = [latestData];
  }

  if (!entries.length) {
    throw new Error('GIE AGSI+: empty data array in response');
  }

  // Sort by date descending (most recent first)
  entries.sort((a, b) => {
    const da = a.gasDayStart ?? a.date ?? '';
    const db = b.gasDayStart ?? b.date ?? '';
    return db.localeCompare(da);
  });

  const current = parseFillEntry(entries[0]);
  const previous = entries.length > 1 ? parseFillEntry(entries[1]) : null;

  const fillPct = current.fill;
  if (!Number.isFinite(fillPct) || fillPct <= 0 || fillPct > 100) {
    throw new Error(`GIE AGSI+: invalid fillPct=${fillPct} (expected 0–100)`);
  }

  const fillPctChange1d = previous !== null ? +(fillPct - previous.fill).toFixed(2) : 0;

  // Derive trend from 1d change
  let trend = 'stable';
  if (fillPctChange1d > 0.05) trend = 'injecting';
  else if (fillPctChange1d < -0.05) trend = 'withdrawing';

  // Approximate days of consumption — standard EU working gas volume ~1100 TWh
  // Days = storage_gwh / (total_capacity_gwh * seasonal_avg_drawdown_per_day)
  // Simple heuristic: storage_gwh / ~18 TWh/day EU avg winter consumption
  const gasDaysConsumption = current.gwh > 0
    ? +(current.gwh / 18).toFixed(1)
    : 0;

  // Build 5-day history
  const history = entries.map(e => {
    const p = parseFillEntry(e);
    return {
      date: p.date,
      fillPct: +(p.fill.toFixed(2)),
      gasTwh: +(p.gwh.toFixed(1)),
    };
  });

  const result = {
    fillPct: +(fillPct.toFixed(2)),
    fillPctChange1d,
    gasDaysConsumption,
    trend,
    history,
    seededAt: String(Date.now()),
    updatedAt: current.date,
  };

  console.log(`  EU gas storage: fill=${result.fillPct}%, change1d=${result.fillPctChange1d}, trend=${result.trend}`);
  return result;
}

function validate(data) {
  if (!data || typeof data !== 'object') return false;
  const fill = data.fillPct;
  return typeof fill === 'number' && Number.isFinite(fill) && fill > 0 && fill <= 100;
}

const isMain = process.argv[1]?.endsWith('seed-gie-gas-storage.mjs');

if (isMain) {
  runSeed('economic', 'eu-gas-storage', CANONICAL_KEY, fetchEuGasStorage, {
    validateFn: validate,
    ttlSeconds: TTL,
    sourceVersion: 'gie-agsi-plus',
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
