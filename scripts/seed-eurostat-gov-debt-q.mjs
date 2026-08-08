#!/usr/bin/env node
/**
 * Seeds Eurostat `gov_10q_ggdebt` (General Government gross debt, quarterly %GDP)
 * for all 27 EU members + EA20 + EU27_2020 aggregates.
 *
 * Upgrades the National Debt card from annual (IMF GGXWDG_NGDP) to quarterly
 * cadence for EU countries. Rest of world continues to use IMF.
 *
 * Cadence: quarterly. TTL: 14 days (= cadence + buffer, matches health threshold).
 */

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchEurostatAllGeos, makeValidator } from './_eurostat-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:eurostat:gov-debt-q:v1';
const TTL = 60 * 60 * 24 * 14; // 14 days (quarterly)

const DATASET = {
  id: 'gov_10q_ggdebt',
  // Percentage of GDP, general government (S.13), gross Maastricht debt
  params: {
    unit: 'PC_GDP',
    sector: 'S13',
    na_item: 'GD',
  },
  unit: '% of GDP',
  label: 'Government gross debt (quarterly, % of GDP)',
  // Show last 8 quarters (2 years) for sparkline.
  sparklineLength: 8,
};

async function fetchAll() {
  return fetchEurostatAllGeos(DATASET);
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

if (process.argv[1]?.endsWith('seed-eurostat-gov-debt-q.mjs')) {
  runSeed('economic', 'eurostat-gov-debt-q', CANONICAL_KEY, fetchAll, {
    // Near-complete coverage: quarterly Maastricht gross-debt is reported by
    // all 27 EU members + EA20/EU27_2020 aggregates; allow up to ~5 of 29 geos
    // missing (24/29) before refusing to publish.
    validateFn: makeValidator(24),
    ttlSeconds: TTL,
    sourceVersion: 'eurostat-gov-10q-ggdebt-v1',
    recordCount: (data) => Object.keys(data?.countries || {}).length,
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 20160,
  }).catch((err) => {
    const cause = err.cause
      ? ` (cause: ${err.cause.message || err.cause.code || err.cause})`
      : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
