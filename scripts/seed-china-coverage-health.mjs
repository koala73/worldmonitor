#!/usr/bin/env node

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { CHINA_COVERAGE_ACTIVATION_KEY, CHINA_COVERAGE_SUMMARY_KEY } from './china-coverage-manifest.mjs';
import { evaluateChinaCoverage, readChinaCoverageInputs } from './china-coverage-health.mjs';

loadEnvFile(import.meta.url);

export async function buildChinaCoverageSummary() {
  return evaluateChinaCoverage(await readChinaCoverageInputs());
}

function validate(summary) {
  return summary?.schemaVersion === 1 && summary?.countryCode === 'CN' && Array.isArray(summary?.entries);
}

export function declareRecords(summary) {
  return summary?.counts?.launched ?? 0;
}

export function chinaCoverageActivationCommand(summary) {
  return ['SET', CHINA_COVERAGE_ACTIVATION_KEY, JSON.stringify({ activatedAt: summary.evaluatedAt })];
}

async function markActivated(summary) {
  const credentials = getOptionalUpstashCreds();
  if (!credentials) throw new Error('Redis not configured');
  await upstashCommand(credentials, chinaCoverageActivationCommand(summary));
}

if (process.argv[1]?.endsWith('seed-china-coverage-health.mjs')) {
  runSeed('health', 'china-coverage', CHINA_COVERAGE_SUMMARY_KEY, buildChinaCoverageSummary, {
    validateFn: validate,
    ttlSeconds: 10_800,
    sourceVersion: 'china-coverage-manifest-v1',
    schemaVersion: 1,
    declareRecords,
    maxStaleMin: 180,
    afterPublish: markActivated,
  }).catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
