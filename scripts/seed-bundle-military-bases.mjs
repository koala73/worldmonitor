#!/usr/bin/env node
import { runBundle, DAY } from './_bundle-runner.mjs';

// 1-section sibling of seed-bundle-static-ref (#6806 PR1).
// Military-Bases' worst case is 410s. After Arms-Suppliers runs in leftover,
// 293s remains and this section is refused every time. Missing canonicalKey
// is intentional (#6845); do not invent one here. Do not add a second section.
await runBundle('military-bases', [
  { label: 'Military-Bases', script: 'seed-military-bases.mjs', seedMetaKey: 'military:bases', intervalMs: 30 * DAY, timeoutMs: 400_000 },
], { maxBundleMs: 570_000 });
