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

// Pure payload builder — exported for unit tests. Takes the raw entry array
// returned by GIE AGSI+ and produces the canonical payload shape (or throws
// on invalid fillPct).
export function buildEuGasStoragePayload(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('GIE AGSI+: empty data array in response');
  }

  // Sort by date descending (most recent first). Clone so we don't mutate
  // the caller's array — important when this is unit-tested with shared
  // fixtures.
  const sorted = [...entries].sort((a, b) => {
    const da = a.gasDayStart ?? a.date ?? '';
    const db = b.gasDayStart ?? b.date ?? '';
    return db.localeCompare(da);
  });

  const current = parseFillEntry(sorted[0]);
  const previous = sorted.length > 1 ? parseFillEntry(sorted[1]) : null;

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
  const history = sorted.map((e) => {
    const p = parseFillEntry(e);
    return {
      date: p.date,
      fillPct: +(p.fill.toFixed(2)),
      gasTwh: +(p.gwh.toFixed(1)),
    };
  });

  // Freshness contract (regional-snapshot/freshness.mjs::extractTimestamp):
  //   - `fetchedAt` (numeric epoch ms) is checked FIRST → guaranteed pickup.
  //   - `seededAt` (ISO string) is checked LAST as a fallback and matches
  //     the convention used by other runSeed-based seeders.
  //   - `updatedAt` here holds the GIE *data date* (e.g. "2024-05-20"), not
  //     fetch time. The classifier currently checks `updatedAt` BEFORE
  //     `seededAt`, so without `fetchedAt` on the payload the snapshot
  //     would resolve to the data date and flip STALE over weekends when
  //     GIE doesn't publish new readings.
  const now = Date.now();
  return {
    fillPct: +(fillPct.toFixed(2)),
    fillPctChange1d,
    gasDaysConsumption,
    trend,
    history,
    fetchedAt: now,
    seededAt: new Date(now).toISOString(),
    updatedAt: current.date,
  };
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

  const result = buildEuGasStoragePayload(entries);

  console.log(`  EU gas storage: fill=${result.fillPct}%, change1d=${result.fillPctChange1d}, trend=${result.trend}`);
  return result;
}

function validate(data) {
  if (!data || typeof data !== 'object') return false;
  const fill = data.fillPct;
  return typeof fill === 'number' && Number.isFinite(fill) && fill > 0 && fill <= 100;
}

const isMain = process.argv[1]?.endsWith('seed-gie-gas-storage.mjs');

export function declareRecords(data) {
  return Number.isFinite(data?.fillPct) ? 1 : 0;
}

if (isMain) {
  runSeed('economic', 'eu-gas-storage', CANONICAL_KEY, fetchEuGasStorage, {
    validateFn: validate,
    ttlSeconds: TTL,
    sourceVersion: 'gie-agsi-plus',
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 2880,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
