#!/usr/bin/env node

import { loadEnvFile } from './_seed-utils.mjs';
import {
  evaluateChinaCoverage,
  formatChinaCoverageHuman,
  readChinaCoverageInputs,
} from './china-coverage-health.mjs';

loadEnvFile(import.meta.url);

const json = process.argv.includes('--json');
const strict = process.argv.includes('--strict');

try {
  const inputs = await readChinaCoverageInputs();
  const summary = evaluateChinaCoverage(inputs);
  process.stdout.write(`${json ? JSON.stringify(summary) : formatChinaCoverageHuman(summary)}\n`);
  if (strict && summary.status !== 'healthy') process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (json) process.stdout.write(`${JSON.stringify({ status: 'error', error: message })}\n`);
  else console.error(`China coverage audit failed: ${message}`);
  process.exitCode = 1;
}
