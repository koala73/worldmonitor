#!/usr/bin/env node
import { runBundle, HOUR, DAY } from './_bundle-runner.mjs';

await runBundle('health', [
  { label: 'Air-Quality', script: 'seed-health-air-quality.mjs', seedMetaKey: 'health:air-quality', intervalMs: HOUR, timeoutMs: 600_000 },
  { label: 'Disease-Outbreaks', script: 'seed-disease-outbreaks.mjs', seedMetaKey: 'health:disease-outbreaks', intervalMs: DAY, timeoutMs: 300_000 },
  { label: 'VPD-Tracker', script: 'seed-vpd-tracker.mjs', seedMetaKey: 'health:vpd-tracker', intervalMs: DAY, timeoutMs: 300_000 },
  { label: 'Displacement', script: 'seed-displacement-summary.mjs', seedMetaKey: 'displacement:summary', intervalMs: DAY, timeoutMs: 300_000 },
]);
