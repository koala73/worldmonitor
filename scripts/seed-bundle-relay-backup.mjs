#!/usr/bin/env node
import { runBundle } from './_bundle-runner.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

await runBundle('relay-backup', [
  { label: 'Climate-News', script: 'seed-climate-news.mjs', seedMetaKey: 'climate:news-intelligence', intervalMs: 30 * MIN, timeoutMs: 240_000 },
  { label: 'USA-Spending', script: 'seed-usa-spending.mjs', seedMetaKey: 'economic:spending', intervalMs: HOUR, timeoutMs: 120_000 },
  { label: 'UCDP-Events', script: 'seed-ucdp-events.mjs', seedMetaKey: 'conflict:ucdp-events', intervalMs: 6 * HOUR, timeoutMs: 300_000 },
  { label: 'WB-Indicators', script: 'seed-wb-indicators.mjs', seedMetaKey: 'economic:worldbank-techreadiness', intervalMs: DAY, timeoutMs: 300_000 },
]);
