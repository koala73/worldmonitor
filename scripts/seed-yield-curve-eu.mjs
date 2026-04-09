#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:yield-curve-eu:v1';
const TTL = 259200; // 72h = 3× daily seed interval

// ECB SDMX-JSON endpoint — all 6 tenors in one request, latest observation only
const ECB_URL =
  'https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_1Y+SR_2Y+SR_5Y+SR_10Y+SR_20Y+SR_30Y' +
  '?format=jsondata&lastNObservations=1';

// Mapping from ECB series key suffix to tenor label
const TENOR_MAP = {
  SR_1Y:  '1Y',
  SR_2Y:  '2Y',
  SR_5Y:  '5Y',
  SR_10Y: '10Y',
  SR_20Y: '20Y',
  SR_30Y: '30Y',
};

const TENOR_ORDER = ['1Y', '2Y', '5Y', '10Y', '20Y', '30Y'];

async function fetchEcbYieldCurve() {
  const resp = await fetch(ECB_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) throw new Error(`ECB API HTTP ${resp.status}`);

  const data = await resp.json();

  // SDMX-JSON structure:
  // data.structure.dimensions.series[N].values[idx].id → tenor suffix (e.g. "SR_10Y")
  // data.dataSets[0].series["0:0:0:0:0:N"].observations["0"][0] → rate value
  const dims = data?.structure?.dimensions?.series;
  const dataSet = data?.dataSets?.[0];
  if (!dims || !dataSet) throw new Error('Unexpected ECB SDMX-JSON structure');

  // Find the dimension index that holds the tenor labels
  const tenorDimIdx = dims.findIndex(
    (d) => d.values?.some((v) => v.id?.startsWith('SR_')),
  );
  if (tenorDimIdx === -1) throw new Error('Cannot find tenor dimension in ECB response');

  const tenorDim = dims[tenorDimIdx];

  const rates = {};
  let latestDate = '';

  for (const [seriesKey, seriesData] of Object.entries(dataSet.series)) {
    const keyParts = seriesKey.split(':');
    const tenorIdx = parseInt(keyParts[tenorDimIdx], 10);
    if (isNaN(tenorIdx)) continue;

    const tenorId = tenorDim.values[tenorIdx]?.id;
    if (!tenorId) continue;

    const tenor = TENOR_MAP[tenorId];
    if (!tenor) continue;

    // observations: { "0": [value, ...] } — first obs at key "0"
    const obs = seriesData?.observations?.['0'];
    if (!Array.isArray(obs) || obs[0] == null) continue;

    const rate = typeof obs[0] === 'number' ? obs[0] : parseFloat(obs[0]);
    if (!Number.isFinite(rate)) continue;

    rates[tenor] = Math.round(rate * 1000) / 1000;

    // Extract date from observation dimension if present
    if (!latestDate) {
      const obsDims = data?.structure?.dimensions?.observation;
      if (Array.isArray(obsDims) && obsDims.length > 0) {
        const timeDim = obsDims[0];
        const dateVal = timeDim?.values?.[0]?.id ?? timeDim?.values?.[0]?.name;
        if (dateVal) latestDate = String(dateVal);
      }
    }
  }

  const tenorCount = Object.keys(rates).length;
  if (tenorCount === 0) throw new Error('No ECB yield curve data parsed');

  console.log(`  ECB yield curve: ${tenorCount} tenors, date=${latestDate || 'unknown'}`);
  console.log('  Rates:', JSON.stringify(rates));

  return {
    date: latestDate,
    rates,
    source: 'ecb-aaa',
    updatedAt: new Date().toISOString(),
  };
}

function validate(data) {
  if (!data?.rates) return false;
  const valid = TENOR_ORDER.filter((t) => data.rates[t] != null);
  return valid.length >= 4; // require at least 4 of 6 tenors
}

if (process.argv[1]?.endsWith('seed-yield-curve-eu.mjs')) {
  runSeed('economic', 'yield-curve-eu', CANONICAL_KEY, fetchEcbYieldCurve, {
    validateFn: validate,
    ttlSeconds: TTL,
    sourceVersion: 'ecb-sdmx-v1',
    recordCount: (data) => Object.keys(data?.rates ?? {}).length,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
