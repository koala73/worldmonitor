#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'energy:spr-policies:v1';
export const SPR_POLICIES_TTL_SECONDS = 34_560_000; // ~400 days

const VALID_REGIMES = new Set([
  'mandatory_stockholding',
  'government_spr',
  'spare_capacity',
  'commercial_only',
  'none',
]);

const REQUIRED_COUNTRIES = ['CN', 'IN', 'JP', 'SA', 'US'];

export function buildPayload() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(resolve(__dirname, 'data', 'spr-policies.json'), 'utf-8');
  const registry = JSON.parse(raw);
  return {
    ...registry,
    updatedAt: new Date().toISOString(),
  };
}

export function validateFn(data) {
  if (!data?.policies || typeof data.policies !== 'object') return false;
  const entries = Object.entries(data.policies);
  if (entries.length < 30) return false;

  const iso2Re = /^[A-Z]{2}$/;
  for (const [key, entry] of entries) {
    if (!iso2Re.test(key)) return false;
    if (!VALID_REGIMES.has(entry.regime)) return false;
    if (typeof entry.source !== 'string' || entry.source.length === 0) return false;
    if (typeof entry.asOf !== 'string' || entry.asOf.length === 0) return false;
    if ('capacityMb' in entry) {
      if (typeof entry.capacityMb !== 'number' || !Number.isFinite(entry.capacityMb) || entry.capacityMb < 0) return false;
    }
    if ('estimatedFillPct' in entry) return false;
  }

  for (const reqCode of REQUIRED_COUNTRIES) {
    if (!(reqCode in data.policies)) return false;
  }

  return true;
}

const isMain = process.argv[1]?.endsWith('seed-spr-policies.mjs');
export function declareRecords(data) {
  return Object.keys(data?.policies || {}).length;
}

if (isMain) {
  runSeed('energy', 'spr-policies', CANONICAL_KEY, buildPayload, {
    validateFn,
    ttlSeconds: SPR_POLICIES_TTL_SECONDS,
    sourceVersion: 'spr-policies-registry-v1',
    recordCount: (data) => Object.keys(data?.policies ?? {}).length,
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 576000,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
