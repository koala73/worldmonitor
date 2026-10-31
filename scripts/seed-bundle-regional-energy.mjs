#!/usr/bin/env node
import { runBundle } from './_bundle-runner.mjs';
import { claimBundleTurn, acknowledgeBundleTurn } from './_bundle-turn.mjs';
import { orderRegionalEnergySections } from './_regional-energy-order.mjs';

// Regional grid and fuel feeds (#9842). They run in their own service so the
// daily energy-sources bundle keeps its cadence, and so a failing government
// host retries only on this service's ticks. Each section keeps its own
// interval gate; tests pin this array to scripts/shared/regional-energy-feeds.json.
const SECTIONS = [
  { label: 'Regional-Energy-pgcb', script: 'seed-regional-energy-pgcb.mjs', seedMetaKey: 'energy:regional-pgcb', canonicalKey: 'energy:regional:pgcb:v1', completionMetaKey: 'seed-completion:energy:regional-pgcb', expectedSourceVersion: 'regional-energy-pgcb-v1', intervalMs: 3600000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-petrobangla', script: 'seed-regional-energy-petrobangla.mjs', seedMetaKey: 'energy:regional-petrobangla', canonicalKey: 'energy:regional:petrobangla:v1', completionMetaKey: 'seed-completion:energy:regional-petrobangla', expectedSourceVersion: 'regional-energy-petrobangla-v1', intervalMs: 86400000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-niso', script: 'seed-regional-energy-niso.mjs', seedMetaKey: 'energy:regional-niso', canonicalKey: 'energy:regional:niso:v1', completionMetaKey: 'seed-completion:energy:regional-niso', expectedSourceVersion: 'regional-energy-niso-v1', intervalMs: 21600000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-eskom', script: 'seed-regional-energy-eskom.mjs', seedMetaKey: 'energy:regional-eskom', canonicalKey: 'energy:regional:eskom:v1', completionMetaKey: 'seed-completion:energy:regional-eskom', expectedSourceVersion: 'regional-energy-eskom-v1', intervalMs: 86400000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-cammesa', script: 'seed-regional-energy-cammesa.mjs', seedMetaKey: 'energy:regional-cammesa', canonicalKey: 'energy:regional:cammesa:v1', completionMetaKey: 'seed-completion:energy:regional-cammesa', expectedSourceVersion: 'regional-energy-cammesa-v1', intervalMs: 3600000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-gse', script: 'seed-regional-energy-gse.mjs', seedMetaKey: 'energy:regional-gse', canonicalKey: 'energy:regional:gse:v1', completionMetaKey: 'seed-completion:energy:regional-gse', expectedSourceVersion: 'regional-energy-gse-v1', intervalMs: 86400000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-ons', script: 'seed-regional-energy-ons.mjs', seedMetaKey: 'energy:regional-ons', canonicalKey: 'energy:regional:ons:v1', completionMetaKey: 'seed-completion:energy:regional-ons', expectedSourceVersion: 'regional-energy-ons-v1', intervalMs: 43200000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-anp', script: 'seed-regional-energy-anp.mjs', seedMetaKey: 'energy:regional-anp', canonicalKey: 'energy:regional:anp:v1', completionMetaKey: 'seed-completion:energy:regional-anp', expectedSourceVersion: 'regional-energy-anp-v1', intervalMs: 86400000, timeoutMs: 120_000 },
];

// A null claim means another run holds the lease, credentials are absent, or
// Upstash failed transiently. Defer the tick without advancing the turn.
const claim = await claimBundleTurn('regional-energy');
if (!claim) {
  console.log('[Bundle:regional-energy] scheduler lease held or Redis unavailable; deferring this tick.');
  process.exit(0);
}
const sections = orderRegionalEnergySections(SECTIONS, claim.turn);
console.log(`[Bundle:regional-energy] turn ${claim.turn} — order: ${sections.map(s => s.label).join(' -> ')}`);

await runBundle('regional-energy', sections, {
  maxBundleMs: 570_000,
  prefetchFreshness: true,
  // Advance after every completed tick, including a non-zero one, so a failing
  // lead group cannot hold the first slot. A killed run repeats its turn after
  // the lease expires.
  onTerminalComplete: async () => {
    if (!await acknowledgeBundleTurn('regional-energy', claim)) throw new Error(`could not acknowledge scheduler turn ${claim.turn}`);
  },
});
