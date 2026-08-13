#!/usr/bin/env node
import { runBundle, DAY, WEEK } from './_bundle-runner.mjs';

await runBundle('static-ref', [
  // Keep the two upstreams as separate processes. A World Bank failure cannot
  // prevent a healthy SIPRI publication, and the daily tick lets the wall-time
  // budget defer lower-priority members without missing their real cadence.
  { label: 'Arms-Suppliers', script: 'seed-defense-industrial-suppliers.mjs', seedMetaKey: 'military:arms-suppliers-complete', canonicalKey: 'military:arms-suppliers:complete:v1', intervalMs: 10 * DAY, timeoutMs: 450_000 },
  { label: 'Defense-Industrial', script: 'seed-defense-industrial.mjs', seedMetaKey: 'military:defense-industrial', canonicalKey: 'military:industrial-base:v1', intervalMs: 10 * DAY, timeoutMs: 100_000 },
  { label: 'Submarine-Cables', script: 'seed-submarine-cables.mjs', seedMetaKey: 'infrastructure:submarine-cables', canonicalKey: 'infrastructure:submarine-cables:v1', intervalMs: WEEK, timeoutMs: 300_000 },
  { label: 'Defense-Patents', script: 'seed-defense-patents.mjs', seedMetaKey: 'military:defense-patents', canonicalKey: 'patents:defense:latest', intervalMs: WEEK, timeoutMs: 180_000, requiredEnv: ['USPTO_API_KEY'] },
  { label: 'Chokepoint-Baselines', script: 'seed-chokepoint-baselines.mjs', seedMetaKey: 'energy:chokepoint-baselines', canonicalKey: 'energy:chokepoint-baselines:v1', intervalMs: 400 * DAY, timeoutMs: 60_000 },
  { label: 'Military-Bases', script: 'seed-military-bases.mjs', seedMetaKey: 'military:bases', intervalMs: 30 * DAY, timeoutMs: 540_000 },
  { label: 'Mineral-Production', script: 'seed-mineral-production.mjs', seedMetaKey: 'supply-chain:mineral-production', canonicalKey: 'supply-chain:mineral-production:v1', intervalMs: 60 * DAY, timeoutMs: 180_000 },
], { maxBundleMs: 570_000 });
