#!/usr/bin/env node

// How long has anything actually reconciled the Railway fleet? (#6203)
//
// WHY THIS EXISTS
//
// .github/workflows/railway-deploy-trigger.yml has two outcomes that are
// indistinguishable at the workflow-status level:
//
//   - it read main's head, found the gate green, and deployed every service
//     that was behind; and
//   - it read main's head, found the gate not-yet-green, skipped every step
//     that does work, and concluded `success`.
//
// Measured on 2026-08-05: over 2h03m the workflow produced ONE scheduled run,
// and that run took the second branch. Meanwhile 10 services sat on b7f2054df
// for ~19.5h. Nothing anywhere went red.
//
// The workflow's existing escalation asks "how long has main's gate been
// pending", which only fires ON A RUN — the precondition that failed. This
// asks the question that does not depend on why: when did a run last actually
// reconcile? The answer comes from the workflow's own run history, because a
// run that reconciled and a run that declined differ only in whether the
// deploying STEP ran.
//
// DIRECTION OF FAILURE
//
// Every case where the record is missing, unreadable, ambiguous or truncated
// resolves away from "healthy". A scanner whose unmatched case means HEALTHY
// is the same defect in a new place.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { REPOSITORY, readArgument } from './railway-cli.mjs';

// The step whose conclusion IS the signal. A run reconciled iff this step ran
// and succeeded; `skipped` is the #6203 transcript verbatim.
//
// tests/railway-reconcile-age.test.mjs pins this string against the workflow,
// because a rename here would make every run read as "did not reconcile" —
// which alarms rather than going quiet, but alarms forever for the wrong
// reason.
export const RECONCILE_STEP_NAME = 'Trigger deploys for services this merge changed';

export const DEFAULT_WORKFLOW_FILE = 'railway-deploy-trigger.yml';

// Sized against the workflow's own backstop, not against a fixture. The cron
// there is hourly and is deliberately the SLOW path — the event trigger is
// what normally reconciles. One missed hour is ordinary (a young head commit
// whose gate has not resolved defers the run on purpose); three consecutive
// hours with nothing reconciling means neither the event nor the backstop is
// working, which is exactly the state that stranded the fleet for 19.5h.
export const DEFAULT_MAX_RECONCILE_AGE_MS = 3 * 60 * 60 * 1000;

// Deep enough that the "we looked far enough back to conclude" branch can
// actually be reached: at the hourly backstop alone this window spans well
// over a day, so a fleet that has not reconciled in three hours is inside it
// many times over.
export const DEFAULT_RUN_LIMIT = 30;

function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Did this run actually reconcile the fleet?
 *
 * Takes the parsed body of `GET /repos/{repo}/actions/runs/{id}/jobs`. Returns
 * a boolean, never a maybe: a payload this cannot read is `false`, so an
 * unrecognised shape trends toward the alarm rather than away from it.
 */
export function readRunReconciled(jobsPayload) {
  const jobs = jobsPayload?.jobs;
  if (!Array.isArray(jobs)) return false;
  for (const job of jobs) {
    const steps = job?.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (step?.name !== RECONCILE_STEP_NAME) continue;
      // `success` only. `skipped` is the declined run this exists to catch, and
      // `failure` is a reconcile that did not happen — it reds its own run, so
      // counting it would let a fleet that is genuinely behind read as fresh.
      if (step?.conclusion === 'success') return true;
    }
  }
  return false;
}

/**
 * Summarise "when did the fleet last get reconciled" from this workflow's runs.
 *
 * `runs` is newest-first, and must be the runs that were actually INSPECTED —
 * callers may stop as soon as they find a reconciled one, because everything
 * older than it cannot change the answer. Passing a truncated tail instead
 * would make the "nothing reconciled" branch below reason about a window it
 * never looked at.
 *
 * Returns one of three states, and `UNKNOWN` is never a pass:
 *
 *   RECENT  — a run reconciled within `maxAgeMs`.
 *   STALE   — a run reconciled longer ago than that, OR nothing reconciled
 *             across a window that itself reaches back past `maxAgeMs`.
 *   UNKNOWN — nothing reconciled and the window is too short to conclude.
 */
export function summarizeReconcileHistory(runs, { now, maxAgeMs = DEFAULT_MAX_RECONCILE_AGE_MS } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('summarizeReconcileHistory requires a numeric now');
  const inspected = Array.isArray(runs) ? runs : [];
  const timestamps = [];

  for (const run of inspected) {
    const completedAt = parseTimestamp(run?.completedAt);
    if (completedAt === null) continue;
    timestamps.push(completedAt);
    if (run?.reconciled !== true) continue;
    // Runner and API clocks disagree by seconds. A future-dated run must read
    // as "just now", not as a negative age that prints as -0h.
    const ageMs = Math.max(0, now - completedAt);
    return {
      state: ageMs > maxAgeMs ? 'STALE' : 'RECENT',
      ageMs,
      lastReconciledAt: new Date(completedAt).toISOString(),
      runId: run.id ?? null,
      inspected: inspected.length,
      maxAgeMs,
    };
  }

  const oldest = timestamps.length > 0 ? Math.min(...timestamps) : null;
  // Only claim staleness once the window we looked at genuinely spans the
  // threshold. Short of that we have not disproved a reconcile, we have just
  // run out of history — which is a different sentence and a different action.
  const reachesPastThreshold = oldest !== null && now - oldest > maxAgeMs;
  return {
    state: reachesPastThreshold ? 'STALE' : 'UNKNOWN',
    ageMs: null,
    lastReconciledAt: null,
    runId: null,
    inspected: inspected.length,
    maxAgeMs,
  };
}

/** Human sentence for a summary, used by the CLI and worth testing as data. */
export function describeReconcileSummary(summary) {
  const hours = (ms) => (ms / (60 * 60 * 1000)).toFixed(1);
  if (summary.state === 'RECENT') {
    return `Fleet last reconciled ${hours(summary.ageMs)}h ago (run ${summary.runId}).`;
  }
  if (summary.state === 'UNKNOWN') {
    return `Cannot tell when the fleet was last reconciled: none of the ${summary.inspected} run(s) inspected reconciled, and that window does not reach back ${hours(summary.maxAgeMs)}h.`;
  }
  if (summary.lastReconciledAt === null) {
    return `The fleet has not been reconciled by any of the last ${summary.inspected} runs, a window reaching back past ${hours(summary.maxAgeMs)}h. Neither the Deploy Gate event nor the hourly backstop is reconciling.`;
  }
  return `The fleet has not been reconciled for ${hours(summary.ageMs)}h (last run ${summary.runId}), past the ${hours(summary.maxAgeMs)}h backstop tolerance.`;
}

const GH_CALL_TIMEOUT_MS = 30_000;

function runGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: GH_CALL_TIMEOUT_MS,
  });
  if (result.signal) throw new Error(`gh ${args.join(' ')} timed out`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${result.status}): ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function readCompletedRuns({ repository, workflowFile, limit, excludeRunId }) {
  const payload = JSON.parse(runGh([
    'api',
    `repos/${repository}/actions/workflows/${workflowFile}/runs?status=completed&per_page=${limit}`,
  ]));
  const runs = payload?.workflow_runs;
  // An unreadable listing must not be summarised as an empty history: empty
  // reads as UNKNOWN, which is quiet, and this is a hard failure.
  if (!Array.isArray(runs)) {
    throw new Error(`the run listing for ${workflowFile} was not an array of workflow runs`);
  }
  return runs
    .filter((run) => String(run?.id) !== String(excludeRunId))
    .map((run) => ({ id: run?.id ?? null, completedAt: run?.updated_at ?? null }));
}

async function main() {
  const repository = readArgument(process.argv, '--repo', process.env.GITHUB_REPOSITORY || REPOSITORY);
  const workflowFile = readArgument(process.argv, '--workflow', DEFAULT_WORKFLOW_FILE);
  const limit = Number(readArgument(process.argv, '--limit', String(DEFAULT_RUN_LIMIT)));
  const maxAgeHours = Number(readArgument(
    process.argv,
    '--max-age-hours',
    String(DEFAULT_MAX_RECONCILE_AGE_MS / (60 * 60 * 1000)),
  ));
  const warnOnly = process.argv.includes('--warn-only');
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error('--limit must be an integer between 1 and 100');
  }
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error('--max-age-hours must be a positive number');
  }

  const candidates = readCompletedRuns({
    repository,
    workflowFile,
    limit,
    excludeRunId: process.env.GITHUB_RUN_ID ?? null,
  });

  // Newest-first, stopping at the first run that reconciled: everything older
  // than it cannot change the answer, so the healthy case costs one extra API
  // call rather than `limit` of them.
  const inspected = [];
  for (const candidate of candidates) {
    const jobs = JSON.parse(runGh(['api', `repos/${repository}/actions/runs/${candidate.id}/jobs`]));
    const reconciled = readRunReconciled(jobs);
    inspected.push({ ...candidate, reconciled });
    if (reconciled) break;
  }

  const summary = summarizeReconcileHistory(inspected, {
    now: Date.now(),
    maxAgeMs: maxAgeHours * 60 * 60 * 1000,
  });
  const message = describeReconcileSummary(summary);

  if (summary.state === 'RECENT') {
    console.log(message);
    return;
  }
  // STALE is the alarm; UNKNOWN is "we could not disprove it", which is louder
  // than silence and quieter than a failure.
  const level = summary.state === 'STALE' && !warnOnly ? 'error' : 'warning';
  console.log(`::${level}::${message}`);
  if (summary.state === 'STALE' && !warnOnly) process.exitCode = 1;
}

// realpath BOTH sides: Node sets import.meta.url to the realpath while argv[1]
// keeps the symlink, so on a symlinked checkout a bare comparison makes this
// script exit 0 having checked nothing.
function isMainModule() {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href
      === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (process.argv[1] && isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
