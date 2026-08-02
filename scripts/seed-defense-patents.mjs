#!/usr/bin/env node
// Seed USPTO Open Data Portal defense/dual-use patent filings (issues #2047, #5255).
// Weekly cron — top 20 recent filings per strategic CPC category.

import { pathToFileURL } from 'node:url';
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchAllPatents } from './_defense-patents-source.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'patents:defense:latest';
const CACHE_TTL = 1_814_400; // 21 days (3× weekly interval)

export function validateDefensePatents(data) {
  return Array.isArray(data?.patents) && data.patents.length > 0;
}

export function declareRecords(data) {
  return data?.patents?.length ?? 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSeed(
    'military',
    'defense-patents',
    CANONICAL_KEY,
    () => fetchAllPatents({ apiKey: process.env.USPTO_API_KEY }),
    {
      validateFn: validateDefensePatents,
      ttlSeconds: CACHE_TTL,
      sourceVersion: 'uspto-odp-v1',
      recordCount: (data) => data?.patents?.length ?? 0,
      declareRecords,
      schemaVersion: 2,
      maxStaleMin: 25200,
    },
  ).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
