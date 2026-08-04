#!/usr/bin/env node

// Builds the services a merge actually changed, from CI, where we own the
// decision and can test it (#6142).
//
// WHY THIS EXISTS
//
// Railway decides on its own whether a push produces a build, and it takes two
// separate decisions. The watch-path one is fine — re-measured fleet-wide, its
// skips are correct to within 3 of 7,391 — and is not the defect #6141 took it
// for.
//
// The other decision is the problem. Railway also refuses to build a commit
// whose GitHub check suite is failing, and it reads the WHOLE suite — including
// scheduled workflows that re-report onto main's head SHA long after the merge
// gates went green. It is the dominant lag source by a wide margin, and it is
// self-reinforcing: the freshness monitor turns red precisely when the fleet is
// behind, and its redness then blocks the fleet from catching up.
//
// Full measurement and methodology:
// docs/solutions/integration-issues/railway-seeder-watch-paths-can-skip-deployments.md
//
// This script replaces that judgement with the repository's own. It runs after
// the required gates are green and asks, per service, one question: has
// anything that can reach this service changed since the commit it is running?
// If yes, and Railway has not already built the head commit, it deploys it.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not clear Railway's watch paths. They do a legitimate job — the
// measurement above is what they look like working — and clearing them rebuilds
// all 77 services on every merge for no gain in the tail that matters.
//
// It does not re-trigger a build that Railway already ran and FAILED. That is a
// real failure that scripts/check-railway-deploy-drift.mjs reports; retrying it
// here would bury the alarm under a retry loop.
//
// Usage:
//   node scripts/trigger-railway-deploys.mjs
//   node scripts/trigger-railway-deploys.mjs --dry-run --json
//   node scripts/trigger-railway-deploys.mjs --head <sha> --environment production
//   node scripts/trigger-railway-deploys.mjs --only seed-earthquakes,seed-aviation

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_CONCURRENCY,
  mapWithConcurrency,
  readArgument,
  readDeployments,
  readEnvironmentConfig,
  readRepositoryServices,
  runRailway,
} from './railway-cli.mjs';
import {
  newestRunning,
  orderByRecency,
} from './railway-deployments.mjs';
import {
  changeReachesService,
  createChangedPathsReader,
  pathsReachingService,
  resolveServiceClosure,
} from './railway-deploy-closure.mjs';

const DEFAULT_ENVIRONMENT = 'production';
const REGISTRY_URL = new URL('./railway-services.json', import.meta.url);

// Sized for THIS script's question, not inherited from the drift check's.
//
// The guarantee "never re-trigger a build Railway already ran and FAILED" holds
// only while that FAILED record is still inside the window: past it the record
// is invisible and the commit reads as never taken, so the trigger would retry
// a build that is failing for a real reason and bury the alarm under a loop.
// A service that records a tick per cron run — a 15-minute cron is 4/hour —
// pushes a failure out of a 50-record window in half a day. 200 covers roughly
// two days of the busiest cron in the fleet while staying one CLI call.
export const DEFAULT_DEPLOYMENT_WINDOW = 200;

// A build that is queued, running, finished or even failed for the head commit
// all mean the same thing here: Railway has taken this commit, so triggering a
// second build of it would only duplicate work or bury a failure.
export const HANDLED_BY_RAILWAY = 'ALREADY_TAKEN';

// Deploying is the safe direction, so every "we could not tell" resolves here.
export const DEPLOY_REASONS = Object.freeze({
  UNKNOWN_SOURCE: 'the running deployment carries no commit, so what it contains cannot be compared',
  HISTORY_UNAVAILABLE: 'the running commit is not in this checkout, so the change set cannot be computed',
});

/**
 * Decide, for one service, whether this merge has to build it.
 *
 * Pure: `deployments` is the raw `railway deployment list --json` array and
 * `changedPathsSince(sha)` returns the repository-relative paths changed
 * between `sha` and head, or null when the checkout cannot answer.
 */
export function planServiceDeploy({
  service,
  serviceId = null,
  closure,
  deployments,
  headSha,
  changedPathsSince,
  readError = null,
  // Whether `ancestor` is an ancestor of (or equal to) `descendant`. Used to
  // refuse deploying a service BACKWARDS. Defaults to "cannot prove it", which
  // keeps the service reported rather than rolled back.
  isAncestor = () => false,
}) {
  const base = { service, serviceId, runningSha: null, matchedPaths: [] };
  if (!Array.isArray(deployments)) {
    // Never guess in either direction on a failed query: deploying would mutate
    // production on no information, and skipping would claim this service was
    // considered. Surface it and fail the run.
    return {
      ...base,
      action: 'error',
      reason: 'the deployment history could not be read',
      detail: readError ?? 'the deployment history could not be read',
    };
  }

  // Same ordering rule as check-railway-deploy-drift.mjs, imported rather than
  // rewritten: both files decide "which deployment is running" from this sort,
  // and a second definition is how they come to disagree about one service. An
  // unparseable timestamp sorts oldest rather than producing NaN comparisons.
  const ordered = orderByRecency(deployments);

  // Any non-SKIPPED record for head means Railway has taken this commit —
  // queued it, built it, or built it and failed. This also subsumes "the
  // service is already running head", since a running deployment for head is
  // one of those records. SKIPPED is excluded on purpose: that record IS the
  // refusal this script exists to compensate.
  const taken = ordered.find(
    (deployment) => deployment?.meta?.commitHash === headSha && deployment.status !== 'SKIPPED',
  );
  if (taken) {
    return { ...base, action: 'skip', reason: HANDLED_BY_RAILWAY, detail: `Railway already has ${headSha.slice(0, 9)} (${taken.status})` };
  }

  const running = newestRunning(ordered);
  if (!running) {
    // Nothing has ever run. That is not a service lagging a merge — it is one
    // that was never started, is stopped, or is provisioned but idle, and
    // starting it is a decision nobody made here. The drift check reports it as
    // NO_BUILD_IN_WINDOW; this must not quietly turn that into a deploy.
    return {
      ...base,
      action: 'skip',
      reason: 'NEVER_DEPLOYED',
      detail: 'no deployment in the window ever reached a running state — starting a service is not this script\'s call',
    };
  }
  const runningSha = running.meta?.commitHash ?? null;
  if (!runningSha) {
    return {
      ...base,
      action: 'deploy',
      reason: 'UNKNOWN_SOURCE',
      detail: DEPLOY_REASONS.UNKNOWN_SOURCE,
    };
  }
  // Never deploy a service backwards. `git diff A..B` is non-empty in BOTH
  // directions, so a service Railway already advanced past the head this run
  // read — routine when a merge lands mid-run — would otherwise look like it
  // was missing those paths and get rolled back onto the older commit.
  if (isAncestor(headSha, runningSha)) {
    return {
      ...base,
      runningSha,
      action: 'skip',
      reason: 'AHEAD',
      detail: `running ${runningSha.slice(0, 9)}, a descendant of ${headSha.slice(0, 9)} — main moved after this run read it`,
    };
  }
  const changedPaths = changedPathsSince(runningSha);
  if (changedPaths === null) {
    return {
      ...base,
      runningSha,
      action: 'deploy',
      reason: 'HISTORY_UNAVAILABLE',
      detail: DEPLOY_REASONS.HISTORY_UNAVAILABLE,
    };
  }
  if (!changeReachesService(closure, changedPaths)) {
    return {
      ...base,
      runningSha,
      action: 'skip',
      reason: 'CLOSURE_UNCHANGED',
      detail: `nothing reaching this service changed between ${runningSha.slice(0, 9)} and ${headSha.slice(0, 9)}`,
    };
  }
  const matchedPaths = pathsReachingService(closure, changedPaths);
  return {
    ...base,
    runningSha,
    action: 'deploy',
    reason: 'CLOSURE_CHANGED',
    matchedPaths,
    detail: `${matchedPaths.length} path(s) reaching this service changed since ${runningSha.slice(0, 9)}: ${matchedPaths.slice(0, 4).join(', ')}${matchedPaths.length > 4 ? ', …' : ''}`,
  };
}

/**
 * Restrict the run to named services, for recovering one by hand.
 *
 * Throws on a name the fleet does not have rather than quietly selecting
 * nothing: a typo'd `--only` that reported "no service needs a build" would
 * read exactly like a healthy fleet.
 */
export function selectServices(services, only) {
  if (!only) return services;
  const wanted = only.split(',').map((name) => name.trim()).filter(Boolean);
  const available = new Set(services.map((service) => service.name));
  const unknown = wanted.filter((name) => !available.has(name));
  if (unknown.length > 0) {
    throw new Error(`--only names ${unknown.join(', ')}, which this repository does not deploy to Railway`);
  }
  return services.filter((service) => wanted.includes(service.name));
}

/**
 * Split the run's outcome by who can act on it.
 *
 * A service whose deployment history could not be read is a coverage gap, not a
 * broken reconciler: the fleet-wide query succeeded, the other services were
 * planned correctly, and a transient 429 or timeout on one of them is ordinary
 * third-party rot. Reddening the whole scheduled run for it would make the job
 * fail routinely, which is how a red workflow stops being read — and the
 * service itself is not unmonitored, because check-railway-deploy-drift.mjs
 * alarms independently if it really is behind.
 *
 * So unreadable services are reported loudly and do NOT fail the run. What does
 * fail it is anything that means this script is broken or its work did not
 * happen: a deploy call that failed or returned no deployment id.
 */
export function summarizeDeployPlan(plans) {
  const deploys = plans.filter((plan) => plan.action === 'deploy');
  const unreadable = plans.filter((plan) => plan.action === 'error');
  const counts = {};
  for (const plan of plans) counts[plan.reason] = (counts[plan.reason] ?? 0) + 1;
  // Every service unreadable is not "some third-party rot" — it is an auth or
  // connectivity failure wearing per-service clothing, and planning nothing
  // while reporting success is exactly the silent no-op this script exists to
  // remove.
  const allUnreadable = plans.length > 0 && unreadable.length === plans.length;
  return {
    counts,
    deploys,
    unreadable,
    errors: allUnreadable ? unreadable : [],
    ok: !allUnreadable,
  };
}

const GIT_CALL_TIMEOUT_MS = 30_000;

// Trims, matching the identically-shaped helper in check-railway-deploy-drift.mjs.
// The two are private to their files but conceptually one wrapper, and a caller
// that assumed the sibling's contract would silently get a trailing newline.
function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: GIT_CALL_TIMEOUT_MS });
  if (result.signal) throw new Error(`git ${args.join(' ')} timed out`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}


function resolveEnvironmentId(environmentName) {
  const status = JSON.parse(runRailway(['status', '--json']));
  const nodes = (status?.environments?.edges ?? []).map((edge) => edge?.node).filter(Boolean);
  const match = nodes.find((node) => node.name === environmentName);
  if (!match?.id) {
    throw new Error(
      `no environment named ${environmentName} in this Railway project (saw ${nodes.map((node) => node.name).join(', ') || 'none'})`,
    );
  }
  return match.id;
}

// serviceInstanceDeployV2 pins the exact commit and returns the deployment id,
// which is what makes the trigger verifiable: `railway up` records no commit at
// all, so every service it touched would read as UNKNOWN_SOURCE to the drift
// check, and `railway redeploy` without --from-source rebuilds the image the
// service already has and cannot advance it.
const DEPLOY_MUTATION = 'mutation Deploy($serviceId: String!, $environmentId: String!, $commitSha: String) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }';

export function buildDeployArgs({ serviceId, environmentId, commitSha }) {
  return [
    'api', DEPLOY_MUTATION,
    '--raw-var', `serviceId=${serviceId}`,
    '--raw-var', `environmentId=${environmentId}`,
    '--raw-var', `commitSha=${commitSha}`,
    '--compact',
  ];
}

export function readDeploymentId(response) {
  const parsed = typeof response === 'string' ? JSON.parse(response) : response;
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error?.message ?? String(error)).join('; '));
  }
  const id = parsed?.data?.serviceInstanceDeployV2;
  // A null payload with no errors array would otherwise read as a success and
  // report a deploy that never happened.
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`serviceInstanceDeployV2 returned no deployment id: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return id;
}

function readRegistryByService() {
  const registry = JSON.parse(readFileSync(REGISTRY_URL, 'utf8'));
  if (!Array.isArray(registry)) throw new Error('Railway service registry must be an array');
  return new Map(registry.map((entry) => [entry.service, entry]));
}

function printReport(plans, summary, headSha, { dryRun, elapsedMs }) {
  // The service count IS the Railway read count (one `deployment list` each),
  // and it plus the wall clock is what the next fan-out measurement needs — the
  // schedule offset that keeps this job clear of the freshness monitor is only
  // sound while both stay well under the interval, and nothing else records it.
  console.log(
    `Railway deploy trigger: head=${headSha.slice(0, 9)} services=${plans.length} `
    + `reads=${plans.length} elapsed=${Math.round(elapsedMs / 1000)}s `
    + `mode=${dryRun ? 'dry-run' : 'deploy'} ${JSON.stringify(summary.counts)}`,
  );
  for (const plan of summary.unreadable) {
    // ::warning:: not ::error::, unless every service failed (summary.ok).
    const level = summary.ok ? 'warning' : 'error';
    console.error(`::${level}::${plan.service}: ${plan.detail}`);
  }
  for (const plan of summary.deploys) {
    if (!dryRun && !plan.deploymentId) {
      // ::error:: so the failing SERVICE and its reason reach the Actions
      // summary and the PR checks panel. A plain console.error reds the run but
      // names nothing until someone opens the raw log, and this is the one
      // outcome an operator has to act on: a deploy that was supposed to happen
      // and did not.
      console.error(`::error::${plan.service} was not deployed [${plan.reason}]: ${plan.error}`);
      continue;
    }
    console.log(`- ${dryRun ? 'would deploy' : `deployed (${plan.deploymentId})`}: ${plan.service} [${plan.reason}] ${plan.detail}`);
  }
  if (summary.deploys.length === 0) {
    console.log(`No service needs a build for ${headSha.slice(0, 9)} — Railway already took it or nothing reaching them changed.`);
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const asJson = process.argv.includes('--json');
  const environment = readArgument(process.argv, '--environment', DEFAULT_ENVIRONMENT);
  const window = Number(readArgument(process.argv, '--window', String(DEFAULT_DEPLOYMENT_WINDOW)));
  const concurrency = Number(readArgument(process.argv, '--concurrency', String(DEFAULT_CONCURRENCY)));
  if (!Number.isInteger(window) || window <= 0) throw new Error('--window must be a positive integer');
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error('--concurrency must be a positive integer');
  // origin/main, never the local checkout's HEAD. This is the only script in
  // the repository that mutates production, and the runbook tells an operator to
  // run it with --only <service> from wherever they happen to be standing — so a
  // HEAD default would deploy an unmerged branch, or uncommitted-adjacent work,
  // straight to production.
  const startedAt = Date.now();
  const headSha = readArgument(process.argv, '--head', null) ?? runGit(['rev-parse', 'origin/main']);
  // And whatever was passed must actually be on main. A SHA that is not reachable
  // from origin/main has not been through the gates this workflow exists to honour.
  if (!dryRun) {
    try {
      runGit(['merge-base', '--is-ancestor', headSha, 'origin/main']);
    } catch {
      throw new Error(
        `refusing to deploy ${headSha.slice(0, 9)}: it is not reachable from origin/main. `
        + 'Fetch main, or pass --head with a merged commit.',
      );
    }
  }

  const registryByService = readRegistryByService();
  const fleet = readRepositoryServices(environment);
  if (fleet.length === 0) {
    throw new Error('the Railway service query returned no repository services, which is a query failure rather than an empty fleet');
  }
  const repositoryServices = selectServices(fleet, readArgument(process.argv, '--only', null));
  // readEnvironmentConfig fails closed on an unexpected payload; see its comment.
  const liveById = readEnvironmentConfig(environment).services;
  const changedPathsSince = createChangedPathsReader(headSha, { git: runGit });
  // `git merge-base --is-ancestor` exits non-zero both when the answer is no and
  // when the object is missing. Both collapse to "cannot prove it", which keeps
  // the service reported rather than rolled back onto an older commit.
  const isAncestor = (ancestor, descendant) => {
    try {
      runGit(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  };

  const plans = (await mapWithConcurrency(repositoryServices, concurrency, async (service) => {
    let deployments = null;
    let readError = null;
    try {
      deployments = await readDeployments(service, environment, window);
    } catch (error) {
      // Keep the reason. A bare catch reds the run with "the deployment history
      // could not be read" and no way to tell a 429 from an auth failure.
      readError = error instanceof Error ? error.message : String(error);
    }
    return planServiceDeploy({
      service: service.name,
      serviceId: service.id,
      closure: resolveServiceClosure({
        registryEntry: registryByService.get(service.name) ?? null,
        liveService: liveById[service.id] ?? null,
      }),
      deployments,
      headSha,
      changedPathsSince,
      readError,
      isAncestor,
    });
  })).sort((left, right) => left.service.localeCompare(right.service));

  const summary = summarizeDeployPlan(plans);
  if (!dryRun && summary.deploys.length > 0) {
    const environmentId = resolveEnvironmentId(environment);
    // Serial on purpose: this is the only mutating call in the script, and a
    // burst of parallel deploys against one project is how a rate limit turns a
    // partial catch-up into a silent one.
    for (const plan of summary.deploys) {
      try {
        plan.deploymentId = readDeploymentId(runRailway(buildDeployArgs({
          serviceId: plan.serviceId,
          environmentId,
          commitSha: headSha,
        })));
      } catch (error) {
        plan.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;
  if (asJson) console.log(JSON.stringify({ environment, headSha, dryRun, elapsedMs, railwayReads: plans.length, summary, plans }, null, 2));
  else printReport(plans, summary, headSha, { dryRun, elapsedMs });

  // Hard-fail only on work that was supposed to happen and did not: a deploy
  // call that errored or returned no deployment id, or a run in which nothing
  // could be read at all. An individual unreadable service is warned about
  // above and left to the drift check.
  const failed = summary.deploys.filter((plan) => !dryRun && !plan.deploymentId);
  if (!summary.ok || failed.length > 0) process.exitCode = 1;
}

// realpath BOTH sides: Node sets import.meta.url to the realpath while argv[1]
// keeps the symlink, so on a symlinked checkout a bare comparison makes this
// script exit 0 having deployed nothing.
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
