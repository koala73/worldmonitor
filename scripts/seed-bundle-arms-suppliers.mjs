#!/usr/bin/env node
import { runBundle, DAY } from './_bundle-runner.mjs';

// 1-section sibling of seed-bundle-static-ref (#6806 PR1).
// Arms-Suppliers' worst case is 460s of a 570s tick. After a measured ~277s
// run, leftover cannot still admit Military-Bases (410s). This service exists
// so Arms no longer consumes leftover's budget. Do not add a second section.
await runBundle('arms-suppliers', [
  { label: 'Arms-Suppliers', script: 'seed-defense-industrial-suppliers.mjs', seedMetaKey: 'military:arms-suppliers-complete', canonicalKey: 'military:arms-suppliers:complete:v1', intervalMs: 10 * DAY, timeoutMs: 450_000 },
], { maxBundleMs: 570_000 });
