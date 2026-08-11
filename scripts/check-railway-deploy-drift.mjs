#!/usr/bin/env node

// Alarms on "production is not running this merge yet", whatever the cause.
//
// Every repository gate can be green while a Railway service keeps running an
// older image: the watch-path filter refuses the push (#6141), the GitHub
// integration stops delivering it (#6064), or the build fails after the merge
// lands. None of those produce a repository signal, and the seeder's own health
// checks cannot see them either — a container on old code publishes
// fresh-looking data.
//
// The #6141 case is a LAG tail rather than a loss: Railway builds the full tree
// at a SHA, so a refused commit rides the next build that fires (p50 0h, p90
// 19h, max 62.6h). That is harmless for a copy tweak and an outage when the
// delayed commit fixes an active crash loop, and nothing inside the repository
// tells the two apart — which is the whole reason to measure the lag.
//
// The check is deliberately independent of why. For every service this
// repository deploys it asks one question: is the source Railway is running the
// commit at the head of main? Anything that is not a positive yes is reported.
//
// Usage:
//   node scripts/check-railway-deploy-drift.mjs
//   node scripts/check-railway-deploy-drift.mjs --json
//   node scripts/check-railway-deploy-drift.mjs --head <sha> --window 200
//   node scripts/check-railway-deploy-drift.mjs --concurrency 4
//   node scripts/check-railway-deploy-drift.mjs --verbose   # list acknowledged

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyAcceptanceBaseline } from './check-seed-freshness.mjs';
import {
  DEFAULT_CONCURRENCY,
  mapWithConcurrency,
  readArgument,
  readDeploymentsForFleet,
  readEnvironmentConfig,
  resolveEnvironmentId,
  readRepositoryServices,
  runRailway,
} from './railway-cli.mjs';
import {
  FAILED_STATUSES,
  IN_FLIGHT_STATUSES,
  REJECTED_STATUS,
  RUNNING_STATUSES,
  createFleetAccumulator,
  createdAtMs,
  isKnownStatus,
  newestRunning,
  orderByRecency,
} from './railway-deployments.mjs';
import {
  changeReachesService,
  createAncestryResolver,
  createChangedPathsReader,
  createCommitPathsReader,
  isLegitimatePathSkip,
  pathsReachingService,
  resolveServiceClosure,
} from './railway-deploy-closure.mjs';

const DEFAULT_ENVIRONMENT = 'production';
const BASELINE_URL = new URL('./railway-deploy-drift-baseline.json', import.meta.url);
const REGISTRY_URL = new URL('./railway-services.json', import.meta.url);

// Re-exported for the existing importers. The definitions live in the shared
// modules so this check and the deploy trigger cannot drift apart on them.
export {
  DEFAULT_CONCURRENCY,
  FAILED_STATUSES,
  IN_FLIGHT_STATUSES,
  REJECTED_STATUS,
  RUNNING_STATUSES,
  createdAtMs,
  mapWithConcurrency,
};





// Railway builds land in about two minutes. Thirty is a generous ceiling for a
// queued build on a busy project, chosen against the observed build duration
// rather than against this check's own cadence.
//
// The grace is spent on a COMMIT, never on a service: the caller resolves the
// newest commit older than this window and every service must be running that
// commit or a descendant. Excusing a service because head happens to be young
// would have gone green on the whole fleet on any run that followed a merge.
export const DEFAULT_BUILD_GRACE_MS = 30 * 60 * 1000;

// The classifier only reads back to the newest running deployment plus the
// rejections after it; nothing older can change which source is live. Measured
// against production, the deepest service needed 6 records. 50 keeps a wide
// margin while cutting the per-service payload — this runs 77 times per tick
// inside a job with a wall-clock budget.
export const DEFAULT_DEPLOYMENT_WINDOW = 50;


// Everything that is not a positive "running everything that reaches it" or "a
// build is under way". The list is derived from the healthy verdicts rather
// than enumerated, so a verdict added later is a problem until someone decides
// otherwise — a scanner whose unmatched case means healthy cannot be fixed by
// adding cases.
//
// CURRENT_FOR_CLOSURE is the verdict that makes this check compatible with
// watch-path filtering at all. Under a filter, most services are deliberately
// NOT running head: they are running the newest commit that changed anything
// they can see, and every merge since is none of their business. Demanding head
// from all of them reported 62 healthy services as rejected pushes, which is
// how the baseline came to acknowledge most of the fleet (#6142).
const HEALTHY_VERDICTS = new Set(['CURRENT', 'CURRENT_FOR_CLOSURE', 'AHEAD', 'PENDING_BUILD']);
const STRICT_TERMINAL_VERDICTS = new Set(['CURRENT', 'CURRENT_FOR_CLOSURE', 'AHEAD']);

export function isProblemVerdict(verdict) {
  return !HEALTHY_VERDICTS.has(verdict);
}

// Verdicts that mean "this check could not determine anything". Acknowledging
// one in the baseline converts an unreadable answer into a green one, which is
// the exact failure mode this file exists to prevent — so the baseline test
// asserts against THIS list rather than re-typing it. A new can't-tell verdict
// added here is refused by the baseline automatically; one enumerated only at
// the test's call site would be silently baselineable.
export const UNDETERMINABLE_VERDICTS = Object.freeze([
  'QUERY_FAILED',
  'UNKNOWN_STATUS',
  'NO_DEPLOYMENTS',
  'NO_BUILD_IN_WINDOW',
  'CLOSURE_UNKNOWN',
]);



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
  // Used only to bound an in-flight build; every other decision is SHA-based.
  now = Date.now(),
  buildGraceMs = DEFAULT_BUILD_GRACE_MS,
  // Whether `ancestor` is an ancestor of (or equal to) `descendant`. Used to
  // accept a service running something NEWER than the head we were handed —
  // observed on the first live run, where two services had already built a
  // commit the checkout did not contain, because main moved mid-run. Defaults
  // to "cannot prove it", so a caller without git history fails to noise.
  isAncestor = () => false,
  // What this service's container can be affected by, from
  // scripts/railway-deploy-closure.mjs. Null means "everything", which is the
  // strict reading and the behaviour this check had before #6142.
  closure = null,
  // Paths changed between a commit and head, or null when the checkout cannot
  // reach that commit. Defaults to "cannot tell", which reports the service
  // rather than silently excusing it.
  changedPathsSince = () => null,
  // Paths changed by one commit, used to judge whether a single refusal was the
  // filter working. Same default, same reason.
  changedPathsIn = () => null,
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
  const ordered = orderByRecency(deployments);
  const running = newestRunning(ordered);
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

  const runningSha = running?.meta?.commitHash ?? null;

  // Everything this service is missing: the paths changed between the source it
  // is running and head.
  //
  // Tri-state on purpose. `false` — nothing that reaches this container has
  // changed — is the only value that excuses a service, and it has to be
  // positively evidenced. `null` means the checkout could not compute the
  // delta, which is not the same as "nothing changed" and must leave the
  // service reported.
  const missingPaths = runningSha ? changedPathsSince(runningSha) : null;
  const closureChanged = missingPaths === null
    ? null
    : changeReachesService(closure, missingPaths);

  // A rejection is outstanding until the running SOURCE contains it. Comparing
  // against the newest deployment RECORD instead was wrong: a cron tick is a
  // redeploy of the same image, so on a service that records its ticks the
  // 05:10 tick buried the 05:06 rejection and the verdict decayed from
  // REJECTED_PUSH to BEHIND — losing the evidence and, because the baseline
  // matches on service:verdict, silently voiding that service's entry.
  const supersededBySource = (rejection) => {
    const rejectedSha = rejection.meta.commitHash;
    if (!runningSha) return false;
    if (runningSha === rejectedSha) return true;
    if (isAncestor(rejectedSha, runningSha)) return true;
    // Git could not prove containment (shallow clone, unfetched commit). Fall
    // back to the one thing the records alone can show: whether the source
    // actually CHANGED after the rejection. Same sha before and after means
    // nothing was built, whatever else happened in between.
    const shaBefore = ordered.find((deployment) => RUNNING_STATUSES.includes(deployment.status)
      && createdAtMs(deployment) < createdAtMs(rejection))?.meta?.commitHash ?? null;
    return ordered.some((deployment) => RUNNING_STATUSES.includes(deployment.status)
      && createdAtMs(deployment) > createdAtMs(rejection)
      && deployment.meta?.commitHash
      && deployment.meta.commitHash !== shaBefore);
  };

  // A refusal of a push that could not have changed this container is the
  // filter working, not a rejection to report. Fleet-wide, nearly every
  // path-reason skip is exactly that; treating them as rejections is what put
  // 62 of 77 services in the suppression baseline.
  //
  // Judged per refusal, not per service, and that distinction decides a
  // verdict: a service that is genuinely behind while every recorded refusal
  // was a correct path skip has not had a push refused at all — its merge
  // never reached Railway, which is #6064's failure wearing #6141's name.
  const outstandingRejections = closureChanged === false
    ? []
    : ordered.filter((deployment) => deployment.status === REJECTED_STATUS
      && deployment.meta?.commitHash
      && !supersededBySource(deployment)
      && !isLegitimatePathSkip(deployment, closure, changedPathsIn(deployment.meta.commitHash)));
  const rejectedShas = outstandingRejections.map((deployment) => deployment.meta.commitHash);
  const identified = {
    ...base,
    runningSha,
    runningAt: running?.createdAt ?? null,
    rejectedShas,
  };

  // A failed build for head outranks an outstanding rejection when it is the
  // newer event: that is exactly the #6142 recovery path, where the trigger is
  // fixed, the build finally fires, and it breaks. Reporting REJECTED_PUSH
  // there would name a cause that has already been resolved.
  const forHead = (statuses) => ordered.find((deployment) => statuses.includes(deployment.status)
    && deployment.meta?.commitHash === headSha);
  const failedForHead = forHead(FAILED_STATUSES);
  const newestRejectionAt = outstandingRejections.length > 0
    ? Math.max(...outstandingRejections.map(createdAtMs))
    : Number.NEGATIVE_INFINITY;
  if (failedForHead && createdAtMs(failedForHead) > newestRejectionAt) {
    return {
      ...identified,
      verdict: 'BUILD_FAILED',
      detail: `the build for ${headSha.slice(0, 9)} failed, so ${runningSha?.slice(0, 9) ?? 'an unidentified source'} is still serving`,
    };
  }

  if (rejectedShas.length > 0) {
    // Name the reason Railway gave. The two it uses mean opposite things — a
    // path filter doing its job versus a deferral on the commit's whole check
    // suite, which scheduled workflows re-reporting onto main's head SHA turn
    // red long after the merge gates passed. Without the reason in the report
    // both read as one undifferentiated "refused".
    const reasons = [...new Set(
      outstandingRejections.map((deployment) => deployment.meta?.skippedReason).filter(Boolean),
    )];
    return {
      ...identified,
      verdict: 'REJECTED_PUSH',
      detail: `Railway refused ${rejectedShas.length} push(es) reaching this service and has built nothing since: ${rejectedShas.map((sha) => sha.slice(0, 9)).join(', ')}${reasons.length > 0 ? ` (${reasons.join('; ')})` : ''}`,
    };
  }
  if (!running) {
    return { ...identified, verdict: 'NO_BUILD_IN_WINDOW', detail: 'no deployment in the window ever reached a running state' };
  }
  if (!identified.runningSha) {
    return {
      ...identified,
      verdict: 'UNKNOWN_SOURCE',
      detail: `the running deployment (${running.createdAt}) carries no commit SHA — a \`railway up\` upload — so its source cannot be compared with ${headSha.slice(0, 9)}. Expected right after a manual recovery and cleared by the next git-triggered build; a stale timestamp here means it never came.`,
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

  if (failedForHead) {
    return {
      ...identified,
      verdict: 'BUILD_FAILED',
      detail: `the build for ${headSha.slice(0, 9)} failed, so ${identified.runningSha.slice(0, 9)} is still serving`,
    };
  }
  // A build that started must also still be plausibly running. Without the age
  // bound a build that wedged days ago kept reporting PENDING_BUILD — a healthy
  // verdict — for as long as head did not move, which is precisely the
  // green-while-stale outcome this check exists to prevent.
  const inFlightForHead = forHead(IN_FLIGHT_STATUSES);
  if (inFlightForHead) {
    const startedMs = createdAtMs(inFlightForHead);
    if (Number.isFinite(now) && now - startedMs > buildGraceMs) {
      return {
        ...identified,
        verdict: 'BUILD_STALLED',
        detail: `a build for ${headSha.slice(0, 9)} has been ${inFlightForHead.status} since ${inFlightForHead.createdAt}, longer than the ${Math.round(buildGraceMs / 60_000)}m grace`,
      };
    }
    return { ...identified, verdict: 'PENDING_BUILD', detail: `a build for ${headSha.slice(0, 9)} is under way` };
  }
  // Not running head, but running everything that can reach it. This is the
  // normal steady state for a filtered service and it is healthy: the merges
  // since are changes to code this container does not contain.
  if (closureChanged === false) {
    return {
      ...identified,
      verdict: 'CURRENT_FOR_CLOSURE',
      detail: `running ${identified.runningSha.slice(0, 9)}; none of the ${missingPaths.length} path(s) changed since then reach this service`,
    };
  }
  // We could not compute the delta — almost always a checkout too shallow to
  // reach the running commit. Report it: "we could not check" is not "it is
  // fine", and this is precisely the service that has been behind longest.
  if (closureChanged === null) {
    return {
      ...identified,
      verdict: 'CLOSURE_UNKNOWN',
      detail: `running ${identified.runningSha.slice(0, 9)}, which this checkout cannot reach — deepen the fetch to decide whether anything reaching this service changed since`,
    };
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
    detail: `running ${identified.runningSha.slice(0, 9)} from ${identified.runningAt}, which predates ${graceSha.slice(0, 9)} and is missing ${pathsReachingService(closure, missingPaths).length} path(s) that reach it — no build and no rejection recorded`,
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
/**
 * Every service the baseline speaks for must appear in the fleet we queried.
 *
 * Without this, a service whose Railway source is detached from the repository —
 * or a partial `railway service list` — silently drops out of checking, and the
 * baseline split then reports its entry as "recovered, prune it" for a service
 * that may still be serving stale code and is now watched by nothing.
 */
export function missingBaselinedServices(results, baseline) {
  if (!baseline?.acknowledged) return [];
  const checked = new Set(results.map((result) => result.service));
  return [...new Set(
    baseline.acknowledged
      .map((entry) => entry.name)
      .filter((name) => !checked.has(name)),
  )].sort();
}

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
    missing: [],
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
      // `name`/`status` are aliases of `service`/`verdict`: they are the field
      // names the shared baseline matcher expects, and they survive into the
      // --json output alongside the originals.
      problems.map((problem) => ({ ...problem, name: problem.service, status: problem.verdict })),
      baseline,
      now,
    )
    : empty;
  // A baselined service that vanished from the fleet is an unchecked service,
  // not a recovered one — so it must never reach the `cleared` prune list.
  const missing = missingBaselinedServices(results, baseline);
  const cleared = split.cleared.filter((entry) => !missing.includes(entry.name));
  const ok = split.blocking.length === 0 && !split.expired && missing.length === 0;
  return {
    counts,
    problems,
    blocking: split.blocking,
    acknowledged: split.acknowledged,
    cleared,
    missing,
    expired: split.expired,
    expiresAt: split.expiresAt ?? null,
    ok,
    detail: ok
      ? `${results.length} service(s) are running the head commit or building it`
      : `${split.blocking.length} of ${results.length} service(s) are not running the head commit`,
  };
}

// Recovery acceptance is intentionally stricter than the recurring monitor.
// The monitor may call a young build healthy and may split known problems
// through a reviewed baseline. A reconciliation generation is terminal only
// when every repository service is positively current for the exact head (or a
// proven descendant/closure-equivalent). It therefore accepts no baseline and
// gives PENDING_BUILD no terminal meaning.
export function summarizeStrictDeployDrift(
  results,
  expectedServices,
  { isOnAuthorizedMainLineage = null } = {},
) {
  if (!Array.isArray(expectedServices) || expectedServices.length === 0
    || expectedServices.some((name) => typeof name !== 'string' || name.length === 0)) {
    throw new TypeError('strict drift requires a non-empty expected service list');
  }
  if (new Set(expectedServices).size !== expectedServices.length) {
    throw new TypeError('strict drift expected service names must be unique');
  }
  if (!Array.isArray(results)) throw new TypeError('strict drift results must be an array');

  const expected = new Set(expectedServices);
  const seen = new Set();
  const duplicates = new Set();
  const unexpected = [];
  const blocking = [];
  for (const result of results) {
    const service = result?.service;
    if (typeof service !== 'string' || service.length === 0) {
      blocking.push({ service: null, verdict: 'INVALID_RESULT', detail: 'result has no service name' });
      continue;
    }
    if (seen.has(service)) duplicates.add(service);
    seen.add(service);
    if (!expected.has(service)) unexpected.push(service);
    if (result.verdict === 'AHEAD'
      && (typeof isOnAuthorizedMainLineage !== 'function'
        || isOnAuthorizedMainLineage(result.runningSha) !== true)) {
      blocking.push({
        ...result,
        verdict: 'AHEAD_LINEAGE_UNPROVEN',
        detail: 'the running descendant is not proven reachable from the authorized main ref',
      });
    } else if (!STRICT_TERMINAL_VERDICTS.has(result.verdict)) {
      blocking.push(result);
    }
  }
  const missing = [...expected].filter((service) => !seen.has(service)).sort();
  const duplicateNames = [...duplicates].sort();
  const unexpectedNames = [...new Set(unexpected)].sort();
  return {
    ok: blocking.length === 0
      && missing.length === 0
      && duplicateNames.length === 0
      && unexpectedNames.length === 0
      && results.length === expectedServices.length,
    checked: results.length,
    expected: expectedServices.length,
    blocking,
    missing,
    duplicates: duplicateNames,
    unexpected: unexpectedNames,
  };
}

export function readRepeatedArguments(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === name) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      values.push(value);
      index += 1;
    } else if (argument.startsWith(`${name}=`)) {
      const value = argument.slice(name.length + 1);
      if (!value) throw new Error(`${name} requires a value`);
      values.push(value);
    }
  }
  return values;
}

const GIT_CALL_TIMEOUT_MS = 30_000;

function runGit(args) {
  // maxBuffer is not decoration: `git diff --name-only` across a service that
  // is weeks behind runs to thousands of paths, and the default 1MB cap would
  // turn that into a thrown error and a CLOSURE_UNKNOWN for the very services
  // this check most needs to classify.
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: GIT_CALL_TIMEOUT_MS });
  if (result.signal) throw new Error(`git ${args.join(' ')} timed out`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}




function printReport(results, summary, headSha, graceSha, { verbose = false } = {}) {
  console.log(`Railway deploy-drift check: head=${headSha.slice(0, 9)} grace=${graceSha.slice(0, 9)} services=${results.length} ${JSON.stringify(summary.counts)}`);

  // The actionable list goes FIRST. This ordering is deliberately NOT the one
  // check-seed-freshness.mjs uses: that baseline holds 2 entries, this one
  // holds 63, and GitHub renders stdout and stderr interleaved in one
  // chronological log — so listing the acknowledged services first would make
  // an operator scroll past 63 lines of "ignore this" to reach the one line
  // that needs them.
  if (summary.blocking.length > 0) {
    console.error(`Railway deploy-drift check found ${summary.blocking.length} service(s) not running the head commit:`);
    for (const problem of summary.blocking) {
      console.error(`- ${problem.service} [${problem.verdict}] ${problem.detail}`);
    }
  }
  for (const name of summary.missing ?? []) {
    console.error(`- ${name} is acknowledged in the baseline but was not in the queried fleet — it is unchecked, not recovered`);
  }
  if (summary.expired) {
    console.error(`Deploy-drift baseline expired on ${summary.expiresAt}; re-review scripts/railway-deploy-drift-baseline.json.`);
  }

  // Recovered entries stay visible unconditionally — they are the prune list,
  // they are never numerous, and losing them is how a suppression rots.
  for (const entry of summary.cleared) {
    console.log(`- recovered: ${entry.name}:${entry.status} is running head again; remove it from scripts/railway-deploy-drift-baseline.json (#${entry.issue}).`);
  }
  // The acknowledged roll-up collapses to one line unless asked for. Use
  // --verbose or --json to enumerate it.
  if (summary.acknowledged.length > 0) {
    if (verbose) {
      for (const problem of summary.acknowledged) {
        console.log(`- acknowledged (#${problem.issue}): ${problem.service} [${problem.verdict}] ${problem.detail}`);
      }
    } else {
      const byIssue = {};
      for (const problem of summary.acknowledged) {
        byIssue[problem.issue] = (byIssue[problem.issue] ?? 0) + 1;
      }
      const owners = Object.entries(byIssue)
        .map(([issue, count]) => `${count} against #${issue}`)
        .join(', ');
      console.log(`${summary.acknowledged.length} service(s) knowingly behind and acknowledged (${owners}) — re-run with --verbose to list them.`);
    }
  }

  if (summary.ok) {
    console.log(
      summary.acknowledged.length === 0
        ? `Every service this repository deploys is running ${headSha.slice(0, 9)} or building it.`
        : `No unacknowledged drift: the rest are running ${headSha.slice(0, 9)} or building it.`,
    );
  } else if (summary.blocking.length === 0 && !summary.expired && (summary.missing ?? []).length === 0) {
    console.error(`- ${summary.detail}`);
  }
}

async function main() {
  const asJson = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');
  const expectedServices = readRepeatedArguments(process.argv, '--expected-service');
  const environment = readArgument(process.argv, '--environment', DEFAULT_ENVIRONMENT);
  const window = Number(readArgument(process.argv, '--window', String(DEFAULT_DEPLOYMENT_WINDOW)));
  const graceMinutes = Number(
    readArgument(process.argv, '--grace-minutes', String(DEFAULT_BUILD_GRACE_MS / 60_000)),
  );
  const concurrency = Number(readArgument(process.argv, '--concurrency', String(DEFAULT_CONCURRENCY)));
  if (!Number.isInteger(window) || window <= 0) throw new Error('--window must be a positive integer');
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error('--concurrency must be a positive integer');
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0) throw new Error('--grace-minutes must be a non-negative number');
  if (strict && expectedServices.length === 0) {
    throw new Error('--strict requires at least one immutable --expected-service');
  }

  const headSha = readArgument(process.argv, '--head', null) ?? runGit(['rev-parse', 'HEAD']);
  // `git merge-base --is-ancestor` exits non-zero both when the answer is no
  // and when the object is missing (a shallow checkout that never fetched the
  // commit). Both collapse to "cannot prove it", which keeps the service
  // reported rather than excused.
  // Memoised, and sharing the trigger's resolver so both files answer ancestry
  // the same way. Not an optimisation detail: supersededBySource() calls this
  // once per outstanding rejection inside a filter, so an unmemoised version
  // spawns `git merge-base` thousands of times per sweep — each one blocking
  // the event loop — and that, not the Railway API, is what made this check
  // take minutes. 'unknown' collapses to false here, preserving the existing
  // "cannot prove it keeps the service reported" behaviour.
  const ancestry = createAncestryResolver({ git: runGit });
  const isAncestor = (ancestor, descendant) => ancestry(ancestor, descendant) === 'yes';
  let authorizedMainSha = null;
  if (strict) {
    try {
      authorizedMainSha = runGit(['rev-parse', '--verify', 'origin/main^{commit}']);
    } catch {
      // Strict AHEAD acceptance needs a positive repository-lineage proof. A
      // missing/stale ref is not fatal for exact CURRENT results, but every
      // AHEAD result will fail closed in summarizeStrictDeployDrift below.
    }
  }
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
  // What each service's container can be affected by. The registry is the
  // repository's declaration and the live config is what Railway is actually
  // filtering on; resolveServiceClosure unions them, because between a merged
  // registry edit and the audit's --apply each knows a path the other does not.
  const registryByService = new Map(
    JSON.parse(readFileSync(REGISTRY_URL, 'utf8')).map((entry) => [entry.service, entry]),
  );
  // readEnvironmentConfig fails closed on an unexpected payload; see its comment.
  const liveById = readEnvironmentConfig(environment).services;
  const changedPathsSince = createChangedPathsReader(headSha, { git: runGit });
  const changedPathsIn = createCommitPathsReader({ git: runGit });

  // One fleet-wide query instead of 77, which is what took this check ~7
  // minutes against a 15-minute interval. Falls back per service for anything
  // the stream does not reach.
  let headCommittedAt = Number.NEGATIVE_INFINITY;
  try {
    headCommittedAt = Number(runGit(['show', '-s', '--format=%ct', headSha])) * 1000;
  } catch {
    // Unknown head time pages to the service-coverage rule alone.
  }
  const histories = await readDeploymentsForFleet({
    services,
    environment,
    environmentId: (() => { try { return resolveEnvironmentId(environment); } catch { return null; } })(),
    window,
    concurrency,
    notBefore: headCommittedAt,
    accumulatorFactory: createFleetAccumulator,
    onRoute: (route) => {
      // stderr, not stdout: --json must remain one parseable document, and a
      // human progress line in front of it breaks every machine consumer.
      console.error(route.route === 'fleet'
        ? `Read ${services.length} service histories in ${route.pages} fleet page(s) (${route.records} records), ${route.fellBack} direct fallback(s).`
        : `Reading service histories one at a time: ${route.reason}`);
    },
  });

  const results = (await mapWithConcurrency(services, concurrency, async (service) => {
    const { deployments, error } = histories.get(service.id) ?? { deployments: null, error: 'no history was read for this service' };
    return classifyServiceDeploy({
      service: service.name,
      deployments,
      error,
      headSha,
      graceSha,
      isAncestor,
      closure: resolveServiceClosure({
        registryEntry: registryByService.get(service.name) ?? null,
        liveService: liveById[service.id] ?? null,
      }),
      changedPathsSince,
      changedPathsIn,
    });
  })).sort((left, right) => left.service.localeCompare(right.service));

  const summary = strict
    ? summarizeStrictDeployDrift(results, expectedServices, {
      isOnAuthorizedMainLineage: (runningSha) => authorizedMainSha !== null
        && ancestry(runningSha, authorizedMainSha) === 'yes',
    })
    : summarizeDeployDrift(results, JSON.parse(readFileSync(BASELINE_URL, 'utf8')));
  if (asJson) console.log(JSON.stringify({ environment, headSha, graceSha, summary, results }, null, 2));
  else if (strict) {
    console.log(`Strict Railway deploy-drift check: head=${headSha.slice(0, 9)} services=${results.length}`);
    for (const problem of summary.blocking) {
      console.error(`- ${problem.service ?? 'unknown'} [${problem.verdict}] ${problem.detail ?? ''}`);
    }
    for (const service of summary.missing) console.error(`- ${service} [MISSING] was not positively classified`);
  } else printReport(results, summary, headSha, graceSha, { verbose: process.argv.includes('--verbose') });
  if (!summary.ok) process.exitCode = 1;
}

// realpath BOTH sides: Node sets import.meta.url to the realpath while argv[1]
// keeps the symlink, so on a symlinked checkout (macOS /tmp) a bare comparison
// makes this script exit 0 having done nothing — a silent fail-open for a gate.
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
