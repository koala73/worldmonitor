#!/usr/bin/env node

// Alarms on "the merge never reached production", whatever the cause.
//
// Every repository gate can be green while a Railway service keeps running an
// older image: the watch-path filter refuses the push (#6141), the GitHub
// integration stops delivering it (#6064), or the build fails after the merge
// lands. None of those produce a repository signal, and the seeder's own health
// checks cannot see them either — a stale container publishes fresh-looking
// data from stale code.
//
// The check is deliberately independent of why. For every service this
// repository deploys it asks one question: is the source Railway is running the
// commit at the head of main? Anything that is not a positive yes is reported.
//
// Usage:
//   node scripts/check-railway-deploy-drift.mjs
//   node scripts/check-railway-deploy-drift.mjs --json
//   node scripts/check-railway-deploy-drift.mjs --head <sha> --window 200

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isRepositoryService, readArgument } from './audit-railway-watch-paths.mjs';
import { applyAcceptanceBaseline } from './check-seed-freshness.mjs';

const DEFAULT_ENVIRONMENT = 'production';
const BASELINE_URL = new URL('./railway-deploy-drift-baseline.json', import.meta.url);

// Railway records a refused push as a deployment whose status is SKIPPED and
// whose meta still carries the commit it refused. That record is the only
// evidence the push happened at all.
export const REJECTED_STATUS = 'SKIPPED';

// Statuses that prove an image was built from a source and deployed. REMOVED is
// a superseded deployment — for a cron service that is every completed tick —
// and CRASHED ran the code and exited non-zero, which is a runtime failure the
// seeder's own health checks own, not a source-drift one.
export const RUNNING_STATUSES = Object.freeze(['SUCCESS', 'REMOVED', 'CRASHED', 'SLEEPING']);

// A build that has started but has not produced a running container yet.
export const IN_FLIGHT_STATUSES = Object.freeze([
  'QUEUED',
  'WAITING',
  'INITIALIZING',
  'BUILDING',
  'DEPLOYING',
]);

// The build never produced an image, so the previous one is still serving —
// even though this record carries the newest commit SHA.
export const FAILED_STATUSES = Object.freeze(['FAILED']);

// Railway builds land in about two minutes. Thirty is a generous ceiling for a
// queued build on a busy project, chosen against the observed build duration
// rather than against this check's own cadence.
//
// The grace is spent on a COMMIT, never on a service: the caller resolves the
// newest commit older than this window and every service must be running that
// commit or a descendant. Excusing a service because head happens to be young
// would have gone green on the whole fleet on any run that followed a merge —
// including for umami, which has been 22 hours stale since #6064.
export const DEFAULT_BUILD_GRACE_MS = 30 * 60 * 1000;

// A */5 cron emits ~288 records a day, so this covers roughly ten hours on the
// busiest service and months on a weekly one. It only has to reach past the
// newest running deployment; anything older cannot change which source is live.
export const DEFAULT_DEPLOYMENT_WINDOW = 120;

// Everything that is not a positive "running the head commit" or "a build for
// it is under way". The list is derived from the two healthy verdicts rather
// than enumerated, so a verdict added later is a problem until someone decides
// otherwise — a scanner whose unmatched case means healthy cannot be fixed by
// adding cases.
const HEALTHY_VERDICTS = new Set(['CURRENT', 'AHEAD', 'PENDING_BUILD']);

export function isProblemVerdict(verdict) {
  return !HEALTHY_VERDICTS.has(verdict);
}

function isKnownStatus(status) {
  return status === REJECTED_STATUS
    || RUNNING_STATUSES.includes(status)
    || IN_FLIGHT_STATUSES.includes(status)
    || FAILED_STATUSES.includes(status);
}

function createdAtMs(deployment) {
  const parsed = Date.parse(deployment?.createdAt ?? '');
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Decide which source a single service is running, and whether that is head.
 *
 * `deployments` is the raw `railway deployment list --json` array; pass `error`
 * instead when the query itself failed.
 */
export function classifyServiceDeploy({
  service,
  deployments,
  error = null,
  headSha,
  // The newest commit that has been available longer than the build grace.
  // A service running this or a descendant is allowed to lag head. Defaults to
  // head, which is the strict reading — a caller that cannot resolve it gets
  // the stricter answer, not the more forgiving one.
  graceSha = headSha,
  // Whether `ancestor` is an ancestor of (or equal to) `descendant`. Used to
  // accept a service running something NEWER than the head we were handed —
  // observed on the first live run, where two services had already built a
  // commit the checkout did not contain, because main moved mid-run. Defaults
  // to "cannot prove it", so a caller without git history fails to noise.
  isAncestor = () => false,
}) {
  const base = {
    service,
    runningSha: null,
    runningAt: null,
    rejectedShas: [],
    unknownStatuses: [],
  };
  if (error || !Array.isArray(deployments)) {
    return { ...base, verdict: 'QUERY_FAILED', detail: error ?? 'deployment history was not an array' };
  }
  if (deployments.length === 0) {
    return { ...base, verdict: 'NO_DEPLOYMENTS', detail: 'Railway returned no deployments for this service' };
  }

  // Railway returns newest-first today. Sorting anyway costs nothing and keeps
  // "which deployment is live" from depending on an undocumented ordering.
  const ordered = [...deployments].sort((left, right) => createdAtMs(right) - createdAtMs(left));
  const running = ordered.find((deployment) => RUNNING_STATUSES.includes(deployment.status));
  const runningAtMs = running ? createdAtMs(running) : Number.NEGATIVE_INFINITY;
  const newerThanRunning = (deployment) => createdAtMs(deployment) > runningAtMs;

  // Only records newer than the running deployment can change which source is
  // live, so an unreadable status further back is not a reason to withhold a
  // verdict.
  const unknownStatuses = [
    ...new Set(
      ordered
        .filter((deployment) => !isKnownStatus(deployment.status) && newerThanRunning(deployment))
        .map((deployment) => deployment.status),
    ),
  ];
  if (unknownStatuses.length > 0) {
    return {
      ...base,
      verdict: 'UNKNOWN_STATUS',
      unknownStatuses,
      runningSha: running?.meta?.commitHash ?? null,
      runningAt: running?.createdAt ?? null,
      detail: `Railway reported ${unknownStatuses.join(', ')}, which this check cannot classify`,
    };
  }

  const rejectedShas = ordered
    .filter((deployment) => deployment.status === REJECTED_STATUS
      && deployment.meta?.commitHash
      && newerThanRunning(deployment))
    .map((deployment) => deployment.meta.commitHash);
  const identified = {
    ...base,
    runningSha: running?.meta?.commitHash ?? null,
    runningAt: running?.createdAt ?? null,
    rejectedShas,
  };

  if (rejectedShas.length > 0) {
    return {
      ...identified,
      verdict: 'REJECTED_PUSH',
      detail: `Railway refused ${rejectedShas.length} push(es) and has built nothing since: ${rejectedShas.map((sha) => sha.slice(0, 9)).join(', ')}`,
    };
  }
  if (!running) {
    return { ...identified, verdict: 'NO_BUILD_IN_WINDOW', detail: 'no deployment in the window ever reached a running state' };
  }
  if (!identified.runningSha) {
    return {
      ...identified,
      verdict: 'UNKNOWN_SOURCE',
      detail: `the running deployment carries no commit SHA (a \`railway up\` upload), so its source cannot be compared with ${headSha.slice(0, 9)}`,
    };
  }
  if (identified.runningSha === headSha) {
    return { ...identified, verdict: 'CURRENT', detail: null };
  }
  if (isAncestor(headSha, identified.runningSha)) {
    return {
      ...identified,
      verdict: 'AHEAD',
      detail: `running ${identified.runningSha.slice(0, 9)}, a descendant of ${headSha.slice(0, 9)} — main moved after this check read it`,
    };
  }

  const forHead = (statuses) => ordered.find((deployment) => statuses.includes(deployment.status)
    && deployment.meta?.commitHash === headSha);
  if (forHead(FAILED_STATUSES)) {
    return {
      ...identified,
      verdict: 'BUILD_FAILED',
      detail: `the build for ${headSha.slice(0, 9)} failed, so ${identified.runningSha.slice(0, 9)} is still serving`,
    };
  }
  if (forHead(IN_FLIGHT_STATUSES)) {
    return { ...identified, verdict: 'PENDING_BUILD', detail: `a build for ${headSha.slice(0, 9)} is under way` };
  }
  if (graceSha !== headSha && isAncestor(graceSha, identified.runningSha)) {
    return {
      ...identified,
      verdict: 'PENDING_BUILD',
      detail: `running ${identified.runningSha.slice(0, 9)}, which is current as of ${graceSha.slice(0, 9)}; only commits newer than the build grace are missing`,
    };
  }
  return {
    ...identified,
    verdict: 'BEHIND',
    detail: `running ${identified.runningSha.slice(0, 9)} from ${identified.runningAt}, which predates ${graceSha.slice(0, 9)} — no build and no rejection recorded`,
  };
}

/**
 * Split the fleet into what blocks and what is a known, owned degradation.
 *
 * The baseline split is `check-seed-freshness.mjs`'s, called with this check's
 * fields renamed onto its `name`/`status` contract. Reusing it rather than
 * reimplementing it keeps one definition of what an acknowledged problem is,
 * including the parts that are easy to get subtly wrong: expiry fails the run,
 * a recovered entry is reported but not fatal, and a service failing with a
 * DIFFERENT verdict than the one baselined blocks.
 */
export function summarizeDeployDrift(results, baseline = null, now = Date.now()) {
  const counts = {};
  for (const result of results) {
    counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;
  }
  const problems = results.filter((result) => isProblemVerdict(result.verdict));
  const empty = {
    counts,
    problems,
    blocking: problems,
    acknowledged: [],
    cleared: [],
    expired: false,
    expiresAt: null,
  };
  if (results.length === 0) {
    return {
      ...empty,
      ok: false,
      detail: 'no services to check — the Railway service query returned nothing, which is a query failure rather than a healthy fleet',
    };
  }
  const split = baseline
    ? applyAcceptanceBaseline(
      problems.map((problem) => ({ ...problem, name: problem.service, status: problem.verdict })),
      baseline,
      now,
    )
    : empty;
  const ok = split.blocking.length === 0 && !split.expired;
  return {
    counts,
    problems,
    blocking: split.blocking,
    acknowledged: split.acknowledged,
    cleared: split.cleared,
    expired: split.expired,
    expiresAt: split.expiresAt ?? null,
    ok,
    detail: ok
      ? `${results.length} service(s) are running the head commit or building it`
      : `${split.blocking.length} of ${results.length} service(s) are not running the head commit`,
  };
}

function runRailway(args) {
  const result = spawnSync('railway', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`railway ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function readRepositoryServices(environment) {
  const services = JSON.parse(runRailway(['service', 'list', '--environment', environment, '--json']));
  if (!Array.isArray(services)) throw new Error('railway service list must return an array');
  return services.filter(isRepositoryService);
}

function readDeployments(service, environment, window) {
  return JSON.parse(runRailway([
    'deployment',
    'list',
    '--service',
    service.id ?? service.name,
    '--environment',
    environment,
    '--limit',
    String(window),
    '--json',
  ]));
}

function printReport(results, summary, headSha, graceSha) {
  console.log(`Railway deploy-drift check: head=${headSha.slice(0, 9)} grace=${graceSha.slice(0, 9)} services=${results.length} ${JSON.stringify(summary.counts)}`);
  // The acknowledged and recovered lines come first and go to stdout: they are
  // never the reason a run fails, and burying them under the blocking list is
  // how a suppression that should have been pruned survives another month.
  for (const problem of summary.acknowledged) {
    console.log(`- acknowledged (#${problem.issue}): ${problem.service} [${problem.verdict}] ${problem.detail}`);
  }
  for (const entry of summary.cleared) {
    console.log(`- recovered: ${entry.name}:${entry.status} is running head again; remove it from scripts/railway-deploy-drift-baseline.json (#${entry.issue}).`);
  }
  if (summary.ok) {
    console.log(`Every service this repository deploys is running ${headSha.slice(0, 9)} or building it.`);
    return;
  }
  if (summary.blocking.length > 0) {
    console.error(`Railway deploy-drift check found ${summary.blocking.length} service(s) not running the head commit:`);
    for (const problem of summary.blocking) {
      console.error(`- ${problem.service} [${problem.verdict}] ${problem.detail}`);
    }
  } else {
    console.error(`- ${summary.detail}`);
  }
  if (summary.expired) {
    console.error(`Deploy-drift baseline expired on ${summary.expiresAt}; re-review scripts/railway-deploy-drift-baseline.json.`);
  }
}

async function main() {
  const asJson = process.argv.includes('--json');
  const environment = readArgument(process.argv, '--environment', DEFAULT_ENVIRONMENT);
  const window = Number(readArgument(process.argv, '--window', String(DEFAULT_DEPLOYMENT_WINDOW)));
  const graceMinutes = Number(
    readArgument(process.argv, '--grace-minutes', String(DEFAULT_BUILD_GRACE_MS / 60_000)),
  );
  if (!Number.isInteger(window) || window <= 0) throw new Error('--window must be a positive integer');
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0) throw new Error('--grace-minutes must be a non-negative number');

  const headSha = readArgument(process.argv, '--head', null) ?? runGit(['rev-parse', 'HEAD']);
  // `git merge-base --is-ancestor` exits non-zero both when the answer is no
  // and when the object is missing (a shallow checkout that never fetched the
  // commit). Both collapse to "cannot prove it", which keeps the service
  // reported rather than excused.
  const isAncestor = (ancestor, descendant) => {
    try {
      runGit(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  };
  // The newest commit that has been available longer than the build grace.
  // On a checkout too shallow to reach back that far, rev-list answers with
  // nothing and this falls back to head — the stricter reading.
  const graceCutoff = new Date(Date.now() - graceMinutes * 60_000).toISOString();
  let graceSha = headSha;
  try {
    graceSha = runGit(['rev-list', '-1', `--before=${graceCutoff}`, headSha]) || headSha;
  } catch {
    graceSha = headSha;
  }

  const services = readRepositoryServices(environment);
  const results = services.map((service) => {
    let deployments = null;
    let error = null;
    try {
      deployments = readDeployments(service, environment, window);
    } catch (queryError) {
      error = queryError instanceof Error ? queryError.message : String(queryError);
    }
    return classifyServiceDeploy({
      service: service.name,
      deployments,
      error,
      headSha,
      graceSha,
      isAncestor,
    });
  }).sort((left, right) => left.service.localeCompare(right.service));

  const summary = summarizeDeployDrift(results, JSON.parse(readFileSync(BASELINE_URL, 'utf8')));
  if (asJson) console.log(JSON.stringify({ environment, headSha, graceSha, summary, results }, null, 2));
  else printReport(results, summary, headSha, graceSha);
  if (!summary.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
