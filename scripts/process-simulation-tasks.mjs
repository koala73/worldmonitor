#!/usr/bin/env node

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
