#!/usr/bin/env node
import { runBundle } from './_bundle-runner.mjs';
import { claimBundleTurn, acknowledgeBundleTurn } from './_bundle-turn.mjs';
import { orderRegionalEnergySections } from './_regional-energy-order.mjs';

// Regional grid and fuel feeds (#9842, #9893, #10051). They run in their own service so the
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
  { label: 'Regional-Energy-evn', script: 'seed-regional-energy-evn.mjs', seedMetaKey: 'energy:regional-evn', canonicalKey: 'energy:regional:evn:v1', completionMetaKey: 'seed-completion:energy:regional-evn', expectedSourceVersion: 'regional-energy-evn-v1', intervalMs: 21600000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-korem', script: 'seed-regional-energy-korem.mjs', seedMetaKey: 'energy:regional-korem', canonicalKey: 'energy:regional:korem:v1', completionMetaKey: 'seed-completion:energy:regional-korem', expectedSourceVersion: 'regional-energy-korem-v1', intervalMs: 21600000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-coes', script: 'seed-regional-energy-coes.mjs', seedMetaKey: 'energy:regional-coes', canonicalKey: 'energy:regional:coes:v1', completionMetaKey: 'seed-completion:energy:regional-coes', expectedSourceVersion: 'regional-energy-coes-v1', intervalMs: 3600000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-iccc', script: 'seed-regional-energy-iccc.mjs', seedMetaKey: 'energy:regional-iccc', canonicalKey: 'energy:regional:iccc:v1', completionMetaKey: 'seed-completion:energy:regional-iccc', expectedSourceVersion: 'regional-energy-iccc-v1', intervalMs: 43200000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-fccc', script: 'seed-regional-energy-fccc.mjs', seedMetaKey: 'energy:regional-fccc', canonicalKey: 'energy:regional:fccc:v1', completionMetaKey: 'seed-completion:energy:regional-fccc', expectedSourceVersion: 'regional-energy-fccc-v1', intervalMs: 43200000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-mem', script: 'seed-regional-energy-mem.mjs', seedMetaKey: 'energy:regional-mem', canonicalKey: 'energy:regional:mem:v1', completionMetaKey: 'seed-completion:energy:regional-mem', expectedSourceVersion: 'regional-energy-mem-v1', intervalMs: 43200000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-qatarenergy', script: 'seed-regional-energy-qatarenergy.mjs', seedMetaKey: 'energy:regional-qatarenergy', canonicalKey: 'energy:regional:qatarenergy:v1', completionMetaKey: 'seed-completion:energy:regional-qatarenergy', expectedSourceVersion: 'regional-energy-qatarenergy-v1', intervalMs: 43200000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-erb', script: 'seed-regional-energy-erb.mjs', seedMetaKey: 'energy:regional-erb', canonicalKey: 'energy:regional:erb:v1', completionMetaKey: 'seed-completion:energy:regional-erb', expectedSourceVersion: 'regional-energy-erb-v1', intervalMs: 43200000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-npa', script: 'seed-regional-energy-npa.mjs', seedMetaKey: 'energy:regional-npa', canonicalKey: 'energy:regional:npa:v1', completionMetaKey: 'seed-completion:energy:regional-npa', expectedSourceVersion: 'regional-energy-npa-v1', intervalMs: 43200000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-sonabhy', script: 'seed-regional-energy-sonabhy.mjs', seedMetaKey: 'energy:regional-sonabhy', canonicalKey: 'energy:regional:sonabhy:v1', completionMetaKey: 'seed-completion:energy:regional-sonabhy', expectedSourceVersion: 'regional-energy-sonabhy-v1', intervalMs: 86400000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-zera', script: 'seed-regional-energy-zera.mjs', seedMetaKey: 'energy:regional-zera', canonicalKey: 'energy:regional:zera:v1', completionMetaKey: 'seed-completion:energy:regional-zera', expectedSourceVersion: 'regional-energy-zera-v1', intervalMs: 43200000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-doe', script: 'seed-regional-energy-doe.mjs', seedMetaKey: 'energy:regional-doe', canonicalKey: 'energy:regional:doe:v1', completionMetaKey: 'seed-completion:energy:regional-doe', expectedSourceVersion: 'regional-energy-doe-v1', intervalMs: 43200000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-anptl', script: 'seed-regional-energy-anptl.mjs', seedMetaKey: 'energy:regional-anptl', canonicalKey: 'energy:regional:anptl:v1', completionMetaKey: 'seed-completion:energy:regional-anptl', expectedSourceVersion: 'regional-energy-anptl-v1', intervalMs: 86400000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-creg', script: 'seed-regional-energy-creg.mjs', seedMetaKey: 'energy:regional-creg', canonicalKey: 'energy:regional:creg:v1', completionMetaKey: 'seed-completion:energy:regional-creg', expectedSourceVersion: 'regional-energy-creg-v1', intervalMs: 43200000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-ursea', script: 'seed-regional-energy-ursea.mjs', seedMetaKey: 'energy:regional-ursea', canonicalKey: 'energy:regional:ursea:v1', completionMetaKey: 'seed-completion:energy:regional-ursea', expectedSourceVersion: 'regional-energy-ursea-v1', intervalMs: 43200000, timeoutMs: 120_000 },
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
