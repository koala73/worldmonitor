#!/usr/bin/env node
//
// Railway entrypoint for the simulation worker.
//
// Usage:
//   node scripts/process-simulation-tasks.mjs            # poll loop (default)
//   node scripts/process-simulation-tasks.mjs --once     # process one task and exit
//   node scripts/process-simulation-tasks.mjs --once --run-id=<id>
//
// Operator notes (#3734):
//   - `--run-id=<id>` MUST match the runId regex `/^\d{13,}-[a-z0-9-]{1,64}$/i`
//     (epoch_ms-suffix). Invalid IDs are SILENTLY skipped by the worker —
//     check logs for "Skipping invalid runId format" if a run appears not to
//     have happened. The worker exits cleanly (status='idle') in that case,
//     which can look like success at the shell level.
//   - Force-reprocess via `--run-id=<id>` overwrites BOTH the `:latest` Redis
//     pointer AND the `:by-run:<id>` retention key. The by-run write has no
//     NX flag, so re-runs replace any prior outcome and reset the 24h TTL.
//     CDN cache (5-min browser / 30-min CDN per gateway 'slow' tier on the
//     GET endpoint) may serve the old outcome for up to 30 min after a
//     force-reprocess — see docs/plans/2026-05-18-003-...md D6.

import { loadEnvFile } from './_seed-utils.mjs';
import { runSimulationWorker } from './seed-forecasts.mjs';

loadEnvFile(import.meta.url);

const once = process.argv.includes('--once');
const runId = process.argv.find((arg) => arg.startsWith('--run-id='))?.split('=')[1] || '';

try {
  console.log(`[Simulation] Starting (once=${once}, pid=${process.pid})`);
  const result = await runSimulationWorker({ once, runId });
  console.log(`[Simulation] Exiting: ${result?.status || 'unknown'}`);
} catch (err) {
  console.error(`[Simulation] FATAL: ${err.message}`);
  process.exit(1);
}
