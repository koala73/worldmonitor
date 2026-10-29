#!/usr/bin/env node
import { runBundle } from './_bundle-runner.mjs';

// Four 130s reservations plus 20s preflight leave 30s below the 570s budget.
await runBundle('regional-energy-grid', [
  { label: 'Regional-Energy-pgcb', script: 'seed-regional-energy-pgcb.mjs', seedMetaKey: 'energy:regional-pgcb', canonicalKey: 'energy:regional:pgcb:v1', completionMetaKey: 'seed-completion:energy:regional-pgcb', expectedSourceVersion: 'regional-energy-pgcb-v1', intervalMs: 3600000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-niso', script: 'seed-regional-energy-niso.mjs', seedMetaKey: 'energy:regional-niso', canonicalKey: 'energy:regional:niso:v1', completionMetaKey: 'seed-completion:energy:regional-niso', expectedSourceVersion: 'regional-energy-niso-v1', intervalMs: 21600000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-cammesa', script: 'seed-regional-energy-cammesa.mjs', seedMetaKey: 'energy:regional-cammesa', canonicalKey: 'energy:regional:cammesa:v1', completionMetaKey: 'seed-completion:energy:regional-cammesa', expectedSourceVersion: 'regional-energy-cammesa-v1', intervalMs: 3600000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-ons', script: 'seed-regional-energy-ons.mjs', seedMetaKey: 'energy:regional-ons', canonicalKey: 'energy:regional:ons:v1', completionMetaKey: 'seed-completion:energy:regional-ons', expectedSourceVersion: 'regional-energy-ons-v1', intervalMs: 43200000, timeoutMs: 120_000 },
], { maxBundleMs: 570_000, prefetchFreshness: true });
