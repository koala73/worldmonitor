#!/usr/bin/env node
import { runBundle, HOUR } from './_bundle-runner.mjs';

await runBundle('resilience-validation', [
  {
    label: 'External-Benchmark',
    script: 'benchmark-resilience-external.mjs',
    seedMetaKey: 'resilience:benchmark:external',
    intervalMs: 7 * 24 * HOUR,
    timeoutMs: 300_000,
  },
  {
    label: 'Outcome-Backtest',
    script: 'backtest-resilience-outcomes.mjs',
    seedMetaKey: 'resilience:backtest:outcomes',
    intervalMs: 7 * 24 * HOUR,
    timeoutMs: 300_000,
  },
  {
    label: 'Sensitivity-Suite',
    script: 'validate-resilience-sensitivity.mjs',
    seedMetaKey: 'resilience:sensitivity',
    intervalMs: 7 * 24 * HOUR,
    timeoutMs: 600_000,
  },
]);
