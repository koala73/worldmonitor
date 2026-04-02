#!/usr/bin/env node

/**
 * Seed C-REIT disclosure data from akshare (EastMoney source).
 * Calls fetch-reit-disclosure.py → parses JSON → writes to Redis.
 *
 * Data: NAV, cumulative NAV, premium/discount, dividend history,
 *       distribution yield, real-time volume/turnover.
 *
 * Redis key: reits:disclosure:v1 (TTL 3600s / 1hr)
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = join(__dirname, 'fetch-reit-disclosure.py');
const CANONICAL_KEY = 'reits:disclosure:v1';
const CACHE_TTL = 3600; // 1 hour

async function fetchDisclosure() {
  console.log('  [disclosure] Running akshare Python fetcher...');

  const stdout = execFileSync('python3', [PYTHON_SCRIPT], {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'inherit'], // stderr → visible in console
  });

  const data = JSON.parse(stdout.trim());

  if (!data?.disclosures?.length) {
    throw new Error('No disclosure data returned from akshare');
  }

  const successful = data.disclosures.filter((d) => !d.error);
  console.log(`  [disclosure] ${successful.length}/${data.disclosures.length} C-REITs fetched`);

  return data;
}

function validate(data) {
  return Array.isArray(data?.disclosures) && data.disclosures.length >= 1;
}

runSeed('reits', 'disclosure', CANONICAL_KEY, fetchDisclosure, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'akshare-v1',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
