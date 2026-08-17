#!/usr/bin/env node

import { loadEnvFile } from './_seed-utils.mjs';
import { runDeepForecastWorker } from './seed-forecasts.mjs';

loadEnvFile(import.meta.url);

const once = process.argv.includes('--once');
const runId = process.argv.find((arg) => arg.startsWith('--run-id='))?.split('=')[1] || '';

const __runStartedAt = Date.now();

try {
  console.log(`[DeepForecast] Starting (once=${once}, pid=${process.pid})`);
  const result = await runDeepForecastWorker({ once, runId });
  console.log(`[DeepForecast] Exiting: ${result?.status || 'unknown'}`);
  // Terminal success marker — see scripts/_seed-utils.mjs runSeed(). `[DeepForecast] Exiting:` is
  // this worker's own last line, but the crash diagnostic deliberately keeps ONE small closed set
  // of clean-finish markers rather than learning a per-entry-point vocabulary, so emit the shared
  // one. Last statement of the try, so a throw above skips it.
  console.log(`\n=== Done (${Date.now() - __runStartedAt}ms) ===`);
} catch (err) {
  console.error(`[DeepForecast] FATAL: ${err.message}`);
  process.exit(1);
}
