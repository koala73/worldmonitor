#!/usr/bin/env node
import { runBundle, HOUR, DAY } from './_bundle-runner.mjs';

await runBundle('resilience', [
  { label: 'Resilience-Scores', script: 'seed-resilience-scores.mjs', seedMetaKey: 'resilience:intervals', intervalMs: 6 * HOUR, timeoutMs: 600_000 },
  { label: 'Resilience-Static', script: 'seed-resilience-static.mjs', seedMetaKey: 'resilience:static', intervalMs: 90 * DAY, timeoutMs: 900_000 },
]);
