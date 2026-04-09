#!/usr/bin/env node

import { loadEnvFile } from './_seed-utils.mjs';
import { runDeepForecastWorker } from './seed-forecasts.mjs';

loadEnvFile(import.meta.url);

const once = process.argv.includes('--once');
const runId = process.argv.find((arg) => arg.startsWith('--run-id='))?.split('=')[1] || '';

try {
  console.log(`[DeepForecast] Starting (once=${once}, pid=${process.pid})`);
  const result = await runDeepForecastWorker({ once, runId });
  console.log(`[DeepForecast] Exiting: ${result?.status || 'unknown'}`);
} catch (err) {
  console.error(`[DeepForecast] FATAL: ${err.message}`);
  process.exit(1);
}
