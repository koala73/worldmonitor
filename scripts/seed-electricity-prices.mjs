#!/usr/bin/env node

import {
  acquireLockSafely,
  CHROME_UA,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
  withRetry,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const ELECTRICITY_KEY_PREFIX = 'energy:electricity:v1:';
export const ELECTRICITY_INDEX_KEY = 'energy:electricity:v1:index';
export const ELECTRICITY_META_KEY = 'seed-meta:energy:electricity-prices';
export const ELECTRICITY_TTL_SECONDS = 3 * 24 * 3600; // 3 days = 259200s

const LOCK_DOMAIN = 'energy:electricity-prices';
const LOCK_TTL_MS = 10 * 60 * 1000;
const MIN_ENTSO_REGIONS = 7;

const ENTSO_E_REGIONS = [
  { region: 'DE', eic: '10Y1001A1001A82H', name: 'Germany' },       // DE-LU bidding zone (post-split)
  { region: 'FR', eic: '10YFR-RTE------C', name: 'France' },
  { region: 'ES', eic: '10YES-REE------0', name: 'Spain' },
  { region: 'IT', eic: '10Y1001A1001A73I', name: 'Italy (North)' }, // IT-North bidding zone
  { region: 'NL', eic: '10YNL----------L', name: 'Netherlands' },
  { region: 'BE', eic: '10YBE----------2', name: 'Belgium' },
  { region: 'PL', eic: '10YPL-AREA-----S', name: 'Poland' },
  { region: 'PT', eic: '10YPT-REN------W', name: 'Portugal' },
  { region: 'NO', eic: '10YNO-1--------2', name: 'Norway (Oslo)' }, // NO1 bidding zone
  { region: 'SE', eic: '10Y1001A1001A46L', name: 'Sweden (Stockholm)' }, // SE3 bidding zone
];

const EIA_REGIONS = [
  { region: 'CISO',  name: 'California' },
  { region: 'MISO',  name: 'Midwest' },
  { region: 'PJM',   name: 'Mid-Atlantic' },
  { region: 'NYISO', name: 'New York' },
  { region: 'ERCO',  name: 'Texas (ERCOT)' },
  { region: 'SPP',   name: 'Southwest' },
];

// ── Date helpers ─────────────────────────────────────────────────────────────

function formatEntsoDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}0000`;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// ── XML parser (no external deps) ────────────────────────────────────────────

export function parseEntsoEPrice(xml) {
  const amounts = [];
  const re = /<price\.amount>(-?[\d.]+)<\/price\.amount>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) amounts.push(v);
  }
  if (amounts.length === 0) return null;
  return +(amounts.reduce((a, b) => a + b, 0) / amounts.length).toFixed(2);
}

// ── Index builder ─────────────────────────────────────────────────────────────

export function buildElectricityIndex(regionData, date) {
  const withPrices = regionData
    .filter((r) => r.priceMwhEur != null && Number.isFinite(r.priceMwhEur))
    .sort((a, b) => b.priceMwhEur - a.priceMwhEur)
    .slice(0, 20)
    .map((r) => ({ region: r.region, source: r.source, priceMwhEur: r.priceMwhEur }));

  return {
    updatedAt: new Date().toISOString(),
    date,
    regions: withPrices,
  };
}

// ── Redis helpers ─────────────────────────────────────────────────────────────

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
  }
  return response.json();
}

// ── ENTSO-E fetcher ───────────────────────────────────────────────────────────

async function fetchEntsoERegion(region, token, today, yesterday) {
  const params = new URLSearchParams({
    documentType: 'A44',
    in_Domain: region.eic,
    out_Domain: region.eic,
    periodStart: formatEntsoDate(yesterday),
    periodEnd: `${isoDate(today).replace(/-/g, '')}2300`,
    securityToken: token,
  });

  try {
    const resp = await withRetry(
      () =>
        fetch(`https://web-api.tp.entsoe.eu/api?${params.toString()}`, {
          headers: { 'User-Agent': CHROME_UA, Accept: 'application/xml' },
          signal: AbortSignal.timeout(20_000),
        }).then((r) => {
          if (!r.ok) throw new Error(`ENTSO-E ${region.region} HTTP ${r.status}`);
          return r.text();
        }),
      2,
      500,
    );

    const price = parseEntsoEPrice(resp);
    if (price == null) {
      console.warn(`[electricity] ENTSO-E ${region.region}: no price.amount in response`);
      return null;
    }

    console.log(`[electricity] ENTSO-E ${region.region}: ${price} EUR/MWh`);
    return {
      region: region.region,
      source: 'entso-e',
      priceMwhEur: price,
      priceMwhUsd: null,
      date: isoDate(today),
      unit: 'EUR/MWh',
      seededAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`[electricity] ENTSO-E ${region.region} failed: ${err.message}`);
    return null;
  }
}

async function fetchAllEntsoE(token, today, yesterday) {
  const BATCH = 3;
  const results = [];

  for (let i = 0; i < ENTSO_E_REGIONS.length; i += BATCH) {
    const batch = ENTSO_E_REGIONS.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map((r) => fetchEntsoERegion(r, token, today, yesterday)),
    );
    results.push(...batchResults);
    if (i + BATCH < ENTSO_E_REGIONS.length) {
      await new Promise((res) => setTimeout(res, 300));
    }
  }

  return results.filter(Boolean);
}

// ── EIA-930 fetcher ───────────────────────────────────────────────────────────

async function fetchEiaRegion(region, apiKey, today) {
  const dateStr = isoDate(today);
  const params = new URLSearchParams({
    'data[]': 'value',
    'facets[respondent][]': region.region,
    start: isoDate(new Date(Date.now() - 2 * 24 * 3600 * 1000)),
    end: dateStr,
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '1',
    api_key: apiKey,
  });

  try {
    const resp = await withRetry(
      () =>
        fetch(`https://api.eia.gov/v2/electricity/rto/region-data/data/?${params.toString()}`, {
          headers: { 'User-Agent': CHROME_UA },
          signal: AbortSignal.timeout(20_000),
        }).then((r) => {
          if (!r.ok) throw new Error(`EIA-930 ${region.region} HTTP ${r.status}`);
          return r.json();
        }),
      2,
      500,
    );

    const rows = resp?.response?.data;
    if (!Array.isArray(rows) || rows.length === 0) {
      console.warn(`[electricity] EIA-930 ${region.region}: no data rows`);
      return null;
    }

    const latest = rows[0];
    const demandMwh = typeof latest?.value === 'number' ? latest.value : parseFloat(latest?.value);
    if (!Number.isFinite(demandMwh)) {
      console.warn(`[electricity] EIA-930 ${region.region}: invalid demand value`);
      return null;
    }

    console.log(`[electricity] EIA-930 ${region.region}: ${demandMwh} MWh demand`);
    return {
      region: region.region,
      source: 'eia-930',
      priceMwhEur: null,
      priceMwhUsd: null,
      demandMwh,
      date: dateStr,
      unit: 'MWh',
      seededAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`[electricity] EIA-930 ${region.region} failed: ${err.message}`);
    return null;
  }
}

async function fetchAllEia(apiKey, today) {
  const results = await Promise.all(EIA_REGIONS.map((r) => fetchEiaRegion(r, apiKey, today)));
  return results.filter(Boolean);
}

// ── Failure preservation ──────────────────────────────────────────────────────

async function preservePreviousSnapshot(errorMsg, regionKeys) {
  console.error('[electricity] Preserving previous snapshot:', errorMsg);
  const keys = [...regionKeys.map((k) => `${ELECTRICITY_KEY_PREFIX}${k}`), ELECTRICITY_INDEX_KEY, ELECTRICITY_META_KEY];
  await extendExistingTtl(keys, ELECTRICITY_TTL_SECONDS);
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main() {
  const startedAt = Date.now();
  const runId = `electricity-prices:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('[electricity] Lock held, skipping');
    return;
  }

  const today = new Date();
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  const dateStr = isoDate(today);

  const entsoToken = process.env.ENTSO_E_TOKEN;
  const eiaKey = process.env.EIA_API_KEY;

  let entsoResults = [];
  let eiaResults = [];

  try {
    // ENTSO-E (EU day-ahead prices)
    if (!entsoToken) {
      console.warn('[electricity] ENTSO_E_TOKEN not set — skipping ENTSO-E');
    } else {
      entsoResults = await fetchAllEntsoE(entsoToken, today, yesterday);
      console.log(`[electricity] ENTSO-E: ${entsoResults.length} regions`);
    }

    // EIA-930 (US demand data)
    if (!eiaKey) {
      console.warn('[electricity] EIA_API_KEY not set — skipping EIA-930');
    } else {
      eiaResults = await fetchAllEia(eiaKey, today);
      console.log(`[electricity] EIA-930: ${eiaResults.length} regions`);
    }

    // Check EU coverage threshold — preserve EU snapshot but still write US data
    if (entsoToken && entsoResults.length < MIN_ENTSO_REGIONS) {
      const euKeys = ENTSO_E_REGIONS.map((r) => r.region);
      await preservePreviousSnapshot(
        `Only ${entsoResults.length} ENTSO-E regions returned valid prices (min: ${MIN_ENTSO_REGIONS})`,
        euKeys,
      );
      if (eiaResults.length > 0) {
        const usCommands = eiaResults.map((entry) => [
          'SET', `${ELECTRICITY_KEY_PREFIX}${entry.region}`, JSON.stringify(entry), 'EX', ELECTRICITY_TTL_SECONDS,
        ]);
        await redisPipeline(usCommands);
        console.log(`[electricity] EU below threshold but wrote ${eiaResults.length} US regions`);
      }
      return;
    }

    const allRegions = [...entsoResults, ...eiaResults];
    if (allRegions.length === 0) {
      console.warn('[electricity] No data from any source — skipping write');
      return;
    }

    const index = buildElectricityIndex(entsoResults, dateStr);
    const metaPayload = {
      fetchedAt: Date.now(),
      recordCount: allRegions.length,
      sourceVersion: 'electricity-prices-v1',
    };

    const commands = [];
    for (const entry of allRegions) {
      commands.push([
        'SET',
        `${ELECTRICITY_KEY_PREFIX}${entry.region}`,
        JSON.stringify(entry),
        'EX',
        ELECTRICITY_TTL_SECONDS,
      ]);
    }
    commands.push([
      'SET',
      ELECTRICITY_INDEX_KEY,
      JSON.stringify(index),
      'EX',
      ELECTRICITY_TTL_SECONDS,
    ]);
    commands.push([
      'SET',
      ELECTRICITY_META_KEY,
      JSON.stringify(metaPayload),
      'EX',
      ELECTRICITY_TTL_SECONDS,
    ]);

    const results = await redisPipeline(commands);
    const failures = results.filter((r) => r?.error || r?.result === 'ERR');
    if (failures.length > 0) {
      throw new Error(`Redis pipeline: ${failures.length}/${commands.length} commands failed`);
    }

    logSeedResult('energy:electricity-prices', allRegions.length, Date.now() - startedAt, {
      entsoRegions: entsoResults.length,
      eiaRegions: eiaResults.length,
    });
    console.log(`[electricity] Seeded ${allRegions.length} regions (${entsoResults.length} ENTSO-E, ${eiaResults.length} EIA-930)`);
  } catch (err) {
    const allKnownRegions = [
      ...ENTSO_E_REGIONS.map((r) => r.region),
      ...EIA_REGIONS.map((r) => r.region),
    ];
    await preservePreviousSnapshot(String(err), allKnownRegions).catch((e) =>
      console.error('[electricity] Failed to preserve snapshot:', e),
    );
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-electricity-prices.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
