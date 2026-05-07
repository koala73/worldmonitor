#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);

// ECB SDMX REST API — free, no auth required.
// CISS: Composite Indicator of Systemic Stress (0–1 range, higher = more systemic stress).
// Weekly frequency, Euro area aggregate; ECB publishes each Friday (SDMX series key uses 'D' but only Friday observations are present).
const ECB_CISS_URL =
  'https://data-api.ecb.europa.eu/service/data/CISS/D.U2.Z0Z.4F.EC.SS_CI.IDX?format=jsondata&lastNObservations=52';

const FSI_EU_KEY = 'economic:fsi-eu:v1';
// Weekly cron (Saturday) — 864000s (10 days) matches other weekly seeds (bigmac, groceryBasket,
// fuelPrices) and provides a 3-day buffer against cron-drift or missed runs.
const FSI_EU_TTL = 864000;

function classifyLabel(value) {
  if (value < 0.2) return 'Low';
  if (value < 0.4) return 'Moderate';
  if (value < 0.6) return 'Elevated';
  return 'High';
}

async function fetchEcbCiss() {
  const resp = await fetch(ECB_CISS_URL, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`ECB CISS API: HTTP ${resp.status}`);

  const json = await resp.json();

  // SDMX-JSON structure:
  //   dataSets[0].series["0:0:0:0:0:0:0"].observations = { "0": [value,...], "1": [...], ... }
  //   structure.dimensions.observation[0].values = [{ id: "2025-04-04", ... }, ...]
  const series = json?.dataSets?.[0]?.series?.['0:0:0:0:0:0:0'];
  if (!series) throw new Error('ECB CISS: unexpected response structure (missing series)');

  const obsMap = series.observations;
  if (!obsMap || typeof obsMap !== 'object') throw new Error('ECB CISS: no observations in response');

  const timeDim = json?.structure?.dimensions?.observation?.[0]?.values;
  if (!Array.isArray(timeDim) || timeDim.length === 0) throw new Error('ECB CISS: missing time dimension values');

  // Build sorted history array from index-keyed observations
  const history = Object.entries(obsMap)
    .map(([idxStr, arr]) => {
      const idx = parseInt(idxStr, 10);
      const date = timeDim[idx]?.id ?? null;
      const value = arr?.[0];
      if (!date || typeof value !== 'number' || !Number.isFinite(value)) return null;
      // Validate CISS is in [0, 1] range
      if (value < 0 || value > 1) {
        console.warn(`  ECB CISS: value ${value} out of [0,1] range on ${date} — skipping`);
        return null;
      }
      return { date, value };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (history.length === 0) throw new Error('ECB CISS: no valid observations parsed');

  const latest = history.at(-1);
  const latestValue = latest.value;
  const latestDate = latest.date;
  const label = classifyLabel(latestValue);

  console.log(`  ECB CISS: latest=${latestValue.toFixed(4)} (${latestDate}) label=${label} points=${history.length}`);

  return {
    seededAt: new Date().toISOString(),
    latestValue,
    latestDate,
    label,
    history,
    unavailable: false,
  };
}

// Contract opt-in: canonical record count for envelope + health.
// FSI-EU payload is `{latestValue, latestDate, label, history[], ...}`.
// Records = weekly CISS observations in the history array.
export function declareRecords(data) {
  return Array.isArray(data?.history) ? data.history.length : 0;
}

function validate(data) {
  return (
    data?.latestValue != null &&
    Number.isFinite(data.latestValue) &&
    data.latestValue >= 0 &&
    data.latestValue <= 1 &&
    Array.isArray(data.history) &&
    data.history.length > 0
  );
}

// isMain guard — required for scripts that export AND call runSeed at top level.
// Prevents runSeed() from firing when this module is imported in tests or CI.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMain) {
  runSeed('economic', 'fsi-eu', FSI_EU_KEY, fetchEcbCiss, {
    validateFn: validate,
    ttlSeconds: FSI_EU_TTL,
    sourceVersion: 'ecb-ciss-sdmx-v1',
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 20160, // 14 days — matches api/health.js SEED_META threshold
  }).catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
