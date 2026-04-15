#!/usr/bin/env node
import { runBundle, DAY, WEEK } from './_bundle-runner.mjs';

await runBundle('static-ref', [
  { label: 'Submarine-Cables', script: 'seed-submarine-cables.mjs', seedMetaKey: 'infrastructure:submarine-cables', canonicalKey: 'infrastructure:submarine-cables:v1', intervalMs: WEEK, timeoutMs: 300_000 },
  { label: 'Chokepoint-Baselines', script: 'seed-chokepoint-baselines.mjs', seedMetaKey: 'energy:chokepoint-baselines', canonicalKey: 'energy:chokepoint-baselines:v1', intervalMs: 400 * DAY, timeoutMs: 60_000 },
  { label: 'Military-Bases', script: 'seed-military-bases.mjs', seedMetaKey: 'military:bases', intervalMs: 30 * DAY, timeoutMs: 600_000 },
]);
