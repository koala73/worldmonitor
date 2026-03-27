#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, getRedisCredentials, withRetry, writeFreshnessMetadata, extendExistingTtl, acquireLockSafely, releaseLock, logSeedResult } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

// ─── Config ───────────────────────────────────────────────────────────────────

const FRED_KEY_PREFIX = 'economic:fred:v1';
const TTL = 259200; // 3 days = 3 × 86400 (daily ECB publish cadence)

function fredSeedKey(seriesId) {
  return `${FRED_KEY_PREFIX}:${seriesId}:0`;
}

// ─── ECB SDMX-JSON series definitions ─────────────────────────────────────────

const ECB_SERIES = [
  {
    id: 'ESTR',
    title: 'Euro Short-Term Rate (€STR)',
    units: 'Percent',
    frequency: 'Daily',
    url: 'https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2X2A25.WT?format=jsondata&lastNObservations=60',
  },
  {
    id: 'EURIBOR3M',
    title: 'Euro Interbank Offered Rate (EURIBOR) — 3 Month',
    units: 'Percent',
    frequency: 'Monthly',
    url: 'https://data-api.ecb.europa.eu/service/data/FM/M.U2.EUR.RT.MM.EURIBOR3MD_.HSTA?format=jsondata&lastNObservations=36',
  },
  {
    id: 'EURIBOR6M',
    title: 'Euro Interbank Offered Rate (EURIBOR) — 6 Month',
    units: 'Percent',
    frequency: 'Monthly',
    url: 'https://data-api.ecb.europa.eu/service/data/FM/M.U2.EUR.RT.MM.EURIBOR6MD_.HSTA?format=jsondata&lastNObservations=36',
  },
  {
    id: 'EURIBOR1Y',
    title: 'Euro Interbank Offered Rate (EURIBOR) — 1 Year',
    units: 'Percent',
    frequency: 'Monthly',
    url: 'https://data-api.ecb.europa.eu/service/data/FM/M.U2.EUR.RT.MM.EURIBOR1YD_.HSTA?format=jsondata&lastNObservations=36',
  },
];

// ─── ECB SDMX-JSON parser ──────────────────────────────────────────────────────
//
// ECB returns SDMX-JSON like:
//   dataSets[0].series["0:0:0:..."].observations = { "0": [value, ...], "1": [...] }
//   structure.dimensions.observation[0].values = [{ id: "2025-03", ... }, ...]
//
// Observation index → date label via structure.dimensions.observation[0].values

function parseSdmxJson(data) {
  const dataset = data?.dataSets?.[0];
  const seriesMap = dataset?.series;
  if (!seriesMap) return [];

  const obsDimension = data?.structure?.dimensions?.observation?.[0];
  const dateValues = obsDimension?.values ?? [];

  const allSeriesKeys = Object.keys(seriesMap);
  if (allSeriesKeys.length > 1) {
    console.warn(`  WARN: response contained ${allSeriesKeys.length} series; using only the first`);
  }
  const seriesKey = allSeriesKeys[0];
  if (!seriesKey) return [];

  const observations = seriesMap[seriesKey]?.observations ?? {};

  const result = [];
  for (const [idxStr, obsArr] of Object.entries(observations)) {
    const idx = parseInt(idxStr, 10);
    const dateLabel = dateValues[idx]?.id ?? null;
    const raw = obsArr?.[0];
    if (!dateLabel || raw == null) continue;
    const value = parseFloat(String(raw));
    if (!Number.isFinite(value)) continue;
    result.push({ date: dateLabel, value });
  }

  result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return result;
}

// ─── Fetch a single ECB series ─────────────────────────────────────────────────

async function fetchEcbSeries(def) {
  const resp = await fetch(def.url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`ECB API HTTP ${resp.status} for ${def.id}`);
  const data = await resp.json();
  const observations = parseSdmxJson(data);
  if (observations.length === 0) throw new Error(`No observations parsed for ${def.id}`);
  console.log(`  ${def.id}: ${observations.length} observations (latest: ${observations.at(-1)?.date} = ${observations.at(-1)?.value}%)`);
  return observations;
}

// ─── Write a single FRED-format key to Redis ───────────────────────────────────

async function writeSeriesKey(redisUrl, redisToken, def, observations) {
  const key = fredSeedKey(def.id);
  const payload = {
    series: {
      seriesId: def.id,
      title: def.title,
      units: def.units,
      frequency: def.frequency,
      observations,
    },
  };
  const body = JSON.stringify(['SET', key, JSON.stringify(payload), 'EX', TTL]);
  const resp = await fetch(redisUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Redis write failed for ${key}: HTTP ${resp.status}`);
  console.log(`  Wrote ${key} (${observations.length} obs, TTL=${TTL}s)`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const domain = 'economic';
  const resource = 'ecb-short-rates';
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  console.log(`=== ${domain}:${resource} Seed ===`);
  console.log(`  Run ID: ${runId}`);
  console.log(`  Keys:   ${ECB_SERIES.map(s => fredSeedKey(s.id)).join(', ')}`);

  const lockResult = await acquireLockSafely(`${domain}:${resource}`, runId, 300_000, { label: `${domain}:${resource}` });
  if (lockResult.skipped) process.exit(0);
  if (!lockResult.locked) {
    console.log('  SKIPPED: another seed run in progress');
    process.exit(0);
  }

  const { url: redisUrl, token: redisToken } = getRedisCredentials();
  let successCount = 0;
  let totalObs = 0;
  const failedSeries = [];

  for (const def of ECB_SERIES) {
    try {
      const observations = await withRetry(() => fetchEcbSeries(def), 2, 2000);
      await writeSeriesKey(redisUrl, redisToken, def, observations);
      successCount++;
      totalObs += observations.length;
    } catch (err) {
      console.warn(`  WARN: ${def.id} failed — ${err.message}`);
      failedSeries.push(def.id);
      try {
        await extendExistingTtl([fredSeedKey(def.id)], TTL);
      } catch {
        // best-effort TTL extension
      }
    }
    // be courteous to ECB API
    await new Promise(r => setTimeout(r, 300));
  }

  if (successCount === 0) {
    await releaseLock(`${domain}:${resource}`, runId);
    // Extend seed-meta TTL so health checks don't see STALE_SEED on transient ECB outages.
    await extendExistingTtl([`seed-meta:${domain}:${resource}`], TTL).catch(() => {});
    throw new Error(`All ECB series failed: ${failedSeries.join(', ')}`);
  }

  await writeFreshnessMetadata(domain, resource, totalObs, 'ecb-sdmx');

  const durationMs = Date.now() - startMs;
  logSeedResult(domain, totalObs, durationMs, { successCount, failedSeries });
  console.log(`\n=== Done (${Math.round(durationMs)}ms) — ${successCount}/${ECB_SERIES.length} series written ===`);

  await releaseLock(`${domain}:${resource}`, runId);
  process.exit(0);
}

if (process.argv[1]?.endsWith('seed-ecb-short-rates.mjs')) {
  main().catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
