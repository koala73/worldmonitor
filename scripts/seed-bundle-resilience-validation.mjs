#!/usr/bin/env node
// Railway: dockerfilePath=Dockerfile.seed-bundle-resilience-validation.
// The Dockerfile wires NODE_OPTIONS --import to tsx's loader via absolute
// path so that dynamic imports of ../server/*.ts work in spawned children.
import { runBundle, WEEK } from './_bundle-runner.mjs';

await runBundle('resilience-validation', [
  {
    label: 'External-Benchmark',
    script: 'benchmark-resilience-external.mjs',
    intervalMs: WEEK,
    timeoutMs: 300_000,
  },
  {
    label: 'Outcome-Backtest',
    script: 'backtest-resilience-outcomes.mjs',
    intervalMs: WEEK,
    timeoutMs: 300_000,
  },
  {
    label: 'Sensitivity-Suite',
    script: 'validate-resilience-sensitivity.mjs',
    intervalMs: WEEK,
    timeoutMs: 600_000,
  },
]);
