#!/usr/bin/env node
import { runBundle, MIN, HOUR } from './_bundle-runner.mjs';

await runBundle('derived-signals', [
  { label: 'Correlation', script: 'seed-correlation.mjs', seedMetaKey: 'correlation:cards', canonicalKey: 'correlation:cards-bootstrap:v1', intervalMs: 5 * MIN, timeoutMs: 60_000 },
  { label: 'Cross-Source-Signals', script: 'seed-cross-source-signals.mjs', seedMetaKey: 'intelligence:cross-source-signals', canonicalKey: 'intelligence:cross-source-signals:v1', intervalMs: 15 * MIN, timeoutMs: 120_000 },
  // Gate on the completion marker written only after the canonical archive,
  // compact bootstrap projection, and per-source health records all succeed.
  // A partial cohort therefore retries on the next bundle tick.
  { label: 'Cross-Strait-Activity', script: 'seed-cross-strait-activity.mjs', seedMetaKey: 'military:cross-strait-activity:complete', intervalMs: 3 * HOUR, timeoutMs: 300_000 },
  { label: 'Regional-Snapshots', script: 'seed-regional-snapshots.mjs', seedMetaKey: 'intelligence:regional-snapshots', intervalMs: 6 * HOUR, timeoutMs: 180_000 },
], {
  // Railway kills cron containers at 10 minutes. Defer sections whose full
  // timeout plus SIGTERM/SIGKILL grace cannot fit, preserving completed work.
  maxBundleMs: 570_000,
});
