#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:ecb-fx-rates:v1';
const TTL = 259200; // 3 × 86400 — seeded daily

const ECB_URL =
  'https://data-api.ecb.europa.eu/service/data/EXR/D.USD+GBP+JPY+CHF+CAD+AUD+CNY.EUR.SP00.A' +
  '?lastNObservations=5&format=jsondata';

const PAIR_LABELS = {
  USD: 'EURUSD',
  GBP: 'EURGBP',
  JPY: 'EURJPY',
  CHF: 'EURCHF',
  CAD: 'EURCAD',
  AUD: 'EURAUD',
  CNY: 'EURCNY',
};

async function fetchEcbFxRates() {
  const resp = await fetch(ECB_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) {
    throw new Error(`ECB API HTTP ${resp.status}`);
  }

  const data = await resp.json();

  const seriesDimensions = data?.structure?.dimensions?.series;
  if (!Array.isArray(seriesDimensions)) {
    throw new Error('ECB response missing structure.dimensions.series');
  }

  const currencyDimPos = seriesDimensions.findIndex(d => d.id === 'CURRENCY');
  if (currencyDimPos === -1) {
    throw new Error('ECB response missing CURRENCY dimension');
  }
  const currencyDim = seriesDimensions[currencyDimPos];
  if (!currencyDim?.values) {
    throw new Error('ECB response missing CURRENCY dimension values');
  }

  const currencyCodes = currencyDim.values.map(v => v.id);

  const seriesMap = data?.dataSets?.[0]?.series;
  if (!seriesMap || typeof seriesMap !== 'object') {
    throw new Error('ECB response missing dataSets[0].series');
  }

  const obsPeriods = data?.structure?.dimensions?.observation;
  const timeDim = Array.isArray(obsPeriods) ? obsPeriods.find(d => d.id === 'TIME_PERIOD') : null;
  const timeValues = timeDim?.values || [];

  const rates = {};
  let latestDate = '';

  for (const [seriesKey, seriesData] of Object.entries(seriesMap)) {
    const keyParts = seriesKey.split(':');
    const currencyIndex = parseInt(keyParts[currencyDimPos], 10);
    const currency = currencyCodes[currencyIndex];
    if (!currency || !PAIR_LABELS[currency]) continue;

    const observations = seriesData?.observations;
    if (!observations || typeof observations !== 'object') continue;

    const obsEntries = Object.entries(observations)
      .map(([idx, obsArr]) => {
        const timeEntry = timeValues[parseInt(idx, 10)];
        const date = timeEntry?.id || timeEntry?.name || '';
        const value = Array.isArray(obsArr) ? obsArr[0] : null;
        return { date, value };
      })
      .filter(e => e.date && typeof e.value === 'number' && Number.isFinite(e.value) && e.value > 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (obsEntries.length === 0) continue;

    const latest = obsEntries[obsEntries.length - 1];
    const prev = obsEntries.length >= 2 ? obsEntries[obsEntries.length - 2] : null;

    const rate = latest.value;
    const change1d = prev ? +(rate - prev.value).toFixed(6) : 0;

    const pairLabel = PAIR_LABELS[currency];
    rates[pairLabel] = {
      rate: +rate.toFixed(6),
      date: latest.date,
      change1d,
    };

    if (latest.date > latestDate) latestDate = latest.date;
  }

  const pairCount = Object.keys(rates).length;
  console.log(`  ECB FX rates: ${pairCount} pairs as of ${latestDate}`);

  if (pairCount === 0) {
    throw new Error('ECB returned no valid rate observations');
  }

  return {
    rates,
    updatedAt: latestDate ? `${latestDate}T14:00:00Z` : new Date().toISOString(),
    seededAt: Date.now(),
  };
}

function validate(data) {
  const pairs = Object.keys(data?.rates || {});
  return pairs.length >= 3 && pairs.every(p => {
    const r = data.rates[p];
    return Number.isFinite(r?.rate) && r.rate > 0;
  });
}

if (process.argv[1]?.endsWith('seed-ecb-fx-rates.mjs')) {
  runSeed('economic', 'ecb-fx-rates', CANONICAL_KEY, fetchEcbFxRates, {
    validateFn: validate,
    ttlSeconds: TTL,
    sourceVersion: 'ecb-data-portal',
    recordCount: (data) => Object.keys(data?.rates ?? {}).length,
  }).catch(err => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
