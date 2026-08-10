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
// API sees that as "no completed run on main in the window" — an alarm.
//
// DIRECTION OF FAILURE
//
// Every case where the record is missing, unreadable, ambiguous or truncated
// resolves away from "healthy". A scanner whose unmatched case means HEALTHY
// is the same defect in a new place.

import { spawnSync } from 'node:child_process';

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
    // job decides whether to deploy). So "no completed run in the window"
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
    // Path-filtered and rare: the Worker is dormant control-plane infra and a
    // healthy stretch with no matching push is ordinary. 14 days is the
    // backstop for a trigger that stopped firing.
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
    // Same dormant reasoning as the reconcile Worker: last run 2026-08-02,
    // and a healthy run can be weeks apart.
    noRunWindowMs: 14 * 24 * 60 * 60 * 1000,
  }),
]);

// Fallback for a workflow that does not declare one.
export const DEFAULT_NO_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

// A run that is still executing is not a verdict: the next tick decides. The
// API's `status=completed` filter should exclude these, but a mis-read must
// not alarm (a fresh run is the deploy in progress, which is healthy).
const ACTIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

// Conclusions that mean "no verdict, do not judge this run".
const INDETERMINATE_RUN_CONCLUSIONS = new Set([
  'skipped',
]);

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

function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolve the newest completed run of one workflow on main, or a structured
 * verdict when there is none.
 *
 * `gh` is injected rather than imported so the I/O path is testable.
 */
export function readNewestRun({ gh, repository, workflowFile, now, noRunWindowMs = DEFAULT_NO_RUN_WINDOW_MS }) {
  const query = [
    'branch=main',
    'status=completed',
    'per_page=100',
  ].join('&');
  const payload = JSON.parse(gh([
    'api',
    `repos/${repository}/actions/workflows/${workflowFile}/runs?${query}`,
  ]));
  const runs = payload?.workflow_runs;
  if (!Array.isArray(runs)) {
    throw new Error(`the run listing for ${workflowFile} was not an object with a workflow_runs array`);
  }

  // The API returns newest-first, but nothing forces that: sort defensively so
  // the newest run cannot depend on an undocumented ordering. A run with an
  // unreadable created_at sorts last — an unreadable record must not decide
  // the verdict.
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
      detail: `no completed run of ${workflowFile} on main is recorded at all`,
    };
  }
  const createdMs = parseTimestamp(newest.created_at);
  if (createdMs === null || now - createdMs > noRunWindowMs) {
    return {
      found: true,
      verdict: 'NO_RUN_IN_WINDOW',
      runId: newest.id ?? null,
      createdAt: newest.created_at ?? null,
      conclusion: newest.conclusion ?? null,
      detail: `the newest completed run of ${workflowFile} on main (${newest.id}) predates the ${noRunWindowMs / (60 * 60 * 1000)}h window — the workflow may have stopped running`,
    };
  }
  return {
    found: true,
    verdict: 'RUN_FOUND',
    runId: newest.id ?? null,
    createdAt: newest.created_at ?? null,
    conclusion: newest.conclusion ?? null,
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
  const payload = JSON.parse(gh([
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
  const result = git(['diff', '--name-only', `${parentSha}`, `${headSha}`, '--', pathPrefix]);
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
export function judgeWorkflow({ workflow, run, jobs, skipProof }) {
  if (run.verdict === 'NO_RUN' || run.verdict === 'NO_RUN_IN_WINDOW') {
    return {
      state: 'ALARM',
      verdict: run.verdict,
      runId: run.runId ?? null,
      detail: run.detail,
    };
  }

  const conclusion = run.conclusion;
  if (ACTIVE_RUN_STATUSES.has(conclusion)) {
    // A completed listing should not contain these, but an in-flight run is a
    // deploy under way — the next tick decides.
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
 * `io` bundles the injected side effects: `gh`, `git`, `now`. Every unreadable
 * record throws — the caller exits non-zero — because an unreadable record
 * must never resolve to healthy.
 */
export function checkPostmergeDeploys({ repository, gh, git, now = Date.now() }) {
  const results = [];
  for (const workflow of MONITORED_WORKFLOWS) {
    const run = readNewestRun({ gh, repository, workflowFile: workflow.file, now, noRunWindowMs: workflow.noRunWindowMs });
    let jobs = null;
    if (run.found && run.verdict === 'RUN_FOUND') {
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
      ...judgeWorkflow({ workflow, run, jobs, skipProof }),
    });
  }
  return results;
}

async function main() {
  const repository = readArgument(process.argv, '--repo', process.env.GITHUB_REPOSITORY || REPOSITORY);
  const asJson = process.argv.includes('--json');
  const results = checkPostmergeDeploys({
    repository,
    gh: runGh,
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
      const mark = result.state === 'OK' ? 'ok' : 'ERROR';
      console.log(`postmerge-deploy ${mark}: ${result.displayName} [${result.verdict}] ${result.detail}`);
    }
  }

  const alarms = results.filter((result) => result.state === 'ALARM');
  if (alarms.length > 0) {
    console.error(`Post-merge deploy monitor found ${alarms.length} workflow(s) that did not deploy:`);
    for (const alarm of alarms) {
      console.error(`- ${alarm.displayName} [${alarm.verdict}] ${alarm.detail}`);
    }
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
