#!/usr/bin/env node
import { runBundle, DAY } from './_bundle-runner.mjs';

await runBundle('resilience-recovery', [
  { label: 'Fiscal-Space', script: 'seed-recovery-fiscal-space.mjs', seedMetaKey: 'resilience:recovery:fiscal-space', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'Reserve-Adequacy', script: 'seed-recovery-reserve-adequacy.mjs', seedMetaKey: 'resilience:recovery:reserve-adequacy', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'External-Debt', script: 'seed-recovery-external-debt.mjs', seedMetaKey: 'resilience:recovery:external-debt', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'Import-HHI', script: 'seed-recovery-import-hhi.mjs', seedMetaKey: 'resilience:recovery:import-hhi', intervalMs: 30 * DAY, timeoutMs: 1_800_000 },
  { label: 'Fuel-Stocks', script: 'seed-recovery-fuel-stocks.mjs', seedMetaKey: 'resilience:recovery:fuel-stocks', intervalMs: 30 * DAY, timeoutMs: 300_000 },
]);
