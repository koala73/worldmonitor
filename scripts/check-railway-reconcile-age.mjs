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
// strict terminal acceptance STEP ran.
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
export const RECONCILE_STEP_NAME = 'Finalize exact Railway reconciliation acceptance';
export const RECONCILE_STEP_NAMES = Object.freeze([
  RECONCILE_STEP_NAME,
  'Trigger deploys for services this merge changed',
]);

export const DEFAULT_WORKFLOW_FILE = 'railway-deploy-trigger.yml';

// Sized against the workflow's own backstop, not against a fixture. The cron
// there is hourly and is deliberately the SLOW path — the event trigger is
// what normally reconciles. One missed hour is ordinary (a young head commit
// whose gate has not resolved defers the run on purpose); three consecutive
// hours with nothing reconciling means neither the event nor the backstop is
// working, which is exactly the state that stranded the fleet for 19.5h.
export const DEFAULT_MAX_RECONCILE_AGE_MS = 3 * 60 * 60 * 1000;

// The listing is bounded by TIME, never by a run count.
//
// A count was the original design and it was unusable: this workflow is woken
// by every Deploy Gate evaluation in the repository — measured at ~33/hour —
// so the newest 30 runs span under an hour and can never reach back past a
// three-hour threshold. STALE became unreachable and the alarm degraded to a
// permanent shrug. A count cannot be raised out of the problem either, because
// the API caps per_page at 100 and 100 runs is still only ~3h at that rate.
//
// With a `created:>=` filter the window spans the threshold BY CONSTRUCTION,
// which also collapses the old three-state result into two: if no run inside
// the window reconciled, that IS the alarm — including the case where the
// workflow did not run at all, which is precisely the #6203 failure and the
// one a count-based window reported as "cannot tell".
export const RUN_PAGE_SIZE = 100;

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
      if (!RECONCILE_STEP_NAMES.includes(step?.name)) continue;
      // `success` only. `skipped` is the declined run this exists to catch, and
      // `failure` is a reconcile that did not happen — it reds its own run, so
      // counting it would let a fleet that is genuinely behind read as fresh.
      if (step?.conclusion === 'success') return true;
    }
  }
  return false;
}

/**
 * Summarise "did anything reconcile the fleet inside the window".
 *
 * `runs` MUST be every completed run created within `maxAgeMs` of `now` — the
 * caller guarantees that with a `created:>=` API filter, which is what makes
 * the negative answer decidable. Given that guarantee there are only two
 * outcomes, and the absence of evidence is the alarm rather than a shrug:
 *
 *   RECENT — some run in the window reconciled.
 *   STALE  — none did. That includes the window being EMPTY, which is the
 *            #6203 failure itself: the workflow never ran.
 */
export function summarizeReconcileHistory(runs, { now, maxAgeMs = DEFAULT_MAX_RECONCILE_AGE_MS } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('summarizeReconcileHistory requires a numeric now');
  const inspected = Array.isArray(runs) ? runs : [];

  for (const run of inspected) {
    if (run?.reconciled !== true) continue;
    const completedAt = parseTimestamp(run?.completedAt);
    // A reconciled run whose timestamp is unreadable still proves a reconcile
    // happened inside the window — the window is the caller's guarantee, not
    // this field's. Report it without an age rather than discarding the proof.
    const ageMs = completedAt === null
      // Runner and API clocks disagree by seconds; a future-dated run must read
      // as "just now", not as a negative age that prints as -0h.
      ? null : Math.max(0, now - completedAt);
    return {
      state: 'RECENT',
      ageMs,
      lastReconciledAt: completedAt === null ? null : new Date(completedAt).toISOString(),
      runId: run.id ?? null,
      inspected: inspected.length,
      maxAgeMs,
    };
  }

  return {
    state: 'STALE',
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
    return summary.ageMs === null
      ? `Fleet reconciled inside the last ${hours(summary.maxAgeMs)}h (run ${summary.runId}).`
      : `Fleet last reconciled ${hours(summary.ageMs)}h ago (run ${summary.runId}).`;
  }
  return summary.inspected === 0
    ? `The fleet has not been reconciled in ${hours(summary.maxAgeMs)}h: this workflow produced NO completed run in that window at all. Neither the Deploy Gate event nor the hourly backstop is firing.`
    : `The fleet has not been reconciled in ${hours(summary.maxAgeMs)}h. ${summary.inspected} run(s) completed in that window and none of them deployed.`;
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

/** ISO-8601 to the second, which is the granularity the `created` filter takes. */
export function toCreatedFilter(instantMs) {
  return `${new Date(instantMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}

/**
 * Completed runs of this workflow created inside the window, newest first.
 *
 * `gh` is injected rather than imported so the I/O path is testable — this is
 * the seam the current-run exclusion lives on, and getting that wrong is how a
 * run reds itself.
 */
export function readRunsSince({ gh, repository, workflowFile, sinceMs, excludeRunId }) {
  // `created:>=` is what makes the negative answer decidable: the returned set
  // IS the window, so "none of these reconciled" means the fleet went
  // un-reconciled for the whole window rather than "the page ran out".
  const query = [
    'status=completed',
    `created=%3E%3D${encodeURIComponent(toCreatedFilter(sinceMs))}`,
    `per_page=${RUN_PAGE_SIZE}`,
  ].join('&');
  const payload = JSON.parse(gh([
    'api', '--paginate', '--slurp',
    `repos/${repository}/actions/workflows/${workflowFile}/runs?${query}`,
  ]));
  // --slurp wraps paginated responses in an array of pages.
  const pages = Array.isArray(payload) ? payload : [payload];
  const runs = [];
  for (const page of pages) {
    // An unreadable listing must never be summarised as an empty window: empty
    // now means STALE, which is loud, but it would be loud for a false reason.
    if (!Array.isArray(page?.workflow_runs)) {
      throw new Error(`the run listing for ${workflowFile} was not an array of workflow runs`);
    }
    runs.push(...page.workflow_runs);
  }
  return runs
    // The CURRENT run is excluded twice over — `status=completed` cannot return
    // a run that is still executing, and this drops it by id as well. That is
    // deliberate and it is why the workflow must not ask this question on a run
    // whose own deploy just succeeded: such a run cannot see itself, so after a
    // drought it would report the fleet stale seconds after fixing it.
    .filter((run) => String(run?.id) !== String(excludeRunId))
    .map((run) => ({ id: run?.id ?? null, completedAt: run?.updated_at ?? null }));
}

/**
 * The window, with each run resolved to whether it reconciled.
 *
 * Newest-first, stopping at the first run that reconciled: everything older
 * cannot change the answer, so the healthy case costs one extra call rather
 * than one per run in the window.
 */
export function collectReconcileWindow({ gh, repository, workflowFile, sinceMs, excludeRunId }) {
  const candidates = readRunsSince({ gh, repository, workflowFile, sinceMs, excludeRunId });
  const inspected = [];
  for (const candidate of candidates) {
    const jobs = JSON.parse(gh(['api', `repos/${repository}/actions/runs/${candidate.id}/jobs`]));
    const reconciled = readRunReconciled(jobs);
    inspected.push({ ...candidate, reconciled });
    if (reconciled) break;
  }
  return inspected;
}

async function main() {
  const repository = readArgument(process.argv, '--repo', process.env.GITHUB_REPOSITORY || REPOSITORY);
  const workflowFile = readArgument(process.argv, '--workflow', DEFAULT_WORKFLOW_FILE);
  const maxAgeHours = Number(readArgument(
    process.argv,
    '--max-age-hours',
    String(DEFAULT_MAX_RECONCILE_AGE_MS / (60 * 60 * 1000)),
  ));
  const warnOnly = process.argv.includes('--warn-only');
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error('--max-age-hours must be a positive number');
  }

  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const inspected = collectReconcileWindow({
    gh: runGh,
    repository,
    workflowFile,
    sinceMs: now - maxAgeMs,
    excludeRunId: process.env.GITHUB_RUN_ID ?? null,
  });

  const summary = summarizeReconcileHistory(inspected, { now, maxAgeMs });
  const message = describeReconcileSummary(summary);

  if (summary.state === 'RECENT') {
    console.log(message);
    return;
  }
  // STALE is the alarm, and it is the ONLY other state: the time-bounded window
  // makes "nothing reconciled" a proof rather than a shortfall of evidence.
  console.log(`::${warnOnly ? 'warning' : 'error'}::${message}`);
  if (!warnOnly) process.exitCode = 1;
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
