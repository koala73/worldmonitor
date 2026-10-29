#!/usr/bin/env node
import { runBundle } from './_bundle-runner.mjs';

// Four 130s reservations plus 20s preflight leave 30s below the 570s budget.
await runBundle('regional-energy-reports', [
  { label: 'Regional-Energy-petrobangla', script: 'seed-regional-energy-petrobangla.mjs', seedMetaKey: 'energy:regional-petrobangla', canonicalKey: 'energy:regional:petrobangla:v1', completionMetaKey: 'seed-completion:energy:regional-petrobangla', expectedSourceVersion: 'regional-energy-petrobangla-v1', intervalMs: 86400000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-eskom', script: 'seed-regional-energy-eskom.mjs', seedMetaKey: 'energy:regional-eskom', canonicalKey: 'energy:regional:eskom:v1', completionMetaKey: 'seed-completion:energy:regional-eskom', expectedSourceVersion: 'regional-energy-eskom-v1', intervalMs: 86400000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-gse', script: 'seed-regional-energy-gse.mjs', seedMetaKey: 'energy:regional-gse', canonicalKey: 'energy:regional:gse:v1', completionMetaKey: 'seed-completion:energy:regional-gse', expectedSourceVersion: 'regional-energy-gse-v1', intervalMs: 86400000, timeoutMs: 120_000 },
  { label: 'Regional-Energy-anp', script: 'seed-regional-energy-anp.mjs', seedMetaKey: 'energy:regional-anp', canonicalKey: 'energy:regional:anp:v1', completionMetaKey: 'seed-completion:energy:regional-anp', expectedSourceVersion: 'regional-energy-anp-v1', intervalMs: 86400000, timeoutMs: 120_000 },
], { maxBundleMs: 570_000, prefetchFreshness: true });
