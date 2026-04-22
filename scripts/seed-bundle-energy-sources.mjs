#!/usr/bin/env node
import { runBundle, DAY } from './_bundle-runner.mjs';

await runBundle('energy-sources', [
  { label: 'GIE-Gas-Storage', script: 'seed-gie-gas-storage.mjs', seedMetaKey: 'economic:eu-gas-storage', canonicalKey: 'economic:eu-gas-storage:v1', intervalMs: DAY, timeoutMs: 180_000 },
  { label: 'Gas-Storage-Countries', script: 'seed-gas-storage-countries.mjs', seedMetaKey: 'energy:gas-storage-countries', intervalMs: DAY, timeoutMs: 600_000 },
  { label: 'JODI-Gas', script: 'seed-jodi-gas.mjs', seedMetaKey: 'energy:jodi-gas', canonicalKey: 'energy:jodi-gas:v1:_countries', intervalMs: 35 * DAY, timeoutMs: 600_000 },
  { label: 'JODI-Oil', script: 'seed-jodi-oil.mjs', seedMetaKey: 'energy:jodi-oil', canonicalKey: 'energy:jodi-oil:v1:_countries', intervalMs: 35 * DAY, timeoutMs: 600_000 },
  { label: 'OWID-Energy-Mix', script: 'seed-owid-energy-mix.mjs', seedMetaKey: 'economic:owid-energy-mix', intervalMs: 35 * DAY, timeoutMs: 600_000 },
  { label: 'IEA-Oil-Stocks', script: 'seed-iea-oil-stocks.mjs', seedMetaKey: 'energy:iea-oil-stocks', canonicalKey: 'energy:iea-oil-stocks:v1:index', intervalMs: 40 * DAY, timeoutMs: 300_000 },
  { label: 'EIA-Petroleum', script: 'seed-eia-petroleum.mjs', seedMetaKey: 'energy:eia-petroleum', canonicalKey: 'energy:eia-petroleum:v1', intervalMs: DAY, timeoutMs: 90_000 },
  { label: 'IEA-Crisis-Policies', script: 'seed-energy-crisis-policies.mjs', seedMetaKey: 'energy:crisis-policies', canonicalKey: 'energy:crisis-policies:v1', intervalMs: 7 * DAY, timeoutMs: 120_000 },
  // SPR-Policies: static registry (data lives in scripts/data/spr-policies.json), TTL 400d
  // in api/health.js (maxStaleMin: 576000). Weekly cadence is generous — only needs to run
  // once after deploys + restarts to populate energy:spr-policies:v1. No prior Railway
  // service exists for it, so health has been EMPTY (seedAgeMin: null) since the seeder
  // was added.
  { label: 'SPR-Policies', script: 'seed-spr-policies.mjs', seedMetaKey: 'energy:spr-policies', canonicalKey: 'energy:spr-policies:v1', intervalMs: 7 * DAY, timeoutMs: 60_000 },
  // Pipeline registries (gas + oil) — two separate scripts because runSeed()
  // hard-exits its terminal paths (process.exit in _seed-utils at ~9 sites),
  // so two runSeed() calls in one process would leave the second key
  // unwritten. Shared helpers live in scripts/_pipeline-registry.mjs; curated
  // data in scripts/data/pipelines-{gas,oil}.json.
  { label: 'Pipelines-Gas', script: 'seed-pipelines-gas.mjs', seedMetaKey: 'energy:pipelines-gas', canonicalKey: 'energy:pipelines:gas:v1', intervalMs: 7 * DAY, timeoutMs: 60_000 },
  { label: 'Pipelines-Oil', script: 'seed-pipelines-oil.mjs', seedMetaKey: 'energy:pipelines-oil', canonicalKey: 'energy:pipelines:oil:v1', intervalMs: 7 * DAY, timeoutMs: 60_000 },
  // Storage facilities registry (UGS + SPR + LNG + crude hubs). Curated JSON
  // at scripts/data/storage-facilities.json; shared helpers in
  // scripts/_storage-facility-registry.mjs. Weekly cadence — registry is
  // near-static; badge derivation happens at read-time in the RPC handler.
  { label: 'Storage-Facilities', script: 'seed-storage-facilities.mjs', seedMetaKey: 'energy:storage-facilities', canonicalKey: 'energy:storage-facilities:v1', intervalMs: 7 * DAY, timeoutMs: 60_000 },
  // Fuel-shortage registry (v1 curated seed — classifier extends post-launch).
  // Daily cadence because shortages move faster than registry assets.
  { label: 'Fuel-Shortages', script: 'seed-fuel-shortages.mjs', seedMetaKey: 'energy:fuel-shortages', canonicalKey: 'energy:fuel-shortages:v1', intervalMs: DAY, timeoutMs: 60_000 },
  // Energy disruption event log — state-machine history of pipeline/storage
  // outages (sabotage, sanction, maintenance, etc.). Feeds the timeline in
  // PipelineStatusPanel and StorageFacilityMapPanel drawers. Weekly cadence
  // because curated events are mostly historical; classifier extends daily
  // post-launch.
  { label: 'Energy-Disruptions', script: 'seed-energy-disruptions.mjs', seedMetaKey: 'energy:disruptions', canonicalKey: 'energy:disruptions:v1', intervalMs: 7 * DAY, timeoutMs: 60_000 },
]);
