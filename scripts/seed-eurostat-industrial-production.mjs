#!/usr/bin/env node
/**
 * Seeds Eurostat `sts_inpr_m` (Industrial production index, monthly) for all
 * 27 EU members + EA20 + EU27_2020 aggregates.
 *
 * Monthly leading indicator of real-economy activity; not currently surfaced
 * elsewhere. Renders as the "Real economy pulse" sparkline on the Economic
 * Indicators card (monthly cadence badge).
 *
 * Cadence: monthly. TTL: 5 days (covers re-seed + daily retry cadence).
 */

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchEurostatAllGeos, makeValidator } from './_eurostat-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:eurostat:industrial-production:v1';
const TTL = 60 * 60 * 24 * 5; // 5 days (monthly)

const DATASET = {
  id: 'sts_inpr_m',
  // Seasonally + calendar adjusted, index (2021=100), NACE B-D (industry excl. construction)
  params: {
    unit: 'I21',
    s_adj: 'SCA',
    nace_r2: 'B-D',
  },
  unit: 'index (2021=100)',
  label: 'Industrial production index (monthly, SCA, 2021=100)',
  // Show last 12 months for sparkline.
  sparklineLength: 12,
};

async function fetchAll() {
  return fetchEurostatAllGeos(DATASET);
}

if (process.argv[1]?.endsWith('seed-eurostat-industrial-production.mjs')) {
  runSeed(
    'economic',
    'eurostat-industrial-production',
    CANONICAL_KEY,
    fetchAll,
    {
      // Monthly industrial-production has slightly patchier coverage than the
      // annual/quarterly datasets (small members lag or skip months); require
      // at least 22/29 geos so a bad run can't silently drop most of the EU.
      validateFn: makeValidator(22),
      ttlSeconds: TTL,
      sourceVersion: 'eurostat-sts-inpr-m-v1',
      recordCount: (data) => Object.keys(data?.countries || {}).length,
    },
  ).catch((err) => {
    const cause = err.cause
      ? ` (cause: ${err.cause.message || err.cause.code || err.cause})`
      : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
