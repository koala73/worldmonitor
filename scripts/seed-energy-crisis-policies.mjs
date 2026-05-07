#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'energy:crisis-policies:v1';
export const CRISIS_POLICIES_TTL_SECONDS = 34_560_000; // ~400 days

const VALID_CATEGORIES = new Set(['conservation', 'consumer_support']);
const VALID_STATUSES = new Set(['active', 'planned', 'ended']);
const VALID_SECTORS = new Set([
  'Transport', 'Cooling', 'Campaign', 'Work from home', 'Government travel',
  'Schools and universities', 'Taxation', 'Price caps', 'Fuel subsidies', 'Other',
]);

export function buildPayload() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(resolve(__dirname, 'data', 'energy-crisis-policies.json'), 'utf-8');
  const registry = JSON.parse(raw);

  const policies = registry.policies.map((p) => ({
    country: p.country,
    countryCode: p.countryCode,
    category: p.category,
    sector: p.sector,
    measure: p.measure,
    dateAnnounced: p.dateAnnounced,
    status: p.status,
  }));

  return {
    source: registry.source,
    sourceUrl: registry.sourceUrl,
    context: registry.context,
    policies,
    updatedAt: new Date().toISOString(),
  };
}

export function validateFn(data) {
  if (!data?.policies || !Array.isArray(data.policies)) return false;
  if (data.policies.length < 10) return false;

  const iso2Re = /^[A-Z]{2}$/;
  for (const p of data.policies) {
    if (typeof p.country !== 'string' || p.country.length === 0) return false;
    if (!iso2Re.test(p.countryCode)) return false;
    if (!VALID_CATEGORIES.has(p.category)) return false;
    if (!VALID_STATUSES.has(p.status)) return false;
    if (!VALID_SECTORS.has(p.sector)) return false;
    if (typeof p.measure !== 'string' || p.measure.length === 0) return false;
  }

  return true;
}

const isMain = process.argv[1]?.endsWith('seed-energy-crisis-policies.mjs');
export function declareRecords(data) {
  return Array.isArray(data?.policies) ? data.policies.length : 0;
}

if (isMain) {
  runSeed('energy', 'crisis-policies', CANONICAL_KEY, buildPayload, {
    validateFn,
    ttlSeconds: CRISIS_POLICIES_TTL_SECONDS,
    sourceVersion: 'iea-crisis-policies-v1',
    recordCount: (data) => data?.policies?.length ?? 0,
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 576000,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
