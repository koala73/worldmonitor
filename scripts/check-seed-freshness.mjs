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
  const staleSeeds = findStaleSeedProblems(payload);
  if (staleSeeds.length === 0) {
    console.log(`Seed freshness healthy at ${payload.checkedAt || 'unknown time'}: no STALE_SEED problems.`);
    return;
  }

  console.error(`Seed freshness alert: ${staleSeeds.length} seed(s) exceeded maxStaleMin.`);
  for (const seed of staleSeeds) {
    console.error(`- ${seed.name}: age=${seed.seedAgeMin}m max=${seed.maxStaleMin}m`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
