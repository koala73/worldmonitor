#!/usr/bin/env node
/**
 * Seeds Eurostat `prc_hpi_a` (House price index, annual) for all 27 EU members
 * + EA20 + EU27_2020 aggregates.
 *
 * Complements BIS WS_SPP (#3026) — Eurostat provides full EU coverage where
 * BIS is sparse. Renders in the shared Housing cycle tile.
 *
 * Cadence: annual. TTL: 35 days (cadence + 5d buffer).
 */

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchEurostatAllGeos, makeValidator } from './_eurostat-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:eurostat:house-prices:v1';
const TTL = 60 * 60 * 24 * 35; // 35 days (annual)

const DATASET = {
  id: 'prc_hpi_a',
  // purchases of newly built + existing dwellings, index base 2015=100
  params: { unit: 'I15_A_AVG', purchase: 'TOTAL' },
  unit: 'index (2015=100)',
  label: 'House price index (annual, 2015=100)',
  // Show last 10 years for sparkline.
  sparklineLength: 10,
};

async function fetchAll() {
  return fetchEurostatAllGeos(DATASET);
}

if (process.argv[1]?.endsWith('seed-eurostat-house-prices.mjs')) {
  runSeed('economic', 'eurostat-house-prices', CANONICAL_KEY, fetchAll, {
    // Near-complete coverage: annual house-price index is well-reported across
    // all 27 EU members; allow up to ~5 of 29 geos missing (24/29) before we
    // refuse to publish a snapshot that would silently lose most of the EU.
    validateFn: makeValidator(24),
    ttlSeconds: TTL,
    sourceVersion: 'eurostat-prc-hpi-a-v1',
    recordCount: (data) => Object.keys(data?.countries || {}).length,
  }).catch((err) => {
    const cause = err.cause
      ? ` (cause: ${err.cause.message || err.cause.code || err.cause})`
      : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
