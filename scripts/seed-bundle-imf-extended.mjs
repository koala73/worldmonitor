#!/usr/bin/env node
import { runBundle, DAY } from './_bundle-runner.mjs';

await runBundle('imf-extended', [
  { label: 'IMF-Macro', script: 'seed-imf-macro.mjs', seedMetaKey: 'economic:imf-macro', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'IMF-Growth', script: 'seed-imf-growth.mjs', seedMetaKey: 'economic:imf-growth', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'IMF-Labor', script: 'seed-imf-labor.mjs', seedMetaKey: 'economic:imf-labor', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'IMF-External', script: 'seed-imf-external.mjs', seedMetaKey: 'economic:imf-external', intervalMs: 30 * DAY, timeoutMs: 300_000 },
]);
