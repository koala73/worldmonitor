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
// Ordinary runs do not re-trigger a build that Railway already ran and FAILED.
// That is a real failure that scripts/check-railway-deploy-drift.mjs reports;
// retrying it automatically would bury the alarm under a retry loop. A
// controller-authorized manual recovery may retry that exact failed head once.
//
// Usage:
//   node scripts/trigger-railway-deploys.mjs
//   node scripts/trigger-railway-deploys.mjs --dry-run --json
//   node scripts/trigger-railway-deploys.mjs --head <sha> --environment production
//   node scripts/trigger-railway-deploys.mjs --only seed-earthquakes,seed-aviation

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_CONCURRENCY,
  mapWithConcurrency,
  readArgument,
  readDeployments,
  readDeploymentsForFleet,
  readEnvironmentConfig,
  resolveEnvironmentId,
  readRepositoryServices,
  runGit,
  runRailway,
} from './railway-cli.mjs';
import {
  FAILED_STATUSES,
  IN_FLIGHT_STATUSES,
  REJECTED_STATUS,
  RUNNING_STATUSES,
  createFleetAccumulator,
  isKnownStatus,
  newestRunning,
  orderByRecency,
} from './railway-deployments.mjs';
import {
  changeReachesService,
  createAncestryResolver,
  createChangedPathsReader,
  pathsReachingService,
  resolveServiceClosure,
} from './railway-deploy-closure.mjs';
import {
  ControlPlaneError,
  RailwayReconcileControlClient,
} from './railway-reconcile-control-client.mjs';
import {
  createIntentManifest,
  createResultManifest,
} from './railway-reconcile-manifest.mjs';

const DEFAULT_ENVIRONMENT = 'production';
const REGISTRY_URL = new URL('./railway-services.json', import.meta.url);
const TARGET_WORKFLOW_FILE = 'railway-deploy-trigger.yml';
const RESULT_STATUS_VERSION = 1;

export const MUTATION_MIN_TTL_MS = 5 * 60 * 1_000;
export const PINNED_RAILWAY_CLI = '@railway/cli@5.30.1';
const NPM_INSTALL_ENV_KEYS = Object.freeze([
  'CI',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'RUNNER_TEMP',
  'RUNNER_TOOL_CACHE',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'NPM_CONFIG_CACHE',
  'npm_config_cache',
]);
const GITHUB_CLI_ENV_KEYS = Object.freeze([
  'GH_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_TOKEN',
  'GITHUB_API_URL',
  'GITHUB_TOKEN',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
]);
export const SAFE_ACQUIRE_DEFERRALS = new Set([
  'LEASE_HELD',
  'DISPATCH_HOLD_ACTIVE',
  'MUTATION_BARRIER_ACTIVE',
  'VERIFICATION_PENDING',
]);
export const FAILING_ACQUIRE_DEFERRALS = new Set([
  'MUTATION_BARRIER_ACTIVE',
]);

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

// For ordinary planning, a build that is queued, running, finished or failed
// for the head commit means Railway has taken it. A controller-authorized
// recovery treats the newest unresolved FAILED record differently while still
// adopting active work and a newer running replacement.
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
  retryFailedHead = false,
  // Tri-state: 'yes' | 'no' | 'unknown'. Used to refuse deploying a service
  // BACKWARDS. Defaults to 'unknown', which REFUSES rather than deploys — the
  // one place in this script where uncertainty must not resolve toward
  // deploying, because deploying over a commit you cannot evaluate is how
  // production moves backwards.
  ancestry = () => 'unknown',
}) {
  const base = {
    service,
    serviceId,
    runningSha: null,
    observedDeploymentId: null,
    matchedPaths: [],
  };
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

  // A record for head in a status we RECOGNISE as non-refusal normally means
  // Railway has taken this commit — queued it, built it, or built it and
  // failed. This also subsumes "the service is already running head". SKIPPED
  // is excluded on purpose: that record IS the refusal this script exists to
  // compensate.
  //
  // "Recognise" is load-bearing. `status !== 'SKIPPED'` treats every UNKNOWN
  // status as handled, and Railway's enum already carries two this file does
  // not classify: NEEDS_APPROVAL (a deployment waiting on a human) and
  // REMOVING. Under the loose test, a service whose head deployment sits in
  // NEEDS_APPROVAL reads as "Railway has it" on every run forever, and the
  // trigger never retries — the unmatched case silently meaning HEALTHY, which
  // is the failure this whole change exists to remove.
  const forHead = ordered.filter((deployment) => deployment?.meta?.commitHash === headSha);
  const failedHeadIndex = retryFailedHead
    ? forHead.findIndex((deployment) => FAILED_STATUSES.includes(deployment.status))
    : -1;
  const retryingFailedHead = failedHeadIndex >= 0;
  const failedHeadDetail = `protected recovery is replacing failed ${headSha.slice(0, 9)}`;
  const taken = retryingFailedHead
    ? forHead.find((deployment, index) => (
      // In-flight work is active regardless of creation order. A running
      // deployment is a replacement only when it is newer than the failure;
      // an older success does not clear the failed-build alarm.
      IN_FLIGHT_STATUSES.includes(deployment.status)
      || (index < failedHeadIndex && RUNNING_STATUSES.includes(deployment.status))
    ))
    : forHead.find((deployment) => (
      deployment.status !== REJECTED_STATUS && isKnownStatus(deployment.status)
    ));
  if (taken) {
    return {
      ...base,
      observedDeploymentId: typeof taken.id === 'string' ? taken.id : null,
      action: 'skip',
      reason: HANDLED_BY_RAILWAY,
      detail: `Railway already has ${headSha.slice(0, 9)} (${taken.status})`,
    };
  }
  const unclassified = forHead.find((deployment) => !isKnownStatus(deployment.status));
  if (unclassified) {
    // Railway has SOMETHING for head that this script cannot read. Deploying
    // again could duplicate an approval or fight a transition; skipping quietly
    // strands the service. Report it and let a human decide — the drift check
    // reports the same record as UNKNOWN_STATUS independently.
    return {
      ...base,
      action: 'report',
      reason: 'UNKNOWN_STATUS',
      detail: `Railway reports ${unclassified.status} for ${headSha.slice(0, 9)}, which this script cannot classify — not deploying over it, and not calling it handled`,
    };
  }

  const running = newestRunning(ordered);
  if (!running) {
    if (retryingFailedHead) {
      return {
        ...base,
        action: 'deploy',
        reason: 'FAILED_HEAD_RETRY',
        detail: failedHeadDetail,
      };
    }
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
      reason: retryingFailedHead ? 'FAILED_HEAD_RETRY' : 'UNKNOWN_SOURCE',
      detail: retryingFailedHead
        ? failedHeadDetail
        : DEPLOY_REASONS.UNKNOWN_SOURCE,
    };
  }
  // PROVE forward motion before deploying anything.
  //
  // `git diff A..B` is non-empty in BOTH directions, so "this service is
  // missing paths" is not evidence that head is newer than what it runs. The
  // only safe basis is ancestry, and it has to be tri-state: a commit this
  // checkout cannot reach is NOT the same as a commit that is not an ancestor.
  // Railway builds a merge in seconds, so a commit that landed after checkout
  // and was built immediately is ordinary — and treating "cannot reach" as
  // "not an ancestor" deploys head over it, rolling production backwards.
  const runningToHead = ancestry(runningSha, headSha);
  if (runningToHead === 'unknown') {
    return {
      ...base,
      runningSha,
      action: 'skip',
      reason: 'ANCESTRY_UNKNOWN',
      detail: `running ${runningSha.slice(0, 9)}, which this checkout cannot reach even after fetching — refusing to deploy ${headSha.slice(0, 9)} over a commit whose age cannot be established`,
    };
  }
  if (runningToHead === 'no') {
    // Head is not a descendant of what it runs. Either the service is AHEAD
    // (main moved after this run read it) or the two have diverged.
    const headToRunning = ancestry(headSha, runningSha);
    return {
      ...base,
      runningSha,
      observedDeploymentId: headToRunning === 'yes' && typeof running.id === 'string'
        ? running.id
        : null,
      action: 'skip',
      reason: headToRunning === 'yes' ? 'AHEAD' : 'DIVERGED',
      detail: headToRunning === 'yes'
        ? `running ${runningSha.slice(0, 9)}, a descendant of ${headSha.slice(0, 9)} — main moved after this run read it`
        : `running ${runningSha.slice(0, 9)}, which is neither an ancestor nor a descendant of ${headSha.slice(0, 9)} — the branch was rewritten, and deploying either way is a decision nobody made here`,
    };
  }

  // runningToHead === 'yes': head provably contains what the service runs, so
  // any deploy from here moves it forward.
  if (retryingFailedHead) {
    return {
      ...base,
      runningSha,
      action: 'deploy',
      reason: 'FAILED_HEAD_RETRY',
      detail: failedHeadDetail,
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
  // Neither deployed nor dismissed: Railway has a record this script cannot
  // classify. Surfaced so it cannot become a silent skip.
  const needsAttention = plans.filter((plan) => plan.action === 'report');
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
    needsAttention,
    errors: allUnreadable ? unreadable : [],
    ok: !allUnreadable,
  };
}

export const RECOVERY_HOLD_WAIT_MS = 2 * 60 * 1_000;
export const RECOVERY_HOLD_POLL_MS = 5 * 1_000;

export class ReconcileDeferral extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconcileDeferral';
    this.code = code;
  }
}

export class ReconcileAuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconcileAuthorizationError';
    this.code = code;
  }
}

export function assertWorkflowMutationAuthority({
  dryRun,
  argv = process.argv,
  env = process.env,
}) {
  if (dryRun) return;
  if (!argv.includes('--workflow-authorized')) {
    throw new Error('direct Railway mutation is forbidden; use the protected Railway Deploy Trigger workflow');
  }
  if (env.GITHUB_ACTIONS !== 'true'
    || env.GITHUB_REF !== 'refs/heads/main'
    || env.RAILWAY_RECONCILE_CUTOVER_ACTIVE !== 'true') {
    throw new Error('Railway mutation requires the active protected main workflow');
  }
  const workflowRef = String(env.GITHUB_WORKFLOW_REF ?? '');
  if (!workflowRef.includes(`/.github/workflows/${TARGET_WORKFLOW_FILE}@`)) {
    throw new Error(`Railway mutation authority belongs only to ${TARGET_WORKFLOW_FILE}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(env.GITHUB_REPOSITORY ?? ''))
    || !/^[1-9][0-9]{0,23}$/.test(String(env.GITHUB_RUN_ID ?? ''))
    || !/^[1-9][0-9]{0,3}$/.test(String(env.GITHUB_RUN_ATTEMPT ?? ''))) {
    throw new Error('Railway mutation requires an exact GitHub repository, run, and attempt identity');
  }
}

function selectEnvironment(env, keys) {
  return Object.fromEntries(keys.flatMap((key) => (
    typeof env?.[key] === 'string' ? [[key, env[key]]] : []
  )));
}

export function createRailwayCliInstallEnv(env = process.env) {
  return selectEnvironment(env, NPM_INSTALL_ENV_KEYS);
}

export function createGitHubCliEnv(env = process.env) {
  return selectEnvironment(env, GITHUB_CLI_ENV_KEYS);
}

export function installPinnedRailwayCli({ spawn = spawnSync, env = process.env } = {}) {
  const result = spawn('npm', ['install', '--global', PINNED_RAILWAY_CLI], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 2 * 60 * 1_000,
    env: createRailwayCliInstallEnv(env),
  });
  if (result.signal) throw new Error('pinned Railway CLI installation timed out');
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pinned Railway CLI installation failed (${result.status})`);
  }
}

export function runGitHubApi(path, env, { spawn = spawnSync, attempts = 3 } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new TypeError('GitHub API attempts must be an integer from 1 through 5');
  }
  const githubEnv = createGitHubCliEnv(env);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawn('gh', ['api', path], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15_000,
      env: githubEnv,
    });
    if (!result.signal && !result.error && result.status === 0) {
      try {
        return JSON.parse(result.stdout);
      } catch {
        // A truncated or non-JSON response is a transient unreadable read. Retry.
      }
    }
  }
  throw new ReconcileAuthorizationError(
    'GITHUB_STATE_UNREADABLE',
    'current GitHub authorization state could not be read after bounded retries',
  );
}

export function readExactCurrentMainAuthorization({
  repository,
  headSha,
  env = process.env,
  api = (path) => runGitHubApi(path, env),
  now = Date.now,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new TypeError('exact-current-main authorization requires a repository and lowercase SHA');
  }
  const ref = api(`repos/${repository}/git/ref/heads/main`);
  const currentHead = ref?.object?.sha;
  if (currentHead !== headSha) {
    throw new ReconcileAuthorizationError('MAIN_MOVED', 'main moved away from the frozen reconciliation head');
  }
  const statuses = api(`repos/${repository}/commits/${headSha}/statuses?per_page=100`);
  if (!Array.isArray(statuses)) {
    throw new ReconcileAuthorizationError('GITHUB_STATE_UNREADABLE', 'main gate history was not an array');
  }
  const newestGate = statuses.find((status) => status?.context === 'gate');
  if (newestGate?.state !== 'success') {
    throw new ReconcileAuthorizationError('GATE_NOT_GREEN', 'the newest exact-head gate is not successful');
  }
  const observedAt = new Date(now()).toISOString();
  return {
    gateContext: 'gate',
    gateState: 'success',
    gateObservedAt: observedAt,
    mainObservedAt: observedAt,
  };
}

export function readCurrentMainLineageAuthorization({
  repository,
  headSha,
  env = process.env,
  api = (path) => runGitHubApi(path, env),
  now = Date.now,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new TypeError('current-main lineage authorization requires a repository and lowercase SHA');
  }

  const readMainHead = () => {
    const currentHead = api(`repos/${repository}/git/ref/heads/main`)?.object?.sha;
    if (!/^[0-9a-f]{40}$/.test(currentHead ?? '')) {
      throw new ReconcileAuthorizationError(
        'GITHUB_STATE_UNREADABLE',
        'current main did not resolve to a lowercase SHA',
      );
    }
    return currentHead;
  };

  const currentHead = readMainHead();
  const statuses = api(`repos/${repository}/commits/${currentHead}/statuses?per_page=100`);
  if (!Array.isArray(statuses)) {
    throw new ReconcileAuthorizationError('GITHUB_STATE_UNREADABLE', 'current main gate history was not an array');
  }
  const newestGate = statuses.find((status) => status?.context === 'gate');
  if (newestGate?.state !== 'success') {
    throw new ReconcileAuthorizationError('GATE_NOT_GREEN', 'the newest current-main gate is not successful');
  }

  if (currentHead !== headSha) {
    const comparison = api(`repos/${repository}/compare/${headSha}...${currentHead}`);
    if (typeof comparison?.status !== 'string'
      || !/^[0-9a-f]{40}$/.test(comparison?.merge_base_commit?.sha ?? '')) {
      throw new ReconcileAuthorizationError(
        'GITHUB_STATE_UNREADABLE',
        'current-main lineage comparison was unreadable',
      );
    }
    if (comparison.status !== 'ahead' || comparison.merge_base_commit.sha !== headSha) {
      throw new ReconcileAuthorizationError(
        'MAIN_DIVERGED',
        'current main is not a descendant of the frozen reconciliation head',
      );
    }
  }

  if (readMainHead() !== currentHead) {
    throw new ReconcileAuthorizationError(
      'MAIN_MOVED',
      'main moved while the reconciliation lineage was being verified',
    );
  }

  const observedAt = new Date(now()).toISOString();
  return {
    gateContext: 'gate',
    gateState: 'success',
    gateObservedAt: observedAt,
    mainObservedAt: observedAt,
    attemptedHeadSha: headSha,
    currentMainHeadSha: currentHead,
    lineage: currentHead === headSha ? 'EXACT' : 'DESCENDANT',
  };
}

function closedReason(plan, fallback = 'PLAN_SKIPPED') {
  if (typeof plan?.reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(plan.reason)) {
    return plan.reason;
  }
  if (plan?.action === 'error') return 'HISTORY_UNAVAILABLE';
  if (plan?.action === 'report') return 'UNKNOWN_STATUS';
  return fallback;
}

function plannedAction(plan) {
  if (plan.action === 'deploy') return 'DEPLOY';
  if (plan.observedDeploymentId) return 'ADOPT';
  return 'SKIP';
}

export function createPlannedManifestEntries(plans) {
  return plans.map((plan) => ({
    service: plan.service,
    serviceId: plan.serviceId,
    action: plannedAction(plan),
    reason: closedReason(plan),
  }));
}

function resultEntry(plan, action, {
  outcome,
  deploymentId = null,
  observedDeploymentId = null,
  reason = closedReason(plan),
} = {}) {
  return {
    service: plan.service,
    serviceId: plan.serviceId,
    action,
    outcome,
    deploymentId,
    observedDeploymentId,
    reason,
  };
}

function noMutationEntry(plan, action = plannedAction(plan), reason = closedReason(plan)) {
  if (plan.observedDeploymentId) {
    return resultEntry(plan, action, {
      outcome: 'ALREADY_ACTIVE',
      observedDeploymentId: plan.observedDeploymentId,
      reason,
    });
  }
  return resultEntry(plan, action, { outcome: 'SKIPPED', reason });
}

function resultOutcome(entries) {
  if (entries.some((entry) => entry.outcome === 'AMBIGUOUS')) return 'MUTATION_AMBIGUOUS';
  if (entries.some((entry) => entry.outcome === 'FAILED')) return 'MUTATION_PARTIAL';
  if (entries.some((entry) => entry.outcome === 'TRIGGERED')) return 'MUTATION_COMPLETED';
  return 'NO_MUTATION';
}

function safeAcquireDeferral(error) {
  return error instanceof ControlPlaneError
    && error.definitive
    && SAFE_ACQUIRE_DEFERRALS.has(error.code);
}

export async function runLeasedReconcile({
  control,
  ownerId,
  headSha,
  recoveryAttemptId = null,
  producer,
  authorizeCurrent,
  buildPlan,
  refreshService,
  deployService,
  writeResult,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  recoveryHoldWaitMs = RECOVERY_HOLD_WAIT_MS,
  recoveryHoldPollMs = RECOVERY_HOLD_POLL_MS,
}) {
  for (const callback of [authorizeCurrent, buildPlan, refreshService, deployService, writeResult]) {
    if (typeof callback !== 'function') throw new TypeError('leased reconciliation callbacks must be functions');
  }
  const acquireStartedAt = now();
  let authorization;
  let acquisition;
  while (!acquisition) {
    authorization = await authorizeCurrent();
    try {
      acquisition = (await control.acquire({
        ownerId,
        headSha,
        ...(recoveryAttemptId ? { recoveryAttemptId } : {}),
        runId: producer.runId,
        runAttempt: producer.runAttempt,
      })).data;
    } catch (error) {
      const mayWaitForBoundHold = recoveryAttemptId
        && error instanceof ControlPlaneError
        && error.definitive
        && error.code === 'DISPATCH_HOLD_ACTIVE'
        && now() - acquireStartedAt < recoveryHoldWaitMs;
      if (mayWaitForBoundHold) {
        await sleep(Math.min(recoveryHoldPollMs, recoveryHoldWaitMs - (now() - acquireStartedAt)));
        continue;
      }
      if (safeAcquireDeferral(error)) {
        throw new ReconcileDeferral(error.code, 'another durable reconciliation state currently owns admission');
      }
      throw error;
    }
  }

  const attempt = acquisition.attempt;
  const ownerFields = {
    attemptId: attempt.attemptId,
    ownerId,
    leaseCapability: acquisition.leaseCapability,
    headSha,
  };
  let operationError = null;
  let completed = null;
  try {
    const retryFailedHead = recoveryAttemptId !== null
      && acquisition.dispatchHold?.recoveryAttemptId === recoveryAttemptId
      && acquisition.dispatchHold?.headSha === headSha
      && acquisition.dispatchHold?.state === 'LEASE_ACQUIRED'
      && acquisition.dispatchHold?.linkedAttemptId === attempt.attemptId
      && acquisition.dispatchHold?.failedHeadRetryAuthorized === true;
    const context = await buildPlan({ retryFailedHead });
    const plans = [...context.plans].sort((left, right) => left.service.localeCompare(right.service));
    const intent = createIntentManifest({
      attemptId: attempt.attemptId,
      producer,
      headSha,
      projectId: context.projectId,
      environmentId: context.environmentId,
      owner: ownerId,
      recoveryAttemptId,
      plannedServices: createPlannedManifestEntries(plans),
      authorization,
      createdAt: new Date(now()).toISOString(),
    });
    await control.prepare({ ...ownerFields, intentDigest: intent.intentDigest });

    const actions = new Map(intent.plannedServices.map((entry) => [entry.service, entry.action]));
    const entries = [];
    let mutationStarted = false;
    let stopReason = null;
    for (const plan of plans) {
      const action = actions.get(plan.service);
      if (stopReason) {
        entries.push(resultEntry(plan, action, { outcome: 'SKIPPED', reason: stopReason }));
        continue;
      }
      if (plan.action !== 'deploy') {
        entries.push(noMutationEntry(plan, action));
        continue;
      }

      let fresh;
      try {
        await control.assertLease({ ...ownerFields, minTtlMs: MUTATION_MIN_TTL_MS });
        await authorizeCurrent();
        fresh = await refreshService(plan);
      } catch (error) {
        const reason = error instanceof ReconcileAuthorizationError
          ? error.code
          : error instanceof ControlPlaneError
            ? 'LEASE_OWNERSHIP_LOST'
            : 'HISTORY_UNAVAILABLE';
        entries.push(resultEntry(plan, action, {
          // This fence failed before this service's provider call. Earlier
          // triggers remain exact evidence, but this service is deliberately
          // untouched rather than a failed or ambiguous mutation.
          outcome: 'SKIPPED',
          reason,
        }));
        stopReason = mutationStarted ? 'STOPPED_AFTER_FENCE' : reason;
        continue;
      }

      if (fresh.action !== 'deploy') {
        entries.push(noMutationEntry(fresh, action));
        if (fresh.observedDeploymentId) {
          plan.alreadyActiveDeploymentId = fresh.observedDeploymentId;
        }
        continue;
      }

      if (!mutationStarted) {
        await control.startMutation({
          ...ownerFields,
          intentDigest: intent.intentDigest,
          minTtlMs: MUTATION_MIN_TTL_MS,
        });
        mutationStarted = true;
      }
      try {
        const deploymentId = await deployService(plan, context);
        plan.deploymentId = deploymentId;
        entries.push(resultEntry(plan, action, {
          outcome: 'TRIGGERED',
          deploymentId,
          reason: closedReason(plan),
        }));
      } catch {
        entries.push(resultEntry(plan, action, {
          outcome: 'AMBIGUOUS',
          reason: 'TRIGGER_AMBIGUOUS',
        }));
        stopReason = 'STOPPED_AFTER_AMBIGUITY';
      }
    }

    const outcome = resultOutcome(entries);
    const result = createResultManifest({
      intent,
      outcome,
      entries,
      createdAt: new Date(now()).toISOString(),
    });
    await writeResult(result);
    await control.bindResult({
      ...ownerFields,
      intentDigest: intent.intentDigest,
      resultKind: mutationStarted ? 'MUTATED' : 'NO_MUTATION',
      resultDigest: result.resultDigest,
      minTtlMs: 1,
    });
    completed = { attempt, context, plans, intent, result };
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await control.release(ownerFields);
    } catch (releaseError) {
      if (!operationError) operationError = releaseError;
      else console.error('Owner-safe lease release also failed; durable expiry remains authoritative.');
    }
  }
  if (operationError) throw operationError;
  return completed;
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
  for (const plan of summary.needsAttention) {
    console.error(`::warning::${plan.service}: ${plan.detail}`);
  }
  for (const plan of summary.unreadable) {
    // ::warning:: not ::error::, unless every service failed (summary.ok).
    const level = summary.ok ? 'warning' : 'error';
    console.error(`::${level}::${plan.service}: ${plan.detail}`);
  }
  for (const plan of summary.deploys) {
    if (!dryRun && plan.alreadyActiveDeploymentId) {
      console.log(`- already active (${plan.alreadyActiveDeploymentId}): ${plan.service} [fresh provider recheck]`);
      continue;
    }
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

async function buildDeployPlanningContext({
  environment,
  window,
  concurrency,
  headSha,
  retryFailedHead = false,
}) {
  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('RAILWAY_PROJECT_ID is required');
  }
  const registryByService = readRegistryByService();
  const fleet = readRepositoryServices(environment);
  if (fleet.length === 0) {
    throw new Error('the Railway service query returned no repository services, which is a query failure rather than an empty fleet');
  }
  const repositoryServices = selectServices(fleet, readArgument(process.argv, '--only', null));
  const serviceById = new Map(repositoryServices.map((service) => [service.id, service]));
  // readEnvironmentConfig fails closed on an unexpected payload; see its comment.
  const liveById = readEnvironmentConfig(environment).services;
  const environmentId = resolveEnvironmentId(environment);
  // Merges that landed after the checkout are the main source of "this commit
  // is not in my history", and one fetch removes most of them before any
  // ancestry question is asked.
  try {
    runGit(['fetch', '--quiet', '--no-tags', 'origin', 'main']);
  } catch {
    // Best effort; the ancestry resolver still refuses rather than guesses.
  }
  const changedPathsSince = createChangedPathsReader(headSha, { git: runGit });
  const ancestry = createAncestryResolver({
    git: runGit,
    fetchMissing: (sha) => runGit(['fetch', '--quiet', '--no-tags', 'origin', sha]),
  });

  let headCommittedAt = Number.NEGATIVE_INFINITY;
  try {
    headCommittedAt = Number(runGit(['show', '-s', '--format=%ct', headSha])) * 1000;
  } catch {
    // Unknown head time means page to the service-coverage rule alone.
  }
  const histories = await readDeploymentsForFleet({
    services: repositoryServices,
    environment,
    environmentId,
    window,
    concurrency,
    notBefore: headCommittedAt,
    accumulatorFactory: createFleetAccumulator,
    onRoute: (route) => {
      console.error(route.route === 'fleet'
        ? `Read ${repositoryServices.length} service histories in ${route.pages} fleet page(s) (${route.records} records), ${route.fellBack} direct fallback(s).`
        : `Reading service histories one at a time: ${route.reason}`);
    },
  });

  const planFor = (service, deployments, readError = null) => planServiceDeploy({
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
    ancestry,
    retryFailedHead,
  });
  const plans = (await mapWithConcurrency(repositoryServices, concurrency, async (service) => {
    const { deployments, error: readError } = histories.get(service.id)
      ?? { deployments: null, error: 'no history was read for this service' };
    return planFor(service, deployments, readError);
  })).sort((left, right) => left.service.localeCompare(right.service));

  return {
    projectId,
    environmentId,
    plans,
    refreshService: async (plan) => {
      const service = serviceById.get(plan.serviceId);
      if (!service || service.name !== plan.service) {
        throw new Error('planned Railway service no longer matches the live fleet');
      }
      return planFor(service, await readDeployments(service, environment, window));
    },
  };
}

function writeStatus(path, value) {
  if (!path) return;
  writeFileSync(path, `${JSON.stringify({ version: RESULT_STATUS_VERSION, ...value })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const asJson = process.argv.includes('--json');
  const environment = readArgument(process.argv, '--environment', DEFAULT_ENVIRONMENT);
  const window = Number(readArgument(process.argv, '--window', String(DEFAULT_DEPLOYMENT_WINDOW)));
  const concurrency = Number(readArgument(process.argv, '--concurrency', String(DEFAULT_CONCURRENCY)));
  if (!Number.isInteger(window) || window <= 0) throw new Error('--window must be a positive integer');
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error('--concurrency must be a positive integer');
  assertWorkflowMutationAuthority({ dryRun });
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

  if (dryRun) {
    const context = await buildDeployPlanningContext({ environment, window, concurrency, headSha });
    const summary = summarizeDeployPlan(context.plans);
    const elapsedMs = Date.now() - startedAt;
    if (asJson) console.log(JSON.stringify({
      environment, headSha, dryRun, elapsedMs, railwayReads: context.plans.length, summary, plans: context.plans,
    }, null, 2));
    else printReport(context.plans, summary, headSha, { dryRun, elapsedMs });
    return;
  }

  const resultPath = readArgument(process.argv, '--result-manifest', null);
  const statusPath = readArgument(process.argv, '--status-file', null);
  if (!resultPath || !statusPath) {
    throw new Error('--result-manifest and --status-file are required for protected mutation');
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const producer = {
    repository,
    workflow: TARGET_WORKFLOW_FILE,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
  const ownerId = `github-run:${producer.runId}:${producer.runAttempt}`;
  const recoveryInput = readArgument(process.argv, '--recovery-attempt-id', null);
  const recoveryAttemptId = recoveryInput && recoveryInput !== 'none' ? recoveryInput : null;
  const control = new RailwayReconcileControlClient({
    role: 'mutation',
    secret: process.env.RAILWAY_RECONCILE_MUTATION_HMAC,
  });
  // The client owns the only required copy. Do not expose the mutation HMAC to
  // npm lifecycle scripts, the Railway CLI, gh, git, or any later subprocess.
  delete process.env.RAILWAY_RECONCILE_MUTATION_HMAC;
  let planningContext;
  let completed;
  try {
    completed = await runLeasedReconcile({
      control,
      ownerId,
      headSha,
      recoveryAttemptId,
      producer,
      authorizeCurrent: () => readExactCurrentMainAuthorization({ repository, headSha }),
      buildPlan: async ({ retryFailedHead }) => {
        // A runner-less job or a contender rejected by durable admission must
        // perform neither production setup nor Railway reads.
        installPinnedRailwayCli();
        planningContext = await buildDeployPlanningContext({
          environment,
          window,
          concurrency,
          headSha,
          // This capability comes from the immutable admitted hold. Watchdog
          // recovery IDs do not authorize replacing a failed deployment.
          retryFailedHead,
        });
        return planningContext;
      },
      refreshService: (plan) => planningContext.refreshService(plan),
      deployService: async (plan, context) => readDeploymentId(runRailway(buildDeployArgs({
        serviceId: plan.serviceId,
        environmentId: context.environmentId,
        commitSha: headSha,
      }))),
      writeResult: async (result) => {
        writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      },
    });
  } catch (error) {
    if (error instanceof ReconcileDeferral) {
      writeStatus(statusPath, { outcome: 'DURABLE_ADMISSION_DEFERRED', reason: error.code, manifestReady: false });
      console.log(`::notice::Railway reconciliation deferred by durable control state (${error.code}).`);
      if (FAILING_ACQUIRE_DEFERRALS.has(error.code)) process.exitCode = 1;
      return;
    }
    writeStatus(statusPath, { outcome: 'MUTATION_FAILED', manifestReady: false });
    throw error;
  }

  const summary = summarizeDeployPlan(completed.plans);
  const elapsedMs = Date.now() - startedAt;
  writeStatus(statusPath, {
    outcome: completed.result.outcome,
    manifestReady: true,
    attemptId: completed.attempt.attemptId,
  });
  if (asJson) console.log(JSON.stringify({
    environment,
    headSha,
    dryRun,
    elapsedMs,
    railwayReads: completed.plans.length,
    summary,
    plans: completed.plans,
    result: completed.result,
  }, null, 2));
  else printReport(completed.plans, summary, headSha, { dryRun, elapsedMs });
  if (!summary.ok || ['MUTATION_PARTIAL', 'MUTATION_AMBIGUOUS'].includes(completed.result.outcome)) {
    process.exitCode = 1;
  }
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
