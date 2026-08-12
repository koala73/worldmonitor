#!/usr/bin/env node

import { loadEnvFile, readCanonicalValue, runSeed } from './_seed-utils.mjs';
import { buildDefenseIndustrialSnapshot, WB_DEFENSE_INDICATORS } from './_defense-industrial-source.mjs';

loadEnvFile(import.meta.url, { only: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'SIPRI_ARMS_API_BASE_URL'] });

export const INDUSTRIAL_BASE_KEY = 'military:industrial-base:v1';
export const ARMS_SUPPLIERS_KEY = 'military:arms-suppliers:v1';
export const ARMS_SUPPLIERS_COMPLETE_KEY = 'military:arms-suppliers:complete:v1';
export const DEFENSE_INDUSTRIAL_TTL_SECONDS = 30 * 24 * 3600;

export function validateDefenseIndustrial(data) {
  return data && Object.keys(data.countries || {}).length >= 150;
}

function newestObservationTime(data) {
  const years = Object.values(data.countries || {}).flatMap((country) =>
    WB_DEFENSE_INDICATORS.map(({ key }) => key)
      .map((key) => country[key]?.year)
      .filter(Number.isInteger));
  if (years.length === 0) return null;
  const newest = Math.max(...years);
  const oldest = Math.min(...years);
  return {
    newestItemAt: Date.UTC(newest, 11, 31, 23, 59, 59),
    oldestItemAt: Date.UTC(oldest, 0, 1),
  };
}

function supplierContentMeta(data) {
  const endYears = Object.values(data.importers || {})
    .map((entry) => entry?.window?.endYear)
    .filter(Number.isInteger);
  if (endYears.length === 0) return { maxContentAgeMin: 800 * 24 * 60 };
  return {
    newestItemAt: Date.UTC(Math.max(...endYears), 11, 31, 23, 59, 59),
    oldestItemAt: Date.UTC(Math.min(...endYears), 0, 1),
    maxContentAgeMin: 800 * 24 * 60,
    sourceState: data.stage?.status || 'unknown',
  };
}

async function fetchDefenseIndustrialSnapshot() {
  const previous = await readCanonicalValue(ARMS_SUPPLIERS_KEY).catch(() => null);
  return buildDefenseIndustrialSnapshot({ previousSuppliers: previous?.importers || {} });
}

await runSeed('military', 'defense-industrial', INDUSTRIAL_BASE_KEY, fetchDefenseIndustrialSnapshot, {
  validateFn: validateDefenseIndustrial,
  ttlSeconds: DEFENSE_INDUSTRIAL_TTL_SECONDS,
  lockTtlMs: 20 * 60 * 1000,
  fetchPhaseTimeoutMs: 18 * 60 * 1000,
  declareRecords: (data) => Object.keys(data.countries || {}).length,
  sourceVersion: 'world-bank-sipri-v1',
  schemaVersion: 1,
  maxStaleMin: 28 * 24 * 60,
  maxContentAgeMin: 800 * 24 * 60,
  contentMeta: newestObservationTime,
  publishTransform: (data) => ({ countries: data.countries, stages: data.stages, fetchedAt: data.fetchedAt }),
  extraKeys: [
    {
      key: ARMS_SUPPLIERS_KEY,
      ttl: DEFENSE_INDUSTRIAL_TTL_SECONDS,
      transform: (data) => ({
        importers: data.suppliers,
        stage: data.stages.sipri,
        fetchedAt: data.fetchedAt,
        source: 'SIPRI Arms Transfers Database',
      }),
      declareRecords: (data) => Object.keys(data.importers || {}).length,
      skipWhenEmpty: true,
      metaKey: 'seed-meta:military:arms-suppliers',
      metaTtlSeconds: DEFENSE_INDUSTRIAL_TTL_SECONDS,
      metaCritical: true,
      metaExtra: supplierContentMeta,
    },
    {
      key: ARMS_SUPPLIERS_COMPLETE_KEY,
      ttl: DEFENSE_INDUSTRIAL_TTL_SECONDS,
      transform: (data) => data.stages.sipri.status === 'ok'
        ? { completedAt: data.fetchedAt, windowEndYear: data.stages.sipri.windowEndYear }
        : {},
      declareRecords: (data) => data.completedAt ? 1 : 0,
      skipWhenEmpty: true,
      metaKey: 'seed-meta:military:arms-suppliers-complete',
      metaTtlSeconds: DEFENSE_INDUSTRIAL_TTL_SECONDS,
      metaExtra: (data) => ({
        newestItemAt: Date.UTC(data.windowEndYear, 11, 31, 23, 59, 59),
        oldestItemAt: Date.UTC(data.windowEndYear - 4, 0, 1),
        maxContentAgeMin: 800 * 24 * 60,
      }),
    },
  ],
  preserveKeyTtls: [
    { key: ARMS_SUPPLIERS_KEY, ttlSeconds: DEFENSE_INDUSTRIAL_TTL_SECONDS },
    { key: 'seed-meta:military:arms-suppliers', ttlSeconds: DEFENSE_INDUSTRIAL_TTL_SECONDS },
    { key: ARMS_SUPPLIERS_COMPLETE_KEY, ttlSeconds: DEFENSE_INDUSTRIAL_TTL_SECONDS },
    { key: 'seed-meta:military:arms-suppliers-complete', ttlSeconds: DEFENSE_INDUSTRIAL_TTL_SECONDS },
  ],
});
