#!/usr/bin/env node
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { fetchShfeNotices } from './china-futures/shfe-notices.mjs';
import { CACHE_KEY, MAX_STALE_MIN, MAX_CONTENT_AGE_MIN, TTL_SECONDS, validateSnapshot, contentMeta } from './china-futures/contract.mjs';

export async function runChinaFuturesNoticesSeed({
  enabled = process.env.CHINA_FUTURES_NEWS_ENABLED === '1',
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now(),
  runSeedFn = runSeed,
} = {}) {
  if (!enabled) return { disabled: true };
  return runSeedFn('news', 'china-futures:shfe:notices', CACHE_KEY,
    () => fetchShfeNotices({ fetchImpl, now }), {
      validateFn: (value) => validateSnapshot(value),
      declareRecords: (value) => value?.items?.length ?? 0,
      sourceVersion: 'shfe-official-notices-v1',
      schemaVersion: 1,
      zeroIsValid: false,
      maxStaleMin: MAX_STALE_MIN,
      contentMeta,
      maxContentAgeMin: MAX_CONTENT_AGE_MIN,
      ttlSeconds: TTL_SECONDS,
      lockTtlMs: 120_000,
      fetchPhaseTimeoutMs: 20_000,
    });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  loadEnvFile(import.meta.url);
  await runChinaFuturesNoticesSeed().catch((error) => {
    console.error(`SHFE notices seed failed: ${error.message}`);
    process.exitCode = 1;
  });
}
