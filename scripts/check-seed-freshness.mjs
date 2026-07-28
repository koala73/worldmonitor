#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_HEALTH_URL = 'https://api.worldmonitor.app/api/health?compact=1';
const BASELINE_URL = new URL('./seed-freshness-baseline.json', import.meta.url);

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

// On-demand sources are informational: they are RPC-populated or
// deployment-order bridges, so staleness is expected rather than an ingestion
// fault. `/api/health` marks them with `onDemand: true` on every status
// (api/health.js classifyKey). The status-suffix test is retained only as a
// fallback for compact snapshots cached before that marker shipped — on its own
// it is not sufficient, because `EMPTY_ON_DEMAND` is the ONLY `_ON_DEMAND`
// status and it covers just the absent/zero-record branches: an on-demand key
// that has data and goes stale is plain `STALE_SEED`, and chinaCoverage
// degrades to `CHINA_DEGRADED`.
export function isOnDemandProblem(problem) {
  if (problem?.onDemand === true) return true;
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

export function validateAcceptanceBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('Acceptance baseline must be an object');
  }
  if (typeof baseline.expiresAt !== 'string' || Number.isNaN(Date.parse(baseline.expiresAt))) {
    throw new Error('Acceptance baseline must carry an ISO expiresAt date');
  }
  if (!Array.isArray(baseline.acknowledged)) {
    throw new Error('Acceptance baseline must contain an acknowledged array');
  }
  for (const entry of baseline.acknowledged) {
    if (!entry?.name || !entry?.status) {
      throw new Error('Each acknowledged baseline entry needs name and status');
    }
    if (!Number.isInteger(entry.issue)) {
      throw new Error(`Acknowledged baseline entry ${entry.name} needs an owner issue number`);
    }
  }
  return baseline;
}

/**
 * Split live problems against the acknowledged baseline.
 *
 * `blocking` fails the gate. `acknowledged` is a known-degraded source with an
 * owner issue, reported but not fatal. `cleared` is a baseline entry that no
 * longer appears in health — reported as a prompt to prune, but deliberately
 * NOT fatal, because several of these sources flap between polls and a
 * clear-on-recovery failure would make the monitor red on exactly the runs that
 * prove things improved. `expiresAt` is the anti-rot mechanism instead: the
 * whole baseline must be re-reviewed on a date, or the gate fails.
 */
export function applyAcceptanceBaseline(problems, baseline, now = Date.now()) {
  validateAcceptanceBaseline(baseline);
  const accepted = new Map(
    baseline.acknowledged.map((entry) => [`${entry.name}:${entry.status}`, entry]),
  );
  const seen = new Set();
  const blocking = [];
  const acknowledged = [];
  for (const problem of problems) {
    const key = `${problem.name}:${problem.status}`;
    const entry = accepted.get(key);
    if (entry) {
      seen.add(key);
      acknowledged.push({ ...problem, issue: entry.issue });
    } else {
      blocking.push(problem);
    }
  }
  const cleared = baseline.acknowledged
    .filter((entry) => !seen.has(`${entry.name}:${entry.status}`))
    .map((entry) => ({ name: entry.name, status: entry.status, issue: entry.issue }));
  const expired = Date.parse(baseline.expiresAt) < now;
  return { blocking, acknowledged, cleared, expired, expiresAt: baseline.expiresAt };
}

function readAcceptanceBaseline() {
  return JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
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
  const { blocking, acknowledged, cleared, expired, expiresAt } =
    applyAcceptanceBaseline(operationalProblems, readAcceptanceBaseline());

  const describe = (problem) => {
    const freshness = Number.isFinite(problem.seedAgeMin)
      ? ` age=${problem.seedAgeMin}m max=${problem.maxStaleMin ?? 'unknown'}m`
      : '';
    return `${problem.name}: status=${problem.status} records=${problem.records ?? 'unknown'}${freshness}`;
  };

  for (const problem of acknowledged) {
    console.log(`- acknowledged (#${problem.issue}): ${describe(problem)}`);
  }
  for (const entry of cleared) {
    console.log(
      `- recovered: ${entry.name}:${entry.status} no longer reported; remove it from scripts/seed-freshness-baseline.json (#${entry.issue}).`,
    );
  }

  if (expired) {
    console.error(
      `Ingestion operational acceptance failed: the accepted-problem baseline expired on ${expiresAt}. Re-review scripts/seed-freshness-baseline.json and set a new expiresAt.`,
    );
    process.exitCode = 1;
    return;
  }

  if (blocking.length === 0) {
    console.log(
      `Ingestion operational acceptance passed at ${payload.checkedAt || 'unknown time'}: no unacknowledged health problems (${acknowledged.length} acknowledged).`,
    );
    return;
  }

  console.error(`Ingestion operational acceptance failed: ${blocking.length} unacknowledged problem(s).`);
  for (const problem of blocking) {
    console.error(`- ${describe(problem)}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
