#!/usr/bin/env node

import { loadEnvFile } from './_seed-utils.mjs';
import { runSimulationWorker } from './seed-forecasts.mjs';

loadEnvFile(import.meta.url);

const once = process.argv.includes('--once');
const runId = process.argv.find((arg) => arg.startsWith('--run-id='))?.split('=')[1] || '';

const result = await runSimulationWorker({ once, runId });
if (once && result?.status && result.status !== 'idle') {
  console.log(`  [Simulation] ${result.status}`);
}
