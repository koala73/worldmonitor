#!/usr/bin/env node
import { runBundle, DAY, WEEK } from './_bundle-runner.mjs';

await runBundle('static-ref', [
  { label: 'Submarine-Cables', script: 'seed-submarine-cables.mjs', seedMetaKey: 'infrastructure:submarine-cables', canonicalKey: 'infrastructure:submarine-cables:v1', intervalMs: WEEK, timeoutMs: 300_000 },
  { label: 'Defense-Patents', script: 'seed-defense-patents.mjs', seedMetaKey: 'military:defense-patents', canonicalKey: 'patents:defense:latest', intervalMs: WEEK, timeoutMs: 180_000, requiredEnv: ['USPTO_API_KEY'] },
  // The source updates annually, but this refresh cadence keeps the requested
  // 30-day Redis cohort above the repository's 3x TTL safety floor.
  { label: 'Defense-Industrial', script: 'seed-defense-industrial.mjs', seedMetaKey: 'military:arms-suppliers-complete', canonicalKey: 'military:arms-suppliers:complete:v1', intervalMs: 10 * DAY, timeoutMs: 1_200_000 },
  { label: 'Chokepoint-Baselines', script: 'seed-chokepoint-baselines.mjs', seedMetaKey: 'energy:chokepoint-baselines', canonicalKey: 'energy:chokepoint-baselines:v1', intervalMs: 400 * DAY, timeoutMs: 60_000 },
  { label: 'Military-Bases', script: 'seed-military-bases.mjs', seedMetaKey: 'military:bases', intervalMs: 30 * DAY, timeoutMs: 600_000 },
]);
