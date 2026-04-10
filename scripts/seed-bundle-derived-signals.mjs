#!/usr/bin/env node
import { runBundle, MIN } from './_bundle-runner.mjs';

await runBundle('derived-signals', [
  { label: 'Correlation', script: 'seed-correlation.mjs', seedMetaKey: 'correlation:cards', intervalMs: 5 * MIN, timeoutMs: 60_000 },
  { label: 'Cross-Source-Signals', script: 'seed-cross-source-signals.mjs', seedMetaKey: 'intelligence:cross-source-signals', intervalMs: 15 * MIN, timeoutMs: 120_000 },
]);
