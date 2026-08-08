#!/usr/bin/env node
import { runBundle, DAY } from './_bundle-runner.mjs';

await runBundle('resilience-recovery', [
  { label: 'Fiscal-Space', script: 'seed-recovery-fiscal-space.mjs', seedMetaKey: 'resilience:recovery:fiscal-space', canonicalKey: 'resilience:recovery:fiscal-space:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'Reserve-Adequacy', script: 'seed-recovery-reserve-adequacy.mjs', seedMetaKey: 'resilience:recovery:reserve-adequacy', canonicalKey: 'resilience:recovery:reserve-adequacy:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'External-Debt', script: 'seed-recovery-external-debt.mjs', seedMetaKey: 'resilience:recovery:external-debt', canonicalKey: 'resilience:recovery:external-debt:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'Import-HHI', script: 'seed-recovery-import-hhi.mjs', seedMetaKey: 'resilience:recovery:import-hhi', canonicalKey: 'resilience:recovery:import-hhi:v1', intervalMs: 30 * DAY, timeoutMs: 1_800_000 },
  { label: 'Fuel-Stocks', script: 'seed-recovery-fuel-stocks.mjs', seedMetaKey: 'resilience:recovery:fuel-stocks', canonicalKey: 'resilience:recovery:fuel-stocks:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  // PR 2 §3.4 — feeds the forthcoming `sovereignFiscalBuffer` dimension.
  // 30-day interval matches the CACHE_TTL_SECONDS (35 days) in the seeder
  // and the quarterly revision cadence documented in the manifest. Longer
  // timeout than peers because Tier 3b (per-fund Wikipedia infobox) is N
  // network round-trips per manifest fund the list article misses.
  // Re-export share is read by the SWF seeder to convert gross annual
  // imports into NET annual imports before computing rawMonths. Must
  // run BEFORE Sovereign-Wealth so the SWF seeder sees the freshly-
  // published reexport-share key. Timeout 300s (5 min): the seeder
  // fetches Comtrade RX + M per cohort member with 750ms inter-call
  // pacing + retry-on-429; a 2-country cohort averages 10-15s but a
  // rate-limited retry storm can extend to 2-3 min.
  { label: 'Reexport-Share', script: 'seed-recovery-reexport-share.mjs', seedMetaKey: 'resilience:recovery:reexport-share', canonicalKey: 'resilience:recovery:reexport-share:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  // `dependsOn: ['Reexport-Share']` makes the ordering contract explicit
  // and enforced by `_bundle-runner.mjs` (throws on violation). The SWF
  // seeder reads the Reexport-Share Redis key inside the same bundle
  // run; a future edit that reorders these sections would otherwise
  // silently corrupt the net-imports denominator.
  { label: 'Sovereign-Wealth', script: 'seed-sovereign-wealth.mjs', seedMetaKey: 'resilience:recovery:sovereign-wealth', canonicalKey: 'resilience:recovery:sovereign-wealth:v1', intervalMs: 30 * DAY, timeoutMs: 600_000, dependsOn: ['Reexport-Share'] },
]);
