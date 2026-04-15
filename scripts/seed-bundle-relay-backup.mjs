#!/usr/bin/env node
import { runBundle, MIN, HOUR, DAY } from './_bundle-runner.mjs';

await runBundle('relay-backup', [
  { label: 'Climate-News', script: 'seed-climate-news.mjs', seedMetaKey: 'climate:news-intelligence', canonicalKey: 'climate:news-intelligence:v1', intervalMs: 30 * MIN, timeoutMs: 240_000 },
  { label: 'USA-Spending', script: 'seed-usa-spending.mjs', seedMetaKey: 'economic:spending', canonicalKey: 'economic:spending:v1', intervalMs: HOUR, timeoutMs: 120_000 },
  { label: 'UCDP-Events', script: 'seed-ucdp-events.mjs', seedMetaKey: 'conflict:ucdp-events', intervalMs: 6 * HOUR, timeoutMs: 300_000 },
  { label: 'WB-Indicators', script: 'seed-wb-indicators.mjs', seedMetaKey: 'economic:worldbank-techreadiness:v1', intervalMs: DAY, timeoutMs: 300_000 },
]);
