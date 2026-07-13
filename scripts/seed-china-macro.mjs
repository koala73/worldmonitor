#!/usr/bin/env node
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchChinaMacroSnapshot, observationDateMs } from './china-macro/adapters.mjs';

loadEnvFile(import.meta.url);

export const CHINA_MACRO_KEY = 'economic:china:macro:v1';
export const CHINA_MACRO_TTL_SECONDS = 7 * 24 * 60 * 60;
export const CHINA_MACRO_MAX_CONTENT_AGE_MIN = 120 * 24 * 60;

export function validateChinaMacroSnapshot(snapshot) {
  return snapshot?.launchReady === true
    && snapshot?.status === 'ready'
    && Array.isArray(snapshot?.indicators)
    && snapshot.indicators.length >= 4;
}

export function chinaMacroContentMeta(snapshot) {
  if (!snapshot?.launchReady || !snapshot.contentObservationDate) return null;
  const observedAt = observationDateMs(snapshot.contentObservationDate);
  if (observedAt == null) return null;
  return { newestItemAt: observedAt, oldestItemAt: observedAt };
}

if (process.argv[1]?.endsWith('seed-china-macro.mjs')) {
  runSeed('economic', 'china-macro', CHINA_MACRO_KEY, fetchChinaMacroSnapshot, {
    ttlSeconds: CHINA_MACRO_TTL_SECONDS,
    lockTtlMs: 180_000,
    validateFn: validateChinaMacroSnapshot,
    declareRecords: (data) => data.indicators.filter((item) => Number.isFinite(item?.value)).length,
    sourceVersion: 'china-macro-oecd-bis-fred-hkma-v1',
    schemaVersion: 1,
    maxStaleMin: 4_320,
    contentMeta: chinaMacroContentMeta,
    maxContentAgeMin: CHINA_MACRO_MAX_CONTENT_AGE_MIN,
  });
}
