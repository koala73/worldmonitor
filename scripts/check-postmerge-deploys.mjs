#!/usr/bin/env node

// Alarms on a failed post-merge production deploy. (#6376)
//
// WHY THIS EXISTS
//
// `main` can be green while a production deploy never happened. Convex Deploy
// and Deploy Railway Reconcile Control both run on push to `main` and both
// failed there with main staying green:
//
//   - Convex Deploy failed on 5605edcbd (#6232) with `InvalidModules ...
//     import.meta unsupported`; the whole convex/ change set sat in main and
//     never reached Convex production. Fixed by #6373 — but nothing except a
//     human reading the Actions tab surfaced it.
//   - Deploy Railway Reconcile Control failed on d130a957f (#6325) and
//     eb4bb09c1 (#6326) because five required secrets did not exist.
//
// These are post-merge deploys, so they cannot gate the PR that causes them.
// The deploy gate's `required` list cannot include them either (they run on
// main pushes, not PRs). What they need is an alarm: a scheduled monitor that
// fails loudly when the newest run of one of these workflows on main is not
// green.
//
// Why scan run history instead of listening for workflow_run events: the
// event fires only on completion, so a workflow that never runs (deleted,
// broken trigger) produces no event at all. A time-bounded scan of the runs
// API sees that as "no run on main in the window" — an alarm.
//
// DIRECTION OF FAILURE
//
// A verified failed deploy is ALARM and fails the job. GitHub transport
// unreadability after the retry budget (TLS, DNS, timeout, 5xx) is UNKNOWN:
// visible as an Actions warning, never a claim that a deploy failed, and it
// does not fail the job. Local proof failures (git, missing `gh`) and GitHub
// 4xx answers are ALARM and still fail the job. An unmatched case that means
// HEALTHY is the same defect in a new place.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import { isMainModule } from './lib/main-module.mjs';
import { REPOSITORY, readArgument } from './railway-cli.mjs';

// The workflows this monitor speaks for, keyed by workflow FILE (stable) with
// the display name for humans. Each must be a push-to-main deployer that the
// deploy gate cannot see.
export const MONITORED_WORKFLOWS = Object.freeze([
  Object.freeze({
    file: 'convex-deploy.yml',
    displayName: 'Convex Deploy',
    // The job id IS the check-run name here: convex-deploy.yml writes
    // `deploy:` with no `name:` override, and the jobs API publishes the id.
    deployJobName: 'deploy',
    // What a legitimate skip of the deploy job means for this workflow: the
    // run must not have changed anything under convex/.
    skipProofPath: 'convex/',
    // Convex Deploy fires on EVERY push to main (no path filter; the changes
    // job decides whether to deploy). So "no run in the window"
    // means "no merge to main in the window". The observed max gap across the
    // last 100 completed runs is ~5 days (quiet weekend), so 7 days is the
    // backstop for a workflow that stopped firing at all.
    noRunWindowMs: 7 * 24 * 60 * 60 * 1000,
  }),
  Object.freeze({
    file: 'deploy-railway-reconcile-control.yml',
    displayName: 'Deploy Railway Reconcile Control',
    // The YAML key is `deploy` but the job carries `name: Wrangler deploy`,
    // which is what the jobs API returns.
    deployJobName: 'Wrangler deploy',
    // The workflow's own path filter covers workers/railway-reconcile-control/**
    // plus its own file and test. A push touching ONLY those paths must
    // deploy; a deploy job skipped there is an unexpected skip, which alarms.
    skipProofPath: null,
    triggerPaths: Object.freeze([
      'workers/railway-reconcile-control/**',
      '.github/workflows/deploy-railway-reconcile-control.yml',
      'tests/deploy-railway-reconcile-control-workflow.test.mjs',
    ]),
    // Path-filtered and rare: the Worker is dormant control-plane infra and a
    // healthy stretch with no matching push is ordinary. Every tick proves
    // whether a deploy was due from the trigger-path tree diff; this window
    // only marks an active run as stuck and labels an old baseline.
    noRunWindowMs: 14 * 24 * 60 * 60 * 1000,
  }),
  Object.freeze({
    file: 'deploy-worker.yml',
    displayName: 'Deploy api-cors-preflight Worker',
    deployJobName: 'Wrangler deploy',
    // Same shape: path-filtered push-to-main, no gate anywhere. A missing
    // CLOUDFLARE_API_TOKEN fails it silently like the reconcile Worker's
    // missing secrets did.
    skipProofPath: null,
    triggerPaths: Object.freeze([
      'workers/api-cors-preflight/**',
      'api/_bootstrap-public-tier.js',
      '.github/workflows/deploy-worker.yml',
    ]),
    // Same dormant reasoning as the reconcile Worker: a healthy run can be
    // weeks apart, so the trigger-path tree — not age — decides whether a
    // deploy is due.
    noRunWindowMs: 14 * 24 * 60 * 60 * 1000,
  }),
]);

// Fallback for a workflow that does not declare one.
export const DEFAULT_NO_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

// A run that is still executing is not a verdict: the next tick decides. The
// A fresh active run is the deploy in progress, which is healthy until the
// next tick. An active run older than its workflow window is stuck and alarms.
const ACTIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

// Conclusions that mean "no verdict, do not judge this run".
const INDETERMINATE_RUN_CONCLUSIONS = new Set([
  'skipped',
]);

const GH_CALL_TIMEOUT_MS = 30_000;

// Retries AFTER the first attempt, so the worst case is 3 calls. Sized against
// the workflow's `timeout-minutes: 10`: a transport failure returns in about a
// second, so 3 workflows x 2 reads x 3 attempts costs seconds, not minutes.
export const GH_READ_RETRY_ATTEMPTS = 2;
export const GH_READ_RETRY_BASE_MS = 500;
export const GH_READ_RETRY_MAX_MS = 4_000;

/**
 * Is this `gh` failure worth asking again? (#6479)
 *
 * The distinction is whether GitHub ANSWERED. `gh api` puts the status in its
 * stderr as `(HTTP nnn)`; a 404 or 422 is an answer and re-asking cannot change
 * it, so retrying only burns the job's budget and delays the alarm. When no
 * status appears at all the request never reached GitHub — TLS, DNS, a reset,
 * an EOF — and that is exactly the class that a second attempt fixes.
 *
 * Timeouts are deliberately terminal: every attempt burns the full 30s call
 * budget, so retrying them would spend the 10-minute job on one dead read. Same
 * decision, same reason, as the sibling watchdog (#6478).
 */
export function isRetryableGhFailure(error) {
  if (!error) return false;
  if (error.timedOut === true) return false;
  // gh itself missing (ENOENT) will never succeed on a retry.
  if (error.code === 'ENOENT') return false;
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/\(HTTP (\d{3})\)/);
  if (status) {
    const code = Number(status[1]);
    return code === 408 || code === 429 || code >= 500;
  }
  return true;
}

const GITHUB_READ_SOURCE = 'github-api';

function markGithubReadFailure(error) {
  const marked = error instanceof Error ? error : new Error(String(error));
  marked.githubReadSource = GITHUB_READ_SOURCE;
  return marked;
}

function isGithubReadFailure(error) {
  return error instanceof Error && error.githubReadSource === GITHUB_READ_SOURCE;
}

function isProvenGithubTransportFailure(message) {
  return /\b(?:tls|x509|eof)\b|certificate|dial tcp|lookup .*no such host|no such host|connection (?:reset|refused|closed|aborted)|network is unreachable|no route to host|context deadline exceeded|i\/o timeout|operation timed out|temporary failure in name resolution/i.test(message);
}

function readGithub(gh, args) {
  try {
    return gh(args);
  } catch (error) {
    throw markGithubReadFailure(error);
  }
}

/**
 * After the retry budget, is this throw GitHub-record unreadability rather
 * than a local proof failure or a GitHub answer?
 *
 * Only unreadability becomes UNKNOWN (a non-failing Actions warning). git
 * throws, a missing `gh` binary, and HTTP 4xx answers are ALARM so the
 * monitor still fails closed for those. Timeouts are not retried (they would
 * burn the job) but they are still unreadability.
 */
export function isGithubRecordUnreadability(error) {
  if (!isGithubReadFailure(error)) return false;
  if (error.code === 'ENOENT') return false;
  const message = error.message;
  if (error.timedOut === true) return true;
  const status = message.match(/\(HTTP (\d{3})\)/);
  if (status) {
    const code = Number(status[1]);
    return code >= 500;
  }
  return isProvenGithubTransportFailure(message);
}

function sleepSync(ms) {
  // spawnSync makes the whole read path synchronous, so the backoff must be
  // too. Atomics.wait on a private buffer blocks without a busy loop.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Wrap a `gh` reader so a transient transport failure does not become a verdict.
 *
 * `sleep` is injected so tests do not pay the backoff.
 */
export function createRetryingGh({ gh, sleep = sleepSync, attempts = GH_READ_RETRY_ATTEMPTS }) {
  return (args) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return gh(args);
      } catch (error) {
        if (attempt >= attempts || !isRetryableGhFailure(error)) throw error;
        sleep(Math.min(GH_READ_RETRY_BASE_MS * (2 ** attempt), GH_READ_RETRY_MAX_MS));
      }
    }
  };
}

function runGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: GH_CALL_TIMEOUT_MS,
  });
  if (result.signal) {
    const error = new Error(`gh ${args.join(' ')} timed out`);
    error.timedOut = true;
    throw markGithubReadFailure(error);
  }
  if (result.error) throw markGithubReadFailure(result.error);
  if (result.status !== 0) {
    throw markGithubReadFailure(new Error(`gh ${args.join(' ')} failed (${result.status}): ${String(result.stderr).trim()}`));
  }
  return result.stdout;
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolve the newest run of one workflow on main, including queued or active
 * work, or a structured verdict when there is none.
 *
 * `gh` is injected rather than imported so the I/O path is testable.
 */
export function readNewestRun({ gh, repository, workflowFile, now, noRunWindowMs = DEFAULT_NO_RUN_WINDOW_MS }) {
  const query = [
    'branch=main',
    'per_page=100',
  ].join('&');
  const payload = JSON.parse(readGithub(gh, [
    'api',
    `repos/${repository}/actions/workflows/${workflowFile}/runs?${query}`,
  ]));
  const runs = payload?.workflow_runs;
  if (!Array.isArray(runs)) {
    throw new Error(`the run listing for ${workflowFile} was not an object with a workflow_runs array`);
  }
  for (const candidate of runs) {
    if (parseTimestamp(candidate?.created_at) === null) {
      throw new Error(`run ${candidate?.id ?? '?'} of ${workflowFile} has an unreadable created_at timestamp`);
    }
  }

  // The API returns newest-first, but nothing forces that: sort defensively so
  // the newest run cannot depend on an undocumented ordering. The validation
  // above makes any unreadable timestamp a read failure instead of hiding it.
  const ordered = [...runs].sort((left, right) => {
    const leftMs = parseTimestamp(left?.created_at);
    const rightMs = parseTimestamp(right?.created_at);
    if (leftMs === null && rightMs === null) return 0;
    if (leftMs === null) return 1;
    if (rightMs === null) return -1;
    return rightMs - leftMs;
  });

  const newest = ordered[0];
  if (!newest) {
    return {
      found: false,
      verdict: 'NO_RUN',
      detail: `no run of ${workflowFile} on main is recorded at all`,
    };
  }
  const createdMs = parseTimestamp(newest.created_at);
  const conclusion = ACTIVE_RUN_STATUSES.has(newest.status)
    ? newest.status
    : (newest.conclusion ?? null);
  if (now - createdMs > noRunWindowMs) {
    return {
      found: true,
      verdict: 'NO_RUN_IN_WINDOW',
      runId: newest.id ?? null,
      createdAt: newest.created_at ?? null,
      conclusion,
      runAttempt: newest.run_attempt ?? 1,
      headSha: newest.head_sha ?? null,
      event: newest.event ?? null,
      displayTitle: newest.display_title ?? null,
      detail: `the newest run of ${workflowFile} on main (${newest.id}) predates the ${noRunWindowMs / (60 * 60 * 1000)}h window — the workflow may have stopped running`,
    };
  }
  return {
    found: true,
    verdict: 'RUN_FOUND',
    runId: newest.id ?? null,
    createdAt: newest.created_at ?? null,
    conclusion,
    runAttempt: newest.run_attempt ?? 1,
    headSha: newest.head_sha ?? null,
    event: newest.event ?? null,
    displayTitle: newest.display_title ?? null,
  };
}

/**
 * Read the jobs of one run attempt, keyed by job name.
 *
 * Uses the attempts-scoped endpoint so a re-run attempt is judged, not the
 * original failed attempt. The jobs payload lists the EFFECTIVE job set after
 * `if:` filtering: a job skipped by a `convex=false` diff appears with
 * `conclusion: skipped` and an empty steps array (verified live on run
 * 31384987576), while a failed deploy job concludes `failure` with steps
 * (runs 31323075509 / 31323823825).
 */
export function readRunJobs({ gh, repository, runId, runAttempt }) {
  const payload = JSON.parse(readGithub(gh, [
    'api',
    `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs`,
  ]));
  if (!Array.isArray(payload?.jobs)) {
    throw new Error(`the job listing for run ${runId} was not an object with a jobs array`);
  }
  const byName = new Map();
  for (const job of payload.jobs) {
    const name = typeof job?.name === 'string' ? job.name : null;
    if (!name) continue;
    byName.set(name, {
      name,
      conclusion: job.conclusion ?? null,
      status: job.status ?? null,
    });
  }
  return byName;
}

/**
 * Did the diff between `parent` and `head` touch `pathPrefix`?
 *
 * Returns a boolean, never a maybe, but the caller must treat a read failure
 * (a checkout too shallow to reach the parent, a missing object) as ALARM —
 * a skipped deploy whose skip reason cannot be verified must not resolve to
 * healthy. `git` is injected for testability.
 */
export function diffTouchesPath({ git, parentSha, headSha, pathPrefix }) {
  return diffTouchesPaths({ git, baseSha: parentSha, headSha, paths: [pathPrefix] });
}

/**
 * Did any of `paths` change between a deployed baseline and the current tree?
 *
 * Path-filtered workflows can be dormant indefinitely. Their age alone says
 * nothing about health; the trigger-path tree diff says whether a newer deploy
 * was required. A read failure throws so the caller reports ALARM, never OK.
 */
export function diffTouchesPaths({ git, baseSha, headSha, paths }) {
  if (typeof baseSha !== 'string' || baseSha.length === 0) {
    throw new Error('the deployed baseline SHA is missing');
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('the deploy trigger path list is missing');
  }
  const result = git(['diff', '--name-only', `${baseSha}`, `${headSha}`, '--', ...paths]);
  return result.trim().length > 0;
}

/**
 * Decide the alarm verdict for one workflow.
 *
 * `run` is the resolved newest run (RUN_FOUND / NO_RUN_IN_WINDOW / NO_RUN),
 * `jobs` the parsed job map (null when the run has no deploy job to read,
 * e.g. a NO_RUN verdict), `skipProof` a function answering "did the head
 * commit touch the skip-proof path" or null when the workflow has no
 * legitimate skip.
 *
 * Returns { state: 'OK' | 'ALARM', verdict, detail, runId }.
 */
export function judgeWorkflow({ workflow, run, jobs, skipProof, deploymentRequired }) {
  if (run.verdict === 'NO_RUN') {
    return {
      state: 'ALARM',
      verdict: run.verdict,
      runId: run.runId ?? null,
      detail: run.detail,
    };
  }
  if (run.verdict === 'NO_RUN_IN_WINDOW') {
    if (!Array.isArray(workflow.triggerPaths) || workflow.triggerPaths.length === 0) {
      return {
        state: 'ALARM',
        verdict: run.verdict,
        runId: run.runId ?? null,
        detail: run.detail,
      };
    }
    if (ACTIVE_RUN_STATUSES.has(run.conclusion)) {
      return {
        state: 'ALARM',
        verdict: 'RUN_STUCK',
        runId: run.runId ?? null,
        detail: `run ${run.runId} has remained ${run.conclusion} beyond the workflow age window`,
      };
    }
    if (deploymentRequired === true) {
      return {
        state: 'ALARM',
        verdict: 'DEPLOY_MISSING_AFTER_CHANGE',
        runId: run.runId ?? null,
        detail: `run ${run.runId} is outside the age window and at least one deploy trigger path changed after ${run.headSha ?? 'an unreadable baseline'}`,
      };
    }
    if (deploymentRequired !== false) {
      return {
        state: 'ALARM',
        verdict: 'DEPLOY_STATE_UNPROVEN',
        runId: run.runId ?? null,
        detail: `run ${run.runId} is outside the age window and the deploy trigger path state could not be proven`,
      };
    }

    // The current trigger-path tree matches this old run's head. It is a valid
    // production baseline only if the run and its deploy job both succeeded.
    const baseline = judgeWorkflow({
      workflow,
      run: { ...run, verdict: 'RUN_FOUND' },
      jobs,
      skipProof,
      deploymentRequired: false,
    });
    if (baseline.state !== 'OK' || baseline.verdict !== 'DEPLOYED') return baseline;
    return {
      state: 'OK',
      verdict: 'DEPLOY_NOT_DUE',
      runId: run.runId ?? null,
      detail: `run ${run.runId} is outside the age window, but no deploy trigger path changed after ${run.headSha}`,
    };
  }

  const conclusion = run.conclusion;
  if (ACTIVE_RUN_STATUSES.has(conclusion)) {
    // An in-flight run is a deploy under way — the next tick decides.
    return { state: 'OK', verdict: 'IN_PROGRESS', runId: run.runId, detail: `run ${run.runId} is still ${conclusion}` };
  }
  if (INDETERMINATE_RUN_CONCLUSIONS.has(conclusion)) {
    return { state: 'ALARM', verdict: 'RUN_SKIPPED', runId: run.runId, detail: `run ${run.runId} concluded ${conclusion} — a deploy workflow that never deploys is not healthy` };
  }
  if (conclusion !== 'success') {
    return {
      state: 'ALARM',
      verdict: 'RUN_FAILED',
      runId: run.runId,
      detail: `run ${run.runId} (${run.displayTitle ?? run.event ?? '?'}) concluded ${conclusion}`,
    };
  }
  if (Array.isArray(workflow.triggerPaths) && workflow.triggerPaths.length > 0) {
    if (deploymentRequired === true) {
      return {
        state: 'ALARM',
        verdict: 'DEPLOY_MISSING_AFTER_CHANGE',
        runId: run.runId ?? null,
        detail: `run ${run.runId} succeeded, but at least one deploy trigger path changed after ${run.headSha ?? 'an unreadable baseline'} without a newer run`,
      };
    }
    if (deploymentRequired !== false) {
      return {
        state: 'ALARM',
        verdict: 'DEPLOY_STATE_UNPROVEN',
        runId: run.runId ?? null,
        detail: `run ${run.runId} succeeded, but the deploy trigger path state could not be proven`,
      };
    }
  }

  // The run succeeded. The deploy job is the one that matters: a success with
  // the deploy job failed is impossible (the run would be red), but a success
  // with the deploy job SKIPPED is the #6376 shape in reverse — the run went
  // green while nothing deployed. Positive detection only: absence of every
  // deploy job in the listing reads as failure, not as healthy.
  //
  // The deploy job's name is not one string. convex-deploy.yml names its job
  // `deploy`; deploy-railway-reconcile-control.yml and deploy-worker.yml give
  // it a display name (`Wrangler deploy`, `Live control-plane smoke`) while
  // keeping the `deploy` id as the YAML key. The jobs API returns the display
  // name, so each workflow declares the deploy job name the API actually
  // publishes via `deployJobName`.
  const deployName = workflow.deployJobName ?? 'deploy';
  const deployJobs = [...(jobs?.entries() ?? [])].filter(([name]) => name === deployName);
  if (deployJobs.length === 0) {
    return {
      state: 'ALARM',
      verdict: 'DEPLOY_JOB_MISSING',
      runId: run.runId,
      detail: `run ${run.runId} succeeded but its job listing has no '${deployName}' job — nothing deployed`,
    };
  }
  const deploy = deployJobs[0][1];
  if (deploy.conclusion === 'success') {
    return { state: 'OK', verdict: 'DEPLOYED', runId: run.runId, detail: `run ${run.runId} deployed` };
  }
  if (deploy.conclusion === 'skipped') {
    // A legitimate skip exists only for Convex Deploy: the convex=false path
    // diff. Any other workflow's deploy job must never be skipped, and even
    // for Convex the skip must be proven against the actual diff — a workflow
    // edit that widens or narrows the filter would otherwise skip silently.
    if (workflow.skipProofPath && typeof skipProof === 'function') {
      let skipLegitimate = null;
      try {
        skipLegitimate = skipProof(run.headSha);
      } catch (error) {
        skipLegitimate = null;
      }
      if (skipLegitimate === true) {
        return {
          state: 'OK',
          verdict: 'DEPLOY_SKIPPED_LEGIT',
          runId: run.runId,
          detail: `run ${run.runId} skipped the deploy because nothing under ${workflow.skipProofPath} changed`,
        };
      }
      return {
        state: 'ALARM',
        verdict: 'DEPLOY_SKIPPED_UNPROVEN',
        runId: run.runId,
        detail: `run ${run.runId} skipped the deploy and the skip reason (nothing under ${workflow.skipProofPath} changed) could not be proven against the head diff`,
      };
    }
    return {
      state: 'ALARM',
      verdict: 'DEPLOY_SKIPPED_UNEXPECTED',
      runId: run.runId,
      detail: `run ${run.runId} succeeded but skipped its deploy job, which ${workflow.displayName} must never do`,
    };
  }
  return {
    state: 'ALARM',
    verdict: 'DEPLOY_JOB_FAILED',
    runId: run.runId,
    detail: `run ${run.runId} concluded success but its deploy job concluded ${deploy.conclusion}`,
  };
}

/**
 * Run the whole monitor for every monitored workflow and return the report.
 *
 * `io` bundles the injected side effects: `gh`, `git`, `now`. GitHub
 * transport unreadability becomes UNKNOWN. git/4xx/ENOENT throws become
 * ALARM so they still fail the job.
 */
export function checkPostmergeDeploys({ repository, gh, git, now = Date.now() }) {
  const results = [];
  for (const workflow of MONITORED_WORKFLOWS) {
    try {
      const run = readNewestRun({ gh, repository, workflowFile: workflow.file, now, noRunWindowMs: workflow.noRunWindowMs });
      let jobs = null;
      let deploymentRequired = null;
      if (run.found && Array.isArray(workflow.triggerPaths)) {
        deploymentRequired = diffTouchesPaths({
          git,
          baseSha: run.headSha,
          headSha: 'origin/main',
          paths: workflow.triggerPaths,
        });
      }
      if (run.found && run.conclusion === 'success' && deploymentRequired !== true && (
        run.verdict === 'RUN_FOUND'
        || (run.verdict === 'NO_RUN_IN_WINDOW' && deploymentRequired === false)
      )) {
        jobs = readRunJobs({
          gh,
          repository,
          runId: run.runId,
          runAttempt: run.runAttempt,
        });
      }
      const skipProof = workflow.skipProofPath
        ? (headSha) => {
          // The parent of the head on main. The checkout has full history with
          // no blobs (see the workflow), so `git diff --name-only` needs only
          // trees. A missing parent is a read failure: throw, and the caller
          // resolves the skip to ALARM.
          const parent = git(['rev-parse', '--verify', `${headSha}^`]).trim();
          return !diffTouchesPath({ git, parentSha: parent, headSha, pathPrefix: workflow.skipProofPath });
        }
        : null;
      results.push({
        workflow: workflow.file,
        displayName: workflow.displayName,
        ...judgeWorkflow({ workflow, run, jobs, skipProof, deploymentRequired }),
      });
    } catch (error) {
      // #6479: one unreadable record used to abort the whole walk, so a
      // transient failure on the FIRST workflow hid a genuinely red deploy on
      // the second. Every workflow gets its own verdict. GitHub transport
      // unreadability is UNKNOWN (not a failed deploy). git, missing gh, and
      // HTTP 4xx answers are ALARM so they still fail the job.
      const detail = `the record could not be read: ${error instanceof Error ? error.message : String(error)}`;
      const unread = isGithubRecordUnreadability(error);
      results.push({
        workflow: workflow.file,
        displayName: workflow.displayName,
        state: unread ? 'UNKNOWN' : 'ALARM',
        verdict: unread ? 'READ_FAILED' : 'READ_UNPROVEN',
        runId: null,
        detail,
      });
    }
  }
  return results;
}

/**
 * Split the results into the two things a notification must not conflate: a
 * deploy that failed, and a record that could not be read. (#6479)
 *
 * Only ALARM results exit non-zero. GitHub transport unreadability remains a
 * visible warning, because "Convex Deploy did not deploy" and "we could not
 * reach the GitHub API" call for opposite responses. git/4xx/ENOENT are
 * ALARM with verdict READ_UNPROVEN so they are not filed as a failed deploy.
 */
export function summarizeResults(results) {
  const alarms = results.filter((result) => result.state === 'ALARM');
  const unknowns = results.filter((result) => result.state === 'UNKNOWN');
  const deployAlarms = alarms.filter((result) => result.verdict !== 'READ_UNPROVEN');
  const proofAlarms = alarms.filter((result) => result.verdict === 'READ_UNPROVEN');
  const lines = [];
  if (deployAlarms.length > 0) {
    lines.push(`Post-merge deploy monitor found ${deployAlarms.length} workflow(s) that did not deploy:`);
    for (const alarm of deployAlarms) lines.push(`- ${alarm.displayName} [${alarm.verdict}] ${alarm.detail}`);
  }
  if (proofAlarms.length > 0) {
    lines.push(`Post-merge deploy monitor could not prove ${proofAlarms.length} workflow(s) — git, gh, or a GitHub 4xx answer failed, not a transport outage:`);
    for (const alarm of proofAlarms) lines.push(`- ${alarm.displayName} [${alarm.verdict}] ${alarm.detail}`);
  }
  if (unknowns.length > 0) {
    lines.push(`Post-merge deploy monitor could not be read for ${unknowns.length} workflow(s) — this is a read failure, not a failed deploy:`);
    for (const unknown of unknowns) lines.push(`- ${unknown.displayName} [${unknown.verdict}] ${unknown.detail}`);
  }
  return {
    alarms,
    unknowns,
    lines,
    exitCode: alarms.length > 0 ? 1 : 0,
  };
}

export function formatResultMark(state) {
  if (state === 'OK') return 'ok';
  if (state === 'UNKNOWN') return 'warn';
  return 'ERROR';
}

export function githubWarningAnnotations(results) {
  return results
    .filter((result) => result.state === 'UNKNOWN')
    .map((result) => (
      `::warning title=Post-merge deploy record unread::${result.displayName} [${result.verdict}] ${result.detail}`
    ));
}

/**
 * Make UNKNOWN visible on a green Actions job: a `::warning::` annotation
 * plus the existing summary lines on `$GITHUB_STEP_SUMMARY`. Plain stdout
 * `warn:` on an exit-0 job is easy to miss.
 */
export function writeUnknownVisibility({
  results,
  summary,
  stderr = (...args) => console.error(...args),
  env = process.env,
  appendFile = appendFileSync,
}) {
  for (const line of githubWarningAnnotations(results)) stderr(line);
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath !== 'string' || summaryPath.length === 0 || summary.lines.length === 0) {
    return;
  }
  try {
    appendFile(summaryPath, `${summary.lines.join('\n')}\n`);
  } catch {
    stderr('::warning::Could not write GitHub step summary');
  }
}

async function main() {
  const repository = readArgument(process.argv, '--repo', process.env.GITHUB_REPOSITORY || REPOSITORY);
  const asJson = process.argv.includes('--json');
  const results = checkPostmergeDeploys({
    repository,
    // Reads retry; a transient TLS or DNS failure must not become a verdict.
    gh: createRetryingGh({ gh: runGh }),
    git: (args) => {
      const result = spawnSync('git', args, {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: GH_CALL_TIMEOUT_MS,
      });
      if (result.signal) throw new Error(`git ${args.join(' ')} timed out`);
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${result.status}): ${String(result.stderr).trim()}`);
      }
      return result.stdout;
    },
  });

  if (asJson) {
    console.log(JSON.stringify({ repository, results }, null, 2));
  } else {
    for (const result of results) {
      const mark = formatResultMark(result.state);
      console.log(`postmerge-deploy ${mark}: ${result.displayName} [${result.verdict}] ${result.detail}`);
    }
  }

  const summary = summarizeResults(results);
  writeUnknownVisibility({ results, summary });
  for (const line of summary.lines) console.error(line);
  process.exitCode = summary.exitCode;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
