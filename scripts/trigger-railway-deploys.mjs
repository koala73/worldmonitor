#!/usr/bin/env node

// Builds the services a merge actually changed, from CI, where we own the
// decision and can test it (#6142).
//
// WHY THIS EXISTS
//
// Railway decides on its own whether a push produces a build, and it takes two
// separate decisions. The watch-path one is fine: re-measured across the whole
// 77-service fleet over 600 commits of main, 7,331 of 7,391 path-reason skips
// were plainly correct, 57 more were correct once the build context is taken
// into account, and the last 3 were the registry declaring a closure Railway
// had not been given yet. That is not the defect #6141 took it for.
//
// The other decision is the problem. Railway also refuses to build a commit
// whose GitHub check suite is failing, and it reads the WHOLE suite — including
// scheduled workflows that re-report onto main's head SHA long after the merge
// gates went green. The freshness monitor, the security audit and the storage
// monitor all do this. Measured over the same window that accounts for 1,068 of
// 6,037 closure-relevant merges, with p90 4.7h to a build against p90 0.01h
// when Railway simply builds, and 93 that never built at all inside the window.
// It is also self-reinforcing: the freshness monitor turns red precisely when
// the fleet is behind, and its redness then blocks the fleet from catching up.
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

import { execFile, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  RAILWAY_CALL_TIMEOUT_MS,
  isRepositoryService,
  readArgument,
  runRailway,
} from './audit-railway-watch-paths.mjs';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_DEPLOYMENT_WINDOW,
  RUNNING_STATUSES,
  mapWithConcurrency,
} from './check-railway-deploy-drift.mjs';
import {
  changeReachesService,
  createChangedPathsReader,
  pathsReachingService,
  resolveServiceClosure,
} from './railway-deploy-closure.mjs';

const DEFAULT_ENVIRONMENT = 'production';
const REGISTRY_URL = new URL('./railway-services.json', import.meta.url);

// A build that is queued, running, finished or even failed for the head commit
// all mean the same thing here: Railway has taken this commit, so triggering a
// second build of it would only duplicate work or bury a failure.
export const HANDLED_BY_RAILWAY = 'ALREADY_TAKEN';

// Deploying is the safe direction, so every "we could not tell" resolves here.
export const DEPLOY_REASONS = Object.freeze({
  CLOSURE_CHANGED: 'a change that reaches this service landed since the commit it is running',
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
}) {
  const base = { service, serviceId, runningSha: null, matchedPaths: [] };
  if (!Array.isArray(deployments)) {
    // Never guess in either direction on a failed query: deploying would mutate
    // production on no information, and skipping would claim this service was
    // considered. Surface it and fail the run.
    return { ...base, action: 'error', reason: 'the deployment history could not be read' };
  }

  const ordered = [...deployments].sort(
    (left, right) => Date.parse(right?.createdAt ?? 0) - Date.parse(left?.createdAt ?? 0),
  );

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

  const running = ordered.find((deployment) => RUNNING_STATUSES.includes(deployment?.status));
  const runningSha = running?.meta?.commitHash ?? null;
  if (!runningSha) {
    return {
      ...base,
      action: 'deploy',
      reason: 'UNKNOWN_SOURCE',
      detail: DEPLOY_REASONS.UNKNOWN_SOURCE,
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

export function summarizeDeployPlan(plans) {
  const deploys = plans.filter((plan) => plan.action === 'deploy');
  const errors = plans.filter((plan) => plan.action === 'error');
  const counts = {};
  for (const plan of plans) counts[plan.reason] = (counts[plan.reason] ?? 0) + 1;
  return { counts, deploys, errors, ok: errors.length === 0 };
}

const GIT_CALL_TIMEOUT_MS = 30_000;

function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: GIT_CALL_TIMEOUT_MS });
  if (result.signal) throw new Error(`git ${args.join(' ')} timed out`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

const execFileAsync = promisify(execFile);

async function readDeployments(service, environment, window) {
  const { stdout } = await execFileAsync('railway', [
    'deployment', 'list',
    '--service', service.id ?? service.name,
    '--environment', environment,
    '--limit', String(window),
    '--json',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: RAILWAY_CALL_TIMEOUT_MS });
  return JSON.parse(stdout);
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

function printReport(plans, summary, headSha, { dryRun }) {
  console.log(`Railway deploy trigger: head=${headSha.slice(0, 9)} services=${plans.length} mode=${dryRun ? 'dry-run' : 'deploy'} ${JSON.stringify(summary.counts)}`);
  for (const plan of summary.errors) {
    console.error(`- ${plan.service}: ${plan.reason}`);
  }
  for (const plan of summary.deploys) {
    const prefix = dryRun ? 'would deploy' : plan.deploymentId ? `deployed (${plan.deploymentId})` : 'FAILED to deploy';
    const line = `- ${prefix}: ${plan.service} [${plan.reason}] ${plan.detail}`;
    if (!dryRun && !plan.deploymentId) console.error(`${line} — ${plan.error}`);
    else console.log(line);
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
  const headSha = readArgument(process.argv, '--head', null) ?? runGit(['rev-parse', 'HEAD']).trim();

  const registryByService = readRegistryByService();
  const services = JSON.parse(runRailway(['service', 'list', '--environment', environment, '--json']));
  if (!Array.isArray(services)) throw new Error('railway service list must return an array');
  const fleet = services.filter(isRepositoryService);
  if (fleet.length === 0) {
    throw new Error('the Railway service query returned no repository services, which is a query failure rather than an empty fleet');
  }
  const repositoryServices = selectServices(fleet, readArgument(process.argv, '--only', null));
  const config = JSON.parse(runRailway(['environment', 'config', '--environment', environment, '--json']));
  const liveById = config?.services ?? {};
  const changedPathsSince = createChangedPathsReader(headSha, { git: runGit });

  const plans = (await mapWithConcurrency(repositoryServices, concurrency, async (service) => {
    let deployments = null;
    try {
      deployments = await readDeployments(service, environment, window);
    } catch {
      deployments = null;
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

  if (asJson) console.log(JSON.stringify({ environment, headSha, dryRun, summary, plans }, null, 2));
  else printReport(plans, summary, headSha, { dryRun });

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
