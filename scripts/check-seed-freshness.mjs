#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

const DEFAULT_HEALTH_URL = 'https://api.worldmonitor.app/api/health?compact=1';

export function validateCompactHealthPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Compact health payload must be an object');
  }
  // Compact health omits `problems` entirely when every check is healthy.
  if (payload.problems == null && payload.status === 'HEALTHY') return payload;
  if (!payload.problems || typeof payload.problems !== 'object' || Array.isArray(payload.problems)) {
    throw new Error('Compact health payload must contain a problems object');
  }
  return payload;
}

export function findStaleSeedProblems(payload) {
  validateCompactHealthPayload(payload);
  return Object.entries(payload.problems ?? {})
    .filter(([, problem]) => problem?.status === 'STALE_SEED')
    .map(([name, problem]) => ({
      name,
      seedAgeMin: problem.seedAgeMin,
      maxStaleMin: problem.maxStaleMin,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isOnDemandProblem(problem) {
  return typeof problem?.status === 'string'
    && problem.status.endsWith('_ON_DEMAND');
}

export function findOperationalProblems(payload) {
  validateCompactHealthPayload(payload);
  return Object.entries(payload.problems ?? {})
    .filter(([, problem]) => !isOnDemandProblem(problem))
    .map(([name, problem]) => ({
      name,
      status: problem?.status ?? 'UNKNOWN',
      records: problem?.records,
      ...(Number.isFinite(problem?.seedAgeMin)
        ? { seedAgeMin: problem.seedAgeMin }
        : {}),
      ...(Number.isFinite(problem?.maxStaleMin)
        ? { maxStaleMin: problem.maxStaleMin }
        : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const healthUrl = process.env.HEALTH_URL || DEFAULT_HEALTH_URL;
  const response = await fetch(healthUrl, {
    headers: { 'User-Agent': 'worldmonitor-seed-freshness-monitor/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Compact health request failed: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const operationalProblems = findOperationalProblems(payload);
  if (operationalProblems.length === 0) {
    console.log(`Ingestion operational acceptance passed at ${payload.checkedAt || 'unknown time'}: no actionable health problems.`);
    return;
  }

  console.error(`Ingestion operational acceptance failed: ${operationalProblems.length} actionable problem(s).`);
  for (const problem of operationalProblems) {
    const freshness = Number.isFinite(problem.seedAgeMin)
      ? ` age=${problem.seedAgeMin}m max=${problem.maxStaleMin ?? 'unknown'}m`
      : '';
    console.error(
      `- ${problem.name}: status=${problem.status} records=${problem.records ?? 'unknown'}${freshness}`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
