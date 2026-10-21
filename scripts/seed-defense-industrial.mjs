#!/usr/bin/env node

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  buildWorldBankIndustrialSnapshot,
  DEFENSE_INDUSTRIAL_TTL_SECONDS,
  WB_DEFENSE_INDICATORS,
} from './_defense-industrial-source.mjs';

loadEnvFile(import.meta.url, { only: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] });

export const INDUSTRIAL_BASE_KEY = 'military:industrial-base:v1';
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

await runSeed('military', 'defense-industrial', INDUSTRIAL_BASE_KEY, buildWorldBankIndustrialSnapshot, {
  validateFn: validateDefenseIndustrial,
  ttlSeconds: DEFENSE_INDUSTRIAL_TTL_SECONDS,
  lockTtlMs: 90_000,
  fetchPhaseTimeoutMs: 75_000,
  declareRecords: (data) => Object.keys(data.countries || {}).length,
  sourceVersion: 'world-bank-v1',
  schemaVersion: 1,
  maxStaleMin: 28 * 24 * 60,
  maxContentAgeMin: 800 * 24 * 60,
  contentMeta: newestObservationTime,
  publishTransform: (data) => ({ countries: data.countries, stage: data.stage, fetchedAt: data.fetchedAt }),
});
