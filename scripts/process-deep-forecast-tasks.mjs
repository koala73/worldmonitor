#!/usr/bin/env node

import { loadEnvFile } from './_seed-utils.mjs';
import { runDeepForecastWorker } from './seed-forecasts.mjs';

loadEnvFile(import.meta.url);

const once = process.argv.includes('--once');

const result = await runDeepForecastWorker({ once });
if (once && result?.status && result.status !== 'idle') {
  console.log(`  [DeepForecast] ${result.status}`);
}
