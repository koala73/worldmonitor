#!/usr/bin/env node
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchChinaReleaseCalendar } from './china-macro/calendar.mjs';

loadEnvFile(import.meta.url);

export const CHINA_RELEASE_CALENDAR_KEY = 'economic:china:release-calendar:v1';

if (process.argv[1]?.endsWith('seed-china-release-calendar.mjs')) {
  runSeed('economic', 'china-release-calendar', CHINA_RELEASE_CALENDAR_KEY, fetchChinaReleaseCalendar, {
    ttlSeconds: 45 * 24 * 60 * 60,
    lockTtlMs: 180_000,
    validateFn: (data) => Array.isArray(data?.events) && data.events.some((event) => event?.countryCode === 'CN'),
    declareRecords: (data) => data.events.length,
    sourceVersion: 'china-release-calendar-nbs-pboc-v1',
    schemaVersion: 1,
    maxStaleMin: 4_320,
  });
}
