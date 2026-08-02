#!/usr/bin/env node
import { runBundle, MIN, HOUR } from './_bundle-runner.mjs';
import { CHINA_DECISION_SIGNALS_KEY } from './seed-china-decision-signals.mjs';

await runBundle('derived-signals', [
  { label: 'Correlation', script: 'seed-correlation.mjs', seedMetaKey: 'correlation:cards', canonicalKey: 'correlation:cards-bootstrap:v1', intervalMs: 5 * MIN, timeoutMs: 60_000 },
  { label: 'Cross-Source-Signals', script: 'seed-cross-source-signals.mjs', seedMetaKey: 'intelligence:cross-source-signals', canonicalKey: 'intelligence:cross-source-signals:v1', intervalMs: 15 * MIN, timeoutMs: 120_000 },
  // Gate on the completion marker written only after the canonical archive,
  // compact bootstrap projection, and per-source health records all succeed.
  // A partial cohort therefore retries on the next bundle tick.
  // any-of: the adapter resolves JAPAN_MOD_PROXY_URL || PROXY_URL, so gating on
  // the source-specific name alone would hard-fail this section in an
  // environment where only the shared exit is configured -- even though the
  // seeder would have run with no degradation.
  { label: 'Cross-Strait-Activity', script: 'seed-cross-strait-activity.mjs', seedMetaKey: 'military:cross-strait-activity:complete', intervalMs: 3 * HOUR, timeoutMs: 300_000, requiredEnv: [['JAPAN_MOD_PROXY_URL', 'PROXY_URL']] },
  { label: 'China-Decision-Signals', script: 'seed-china-decision-signals.mjs', seedMetaKey: 'intelligence:china-decision-signals', canonicalKey: CHINA_DECISION_SIGNALS_KEY, intervalMs: 15 * MIN, timeoutMs: 90_000 },
  { label: 'Regional-Snapshots', script: 'seed-regional-snapshots.mjs', seedMetaKey: 'intelligence:regional-snapshots', intervalMs: 6 * HOUR, timeoutMs: 180_000 },
], {
  // Railway kills cron containers at 10 minutes. Defer sections whose full
  // timeout plus SIGTERM/SIGKILL grace cannot fit, preserving completed work.
  maxBundleMs: 570_000,
});
