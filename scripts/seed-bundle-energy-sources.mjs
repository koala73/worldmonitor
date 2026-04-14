#!/usr/bin/env node
import { runBundle, DAY } from './_bundle-runner.mjs';

await runBundle('energy-sources', [
  { label: 'GIE-Gas-Storage', script: 'seed-gie-gas-storage.mjs', seedMetaKey: 'economic:eu-gas-storage', intervalMs: DAY, timeoutMs: 180_000 },
  { label: 'Gas-Storage-Countries', script: 'seed-gas-storage-countries.mjs', seedMetaKey: 'energy:gas-storage-countries', intervalMs: DAY, timeoutMs: 600_000 },
  { label: 'JODI-Gas', script: 'seed-jodi-gas.mjs', seedMetaKey: 'energy:jodi-gas', intervalMs: 35 * DAY, timeoutMs: 600_000 },
  { label: 'JODI-Oil', script: 'seed-jodi-oil.mjs', seedMetaKey: 'energy:jodi-oil', intervalMs: 35 * DAY, timeoutMs: 600_000 },
  { label: 'OWID-Energy-Mix', script: 'seed-owid-energy-mix.mjs', seedMetaKey: 'economic:owid-energy-mix', intervalMs: 35 * DAY, timeoutMs: 600_000 },
  { label: 'IEA-Oil-Stocks', script: 'seed-iea-oil-stocks.mjs', seedMetaKey: 'energy:iea-oil-stocks', intervalMs: 40 * DAY, timeoutMs: 300_000 },
  { label: 'IEA-Crisis-Policies', script: 'seed-energy-crisis-policies.mjs', seedMetaKey: 'energy:crisis-policies', intervalMs: 7 * DAY, timeoutMs: 120_000 },
  // SPR-Policies: static registry (data lives in scripts/data/spr-policies.json), TTL 400d
  // in api/health.js (maxStaleMin: 576000). Weekly cadence is generous — only needs to run
  // once after deploys + restarts to populate energy:spr-policies:v1. No prior Railway
  // service exists for it, so health has been EMPTY (seedAgeMin: null) since the seeder
  // was added.
  { label: 'SPR-Policies', script: 'seed-spr-policies.mjs', seedMetaKey: 'energy:spr-policies', intervalMs: 7 * DAY, timeoutMs: 60_000 },
]);
