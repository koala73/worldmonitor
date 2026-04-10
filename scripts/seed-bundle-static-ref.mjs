#!/usr/bin/env node
import { runBundle } from './_bundle-runner.mjs';

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

await runBundle('static-ref', [
  { label: 'Submarine-Cables', script: 'seed-submarine-cables.mjs', seedMetaKey: 'infrastructure:submarine-cables', intervalMs: WEEK, timeoutMs: 300_000 },
  { label: 'Chokepoint-Baselines', script: 'seed-chokepoint-baselines.mjs', seedMetaKey: 'energy:chokepoint-baselines', intervalMs: 400 * DAY, timeoutMs: 60_000 },
  { label: 'Military-Bases', script: 'seed-military-bases.mjs', seedMetaKey: 'military:bases', intervalMs: 30 * DAY, timeoutMs: 120_000 },
]);
