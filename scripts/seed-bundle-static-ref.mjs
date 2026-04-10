#!/usr/bin/env node
import { runBundle, DAY, WEEK } from './_bundle-runner.mjs';

await runBundle('static-ref', [
  { label: 'Submarine-Cables', script: 'seed-submarine-cables.mjs', seedMetaKey: 'infrastructure:submarine-cables', intervalMs: WEEK, timeoutMs: 300_000 },
  { label: 'Chokepoint-Baselines', script: 'seed-chokepoint-baselines.mjs', seedMetaKey: 'energy:chokepoint-baselines', intervalMs: 400 * DAY, timeoutMs: 60_000 },
]);
