#!/usr/bin/env node

/**
 * Bank of Canada Valet — official CAD FX, overnight target, and benchmark yields.
 * Issue #6616. Independent clock from Statistics Canada WDS.
 */

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  BOC_MAX_CONTENT_AGE_MIN,
  bocContentMeta,
  declareBocRecords,
  fetchBocValet,
  validateBocPayload,
} from './lib/boc-valet.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:boc-valet:v1';
export const BOC_VALET_ACTIVATION_KEY = 'seed-activated:economic:boc-valet';
const TTL = 4 * 86400;

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', BOC_VALET_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: activation marker write failed: ${err?.message || err}`);
  }
}

if (process.argv[1]?.endsWith('seed-boc-valet.mjs')) {
  runSeed('economic', 'boc-valet', CANONICAL_KEY, fetchBocValet, {
    validateFn: validateBocPayload,
    ttlSeconds: TTL,
    sourceVersion: 'boc-valet-fx+policy+yields',
    declareRecords: declareBocRecords,
    schemaVersion: 1,
    maxStaleMin: 4320,
    contentMeta: bocContentMeta,
    maxContentAgeMin: BOC_MAX_CONTENT_AGE_MIN,
    afterPublish: markActivated,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
