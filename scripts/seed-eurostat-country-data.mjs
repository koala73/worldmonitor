#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

// Redis key and TTL
const CANONICAL_KEY = 'economic:eurostat-country-data:v1';
const TTL = 259200; // 3 days — 3× daily seeding interval

// EU member states to cover (top 10 by population/GDP)
const EU_COUNTRIES = ['DE', 'FR', 'IT', 'ES', 'PL', 'NL', 'BE', 'AT', 'SE', 'CZ'];

const EUROSTAT_BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';

const DATASETS = {
  cpi: {
    id: 'prc_hicp_manr',
    params: { coicop: 'CP00', lastTimePeriod: '2' },
    unit: '%',
    label: 'HICP annual rate of change',
  },
  unemployment: {
    id: 'une_rt_m',
    params: { sex: 'T', age: 'TOTAL', s_adj: 'SA', unit: 'PC_ACT', lastTimePeriod: '3' },
    unit: '%',
    label: 'Unemployment rate (SA)',
  },
  gdpGrowth: {
    id: 'namq_10_gdp',
    params: { s_adj: 'SCA', unit: 'CLV_PCH_PRE', na_item: 'B1GQ', lastTimePeriod: '2' },
    unit: '%',
    label: 'GDP growth (quarterly, chain-linked)',
  },
};

/**
 * Parse Eurostat JSON-stat response for a specific geo code.
 * Eurostat uses a flat value object indexed by integer position.
 * Dimensions define the order of iteration.
 */
function parseEurostatResponse(data, geoCode) {
  try {
    const dims = data?.dimension;
    const values = data?.value;
    if (!dims || !values) return null;

    // Find geo dimension and its index for our country
    const geoDim = dims.geo;
    if (!geoDim) return null;

    const geoCategory = geoDim.category;
    const geoIndex = geoCategory?.index;
    if (!geoIndex || geoIndex[geoCode] === undefined) return null;

    const geoPos = geoIndex[geoCode];

    // Find time dimension for the period label
    const timeDim = dims.time;
    const timeCategory = timeDim?.category;
    const timeIndexObj = timeCategory?.index;

    // Get time period label — will be overridden below with the matched observation's period
    let datePeriod = '';
    if (timeIndexObj) {
      const timeKeys = Object.keys(timeIndexObj).sort((a, b) => timeIndexObj[b] - timeIndexObj[a]);
      datePeriod = timeKeys[0] || '';
    }

    // Calculate the flat value index
    // Eurostat dimension order: determines how values are arranged
    const dimOrder = data.id || [];
    const dimSizes = data.size || [];

    // Build stride map
    const strides = {};
    let stride = 1;
    for (let i = dimOrder.length - 1; i >= 0; i--) {
      strides[dimOrder[i]] = stride;
      stride *= dimSizes[i];
    }

    let value = null;
    let priorValue = null;
    let matchCount = 0;

    // Iterate over the actual key positions present in the sparse values object,
    // in descending numeric order so we pick the most recent non-null observation first
    // (needed when lastTimePeriod>1 and the latest period has no data yet).
    for (const key of Object.keys(values).sort((a, b) => Number(b) - Number(a))) {
      const idx = Number(key);
      const rawVal = values[key];
      if (rawVal === null || rawVal === undefined) continue;

      // Reverse-engineer position
      let remaining = idx;
      const coords = {};
      for (const dim of dimOrder) {
        const s = strides[dim];
        const dimSize = dimSizes[dimOrder.indexOf(dim)];
        coords[dim] = Math.floor(remaining / s) % dimSize;
        remaining = remaining % s;
      }

      if (coords['geo'] === geoPos) {
        if (matchCount === 0) {
          value = rawVal;
          // Use the time label for this coordinate
          if (timeIndexObj) {
            const timeEntry = Object.entries(timeIndexObj).find(([, v]) => v === coords['time']);
            if (timeEntry) datePeriod = timeEntry[0];
          }
        } else if (matchCount === 1) {
          priorValue = rawVal;
          break;
        }
        matchCount++;
      }
    }

    if (value === null || value === undefined) return null;

    const roundedPrior = typeof priorValue === 'number' ? Math.round(priorValue * 100) / 100 : null;
    return {
      value: typeof value === 'number' ? Math.round(value * 100) / 100 : null,
      priorValue: roundedPrior,
      hasPrior: roundedPrior !== null,
      date: datePeriod,
    };
  } catch (err) {
    console.warn(`  parseEurostatResponse error: ${err.message}`);
    return null;
  }
}

/**
 * Fetch a single dataset for a single country from Eurostat.
 * Returns { value, date } or null on failure.
 */
async function fetchCountryDataset(datasetKey, geoCode) {
  const ds = DATASETS[datasetKey];
  const params = new URLSearchParams({
    format: 'JSON',
    lang: 'EN',
    geo: geoCode,
    ...ds.params,
  });

  const url = `${EUROSTAT_BASE}/${ds.id}?${params}`;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!resp.ok) {
      console.warn(`  Eurostat ${geoCode}/${datasetKey}: HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    const parsed = parseEurostatResponse(data, geoCode);

    if (!parsed || parsed.value === null) {
      console.warn(`  Eurostat ${geoCode}/${datasetKey}: no value extracted`);
      return null;
    }

    return { value: parsed.value, priorValue: parsed.priorValue ?? null, date: parsed.date, unit: ds.unit };
  } catch (err) {
    console.warn(`  Eurostat ${geoCode}/${datasetKey}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch all 3 datasets for a single country.
 * Uses Promise.allSettled — partial data is acceptable.
 */
async function fetchCountryData(geoCode) {
  const [cpiResult, unemploymentResult, gdpResult] = await Promise.allSettled([
    fetchCountryDataset('cpi', geoCode),
    fetchCountryDataset('unemployment', geoCode),
    fetchCountryDataset('gdpGrowth', geoCode),
  ]);

  const entry = {};
  if (cpiResult.status === 'fulfilled' && cpiResult.value) {
    entry.cpi = cpiResult.value;
  }
  if (unemploymentResult.status === 'fulfilled' && unemploymentResult.value) {
    entry.unemployment = unemploymentResult.value;
  }
  if (gdpResult.status === 'fulfilled' && gdpResult.value) {
    entry.gdpGrowth = gdpResult.value;
  }

  const metricCount = Object.keys(entry).length;
  console.log(`  ${geoCode}: ${metricCount}/3 metrics ok`);

  return { geoCode, entry, metricCount };
}

/**
 * Fetch all countries in batches to avoid overwhelming Eurostat with simultaneous requests.
 * Individual failures don't abort the seed.
 */
async function fetchAll() {
  console.log(`  Fetching ${EU_COUNTRIES.length} countries × 3 datasets from Eurostat...`);

  const BATCH_SIZE = 3;
  const countryResults = [];
  for (let i = 0; i < EU_COUNTRIES.length; i += BATCH_SIZE) {
    const batch = EU_COUNTRIES.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(batch.map(geo => fetchCountryData(geo)));
    countryResults.push(...batchResults);
  }

  const countries = {};
  let countriesWithData = 0;

  for (const result of countryResults) {
    if (result.status === 'rejected') {
      console.warn(`  Country fetch rejected: ${result.reason?.message || result.reason}`);
      continue;
    }
    const { geoCode, entry, metricCount } = result.value;
    if (metricCount > 0) {
      countries[geoCode] = entry;
      countriesWithData++;
    }
  }

  console.log(`  Eurostat: ${countriesWithData}/${EU_COUNTRIES.length} countries with data`);

  return {
    countries,
    seededAt: Date.now(),
  };
}

function validate(data) {
  const countries = data?.countries;
  if (!countries) return false;
  const countriesWithMetrics = Object.values(countries).filter(
    c => Object.keys(c).length >= 1
  );
  if (countriesWithMetrics.length < 5) {
    console.warn(`  Validation failed: only ${countriesWithMetrics.length} countries with data (need ≥5)`);
    return false;
  }
  return true;
}

if (process.argv[1]?.endsWith('seed-eurostat-country-data.mjs')) {
  runSeed('economic', 'eurostat-country-data', CANONICAL_KEY, fetchAll, {
    validateFn: validate,
    ttlSeconds: TTL,
    sourceVersion: 'eurostat-v1',
    recordCount: (data) => Object.keys(data?.countries || {}).length,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
