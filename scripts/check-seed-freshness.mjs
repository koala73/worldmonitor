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

// The ONLY states being on-demand actually explains: nothing has requested the
// key yet, or the producer has not run for the first time. Absence is expected
// for an RPC-populated cache or a deployment-order bridge, so it must not page.
//
// Everything else must stay strict even for an on-demand source. `SEED_ERROR`
// means the producer ran and failed; a long `STALE_SEED` means it stopped
// running. Neither is explained by "nobody asked for it yet", and softening
// them is a known-bad trade: api/health.js's ON_DEMAND_KEYS policy block
// records `marketImplications` sitting at 8.2x its staleness budget for 16+
// hours undetected for exactly this reason, which is why that key was removed
// from the set. Do not widen this list to cover fault statuses — a genuinely
// accepted degradation belongs in seed-freshness-baseline.json, where it
// carries an owner issue and an expiry.
const ON_DEMAND_SOFT_STATUSES = new Set(['EMPTY_ON_DEMAND', 'EMPTY', 'EMPTY_DATA']);

// `/api/health` marks on-demand sources with `onDemand: true` on every status
// (api/health.js classifyKey). The status-suffix test is retained as a fallback
// for compact snapshots cached before that marker shipped, and is self-limiting:
// `EMPTY_ON_DEMAND` is the only `_ON_DEMAND` status, so it covers only the
// absent/zero-record branches — the same set the marker path allows.
export function isOnDemandProblem(problem) {
  if (typeof problem?.status === 'string' && problem.status.endsWith('_ON_DEMAND')) return true;
  return problem?.onDemand === true && ON_DEMAND_SOFT_STATUSES.has(problem?.status);
}

// #6059 — a schema whose producer has not reached its first scheduled run yet.
// Softened for the SAME reason as on-demand (absence is explained, not a
// fault), but on strictly tighter terms: /api/health emits the deadline it
// compiled into the payload, and this gate re-checks it against the wall clock
// rather than trusting the status string. So it fails CLOSED three ways —
// a missing/unparseable deadline, an already-expired one, and a compact
// snapshot cached from before the deadline all report the problem normally.
// That is why this does not need a baseline entry with an owner and expiry:
// the expiry is in the payload and this function enforces it.
// One complete daily scrape/aggregate/publish window, the longest rollout the
// health registry is allowed to declare. Bounding it HERE too is deliberate
// defence in depth: this gate consumes a payload over the network, so it must
// not accept an arbitrarily distant deadline as a licence to stay quiet. Without
// this, a single bad `rolloutPendingUntil` — a registry bug, a bad merge, a
// tampered response — would silence these keys in CI effectively forever.
const MAX_ROLLOUT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isRolloutPendingProblem(problem, now = Date.now()) {
  if (problem?.status !== 'ROLLOUT_PENDING') return false;
  const until = Date.parse(problem?.rolloutPendingUntil ?? '');
  if (!Number.isFinite(until)) return false;
  if (until - now > MAX_ROLLOUT_WINDOW_MS) return false;
  return now < until;
}

export function findOperationalProblems(payload, now = Date.now()) {
  validateCompactHealthPayload(payload);
  return Object.entries(payload.problems ?? {})
    .filter(([, problem]) => !isOnDemandProblem(problem) && !isRolloutPendingProblem(problem, now))
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
 *
 * The expiry governs SUPPRESSIONS, so a baseline that acknowledges nothing
 * cannot expire — there is no suppression left to outlive its cause, and a
 * date-triggered failure over an empty list is a red monitor with nothing to
 * review. That case is reachable: pruning the last recovered entry empties the
 * file, and this repository has already watched a permanently-red monitor hide
 * live drift (#6087).
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
  const expired = baseline.acknowledged.length > 0 && Date.parse(baseline.expiresAt) < now;
  return { blocking, acknowledged, cleared, expired, expiresAt: baseline.expiresAt };
}

function readAcceptanceBaseline() {
  return JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
}

function describeProblem(problem) {
  const freshness = Number.isFinite(problem.seedAgeMin)
    ? ` age=${problem.seedAgeMin}m max=${problem.maxStaleMin ?? 'unknown'}m`
    : '';
  return `${problem.name}: status=${problem.status} records=${problem.records ?? 'unknown'}${freshness}`;
}

/**
 * Pure renderer for one acceptance run. Kept separate from main() so the
 * ORDER of the report is testable without a network round trip — the bug this
 * shape closes was an early `return` on expiry that suppressed the blocking
 * list, and no assertion over the pure split functions could have seen it.
 */
export function formatAcceptanceReport(
  { blocking, acknowledged, cleared, expired, expiresAt },
  checkedAt,
) {
  const info = [
    ...acknowledged.map((problem) => `- acknowledged (#${problem.issue}): ${describeProblem(problem)}`),
    ...cleared.map((entry) =>
      `- recovered: ${entry.name}:${entry.status} no longer reported; remove it from scripts/seed-freshness-baseline.json (#${entry.issue}).`),
  ];
  const errors = [];

  // The actionable list comes BEFORE any terminal condition. Expiry is the run
  // where an operator most needs to see what is actually broken.
  if (blocking.length > 0) {
    errors.push(`Ingestion operational acceptance failed: ${blocking.length} unacknowledged problem(s).`);
    errors.push(...blocking.map((problem) => `- ${describeProblem(problem)}`));
  }
  if (expired) {
    errors.push(
      `Ingestion operational acceptance failed: the accepted-problem baseline expired on ${expiresAt}. Re-review scripts/seed-freshness-baseline.json and set a new expiresAt.`,
    );
  }
  if (errors.length === 0) {
    info.push(
      `Ingestion operational acceptance passed at ${checkedAt || 'unknown time'}: no unacknowledged health problems (${acknowledged.length} acknowledged).`,
    );
  }
  return { info, errors, failed: errors.length > 0 };
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
  const report = formatAcceptanceReport(
    applyAcceptanceBaseline(findOperationalProblems(payload), readAcceptanceBaseline()),
    payload.checkedAt,
  );
  for (const line of report.info) console.log(line);
  for (const line of report.errors) console.error(line);
  if (report.failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
