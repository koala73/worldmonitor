#!/usr/bin/env node

/**
 * Statistics Canada Web Data Service — same-day cube radar plus the CPI / LFS
 * series the Country Resilience Index consumes for CA. Issue #6676.
 * Independent clock from Bank of Canada Valet. Empty change-list is valid quiet.
 */

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  STATCAN_MAX_CONTENT_AGE_MIN,
  declareStatcanRecords,
  fetchStatcanWds,
  statcanContentMeta,
  validateStatcanPayload,
} from './lib/statcan-wds.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:statcan-wds:v1';
export const STATCAN_WDS_ACTIVATION_KEY = 'seed-activated:economic:statcan-wds';
const TTL = 4 * 86400;

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', STATCAN_WDS_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: activation marker write failed: ${err?.message || err}`);
  }
}

if (process.argv[1]?.endsWith('seed-statcan-wds.mjs')) {
  runSeed('economic', 'statcan-wds', CANONICAL_KEY, fetchStatcanWds, {
    validateFn: validateStatcanPayload,
    ttlSeconds: TTL,
    sourceVersion: 'statcan-wds-cpi+lfs+changed-cubes',
    declareRecords: declareStatcanRecords,
    schemaVersion: 1,
    maxStaleMin: 4320,
    contentMeta: statcanContentMeta,
    maxContentAgeMin: STATCAN_MAX_CONTENT_AGE_MIN,
    afterPublish: markActivated,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
