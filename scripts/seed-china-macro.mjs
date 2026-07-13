#!/usr/bin/env node
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchChinaMacroSnapshot } from './china-macro/adapters.mjs';

loadEnvFile(import.meta.url);

export const CHINA_MACRO_KEY = 'economic:china:macro:v1';
export const CHINA_MACRO_TTL_SECONDS = 7 * 24 * 60 * 60;
export const CHINA_MACRO_MAX_CONTENT_AGE_MIN = 120 * 24 * 60;

export function chinaMacroContentMeta(snapshot) {
  if (!snapshot?.launchReady || !snapshot.contentObservationDate) return null;
  const month = /^(\d{4})-(\d{2})$/.exec(snapshot.contentObservationDate);
  const observedAt = month
    ? Date.UTC(Number(month[1]), Number(month[2]), 0, 23, 59, 59)
    : Date.parse(`${snapshot.contentObservationDate}${/^\d{4}-\d{2}-\d{2}$/.test(snapshot.contentObservationDate) ? 'T23:59:59Z' : ''}`);
  if (!Number.isFinite(observedAt)) return null;
  return { newestItemAt: observedAt, oldestItemAt: observedAt };
}

if (process.argv[1]?.endsWith('seed-china-macro.mjs')) {
  runSeed('economic', 'china-macro', CHINA_MACRO_KEY, fetchChinaMacroSnapshot, {
    ttlSeconds: CHINA_MACRO_TTL_SECONDS,
    lockTtlMs: 180_000,
    validateFn: (data) => Array.isArray(data?.indicators) && data.indicators.length >= 4,
    declareRecords: (data) => data.indicators.filter((item) => Number.isFinite(item?.value)).length,
    sourceVersion: 'china-macro-oecd-bis-fred-hkma-v1',
    schemaVersion: 1,
    maxStaleMin: 4_320,
    contentMeta: chinaMacroContentMeta,
    maxContentAgeMin: CHINA_MACRO_MAX_CONTENT_AGE_MIN,
  });
}
