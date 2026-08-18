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
//   node scripts/check-railway-deploy-drift.mjs --audit-deployment-config

import { readFileSync, realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_CONCURRENCY,
  RAILWAY_CALL_TIMEOUT_MS,
  mapWithConcurrency,
  readArgument,
  readDeployments,
  readDeploymentsForFleet,
  readExpectedRepositoryFleet,
  readServices,
  resolveEnvironmentId,
  resolveRunDeadlineAt,
  runGit,
  selectExpectedRepositoryServices,
} from './railway-cli.mjs';
import { readViewerDeploymentConfig } from './railway-viewer-deployment-config.mjs';
import {
  auditRailwayServiceConfig,
  printAudit,
} from './audit-railway-watch-paths.mjs';
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
// why the removed suppression baseline once acknowledged most of the fleet
// (#6142).
const HEALTHY_VERDICTS = new Set(['CURRENT', 'CURRENT_FOR_CLOSURE', 'AHEAD', 'PENDING_BUILD']);
const STRICT_TERMINAL_VERDICTS = new Set(['CURRENT', 'CURRENT_FOR_CLOSURE', 'AHEAD']);

export function isProblemVerdict(verdict) {
  return !HEALTHY_VERDICTS.has(verdict);
}

// Verdicts that mean "this check could not determine anything". They remain
// directly blocking. Keeping one closed list also makes the deep-read path
// cover every can't-tell verdict instead of silently treating a new label as
// healthy.
export const UNDETERMINABLE_VERDICTS = Object.freeze([
  'QUERY_FAILED',
  'UNKNOWN_STATUS',
  'NO_DEPLOYMENTS',
  'NO_BUILD_IN_WINDOW',
  'CLOSURE_UNKNOWN',
  // A rejection observed on a window that never surfaced a running deployment
  // (#6483 review): the check knows pushes were refused but has no idea what
  // the container is serving. It LOOKS determinate — which is exactly why it
  // gets its own verdict: as plain REJECTED_PUSH the removed suppression
  // mechanism could mistake missing source evidence for an understood
  // degradation. Listed here so the deep pass gets a chance to identify it.
  'REJECTED_PUSH_UNKNOWN_SOURCE',
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
  // REJECTED_PUSH to BEHIND, losing the more specific refusal evidence.
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
  // path-reason skip is exactly that; treating them as rejections is what once
  // put 62 of 77 services in the removed suppression baseline.
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
  // A frozen comparison head can have a failed build even after a newer
  // descendant is serving. Production is ahead in that case. Keep outstanding
  // rejection handling below ahead of the final AHEAD verdict: a later refused
  // push remains actionable even when the current image descends from head.
  const runningIsAhead = Boolean(
    runningSha
    && runningSha !== headSha
    && isAncestor(headSha, runningSha),
  );
  const newestRejectionAt = outstandingRejections.length > 0
    ? Math.max(...outstandingRejections.map(createdAtMs))
    : Number.NEGATIVE_INFINITY;
  if (!runningIsAhead && failedForHead && createdAtMs(failedForHead) > newestRejectionAt) {
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
    const refused = `Railway refused ${rejectedShas.length} push(es) reaching this service and has built nothing since: ${rejectedShas.map((sha) => sha.slice(0, 9)).join(', ')}${reasons.length > 0 ? ` (${reasons.join('; ')})` : ''}`;
    // A rejection on a window with NO running deployment is a different answer
    // than a rejection on an identified source: the saturated-window shape
    // that produces NO_BUILD_IN_WINDOW produces this instead whenever one
    // outstanding rejection is present, and it must be equally undeterminable
    // (#6483 review, verified against the recorded production cohort).
    if (!running) {
      return {
        ...identified,
        verdict: 'REJECTED_PUSH_UNKNOWN_SOURCE',
        detail: `${refused} — and no deployment in the window ever reached a running state, so the live source is unidentified`,
      };
    }
    return {
      ...identified,
      verdict: 'REJECTED_PUSH',
      detail: refused,
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
  if (runningIsAhead) {
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

// One deeper read for a service whose shallow window held no running build.
// 400 is sized against the observed worst case, not the steady state: the
// 2026-08-07→12 refusal storm added a SKIPPED record per push per service plus
// a record per cron tick, and the deepest displacement measured stayed well
// under half of this. A storm that outruns even this leaves the service
// NO_BUILD_IN_WINDOW — reported, exactly as before.
export const DEEP_DEPLOYMENT_WINDOW = 400;

// The deep pass is a second CLI sweep behind the shallow one, inside a job
// with a 20-minute job budget whose concurrency group cancels in-progress
// runs. Unbounded, a full-fleet storm (every service a
// candidate, every read at the 60s RAILWAY_CALL_TIMEOUT_MS ceiling) could
// push the run past its own cadence and get every run superseded — a grey
// monitor during exactly the incident class this pass exists for. Overflow
// candidates keep their shallow verdict, which is fail-closed and reported.
export const DEEP_PASS_MAX_CANDIDATES = 40;

// Keep the entire projection/history/classification pass inside the workflow's
// 20-minute job limit. The workflow starts the clock in its first step, so
// checkout, setup, probes, and degraded fallbacks all spend the same budget.
export const DEEP_PASS_RUN_BUDGET_MS = 13 * 60 * 1000;
const DEEP_PASS_ROTATION_MS = 60 * 60 * 1000;

/**
 * Convert the workflow's epoch start time into this process's monotonic clock.
 * Missing or invalid workflow input falls back to a fresh local-script budget,
 * which keeps direct CLI use bounded without mixing epoch and monotonic values.
 */
export function resolveDeepPassDeadlineAt({
  jobStartedAtMs,
  epochNow = Date.now(),
  monotonicNow = performance.now(),
}) {
  return resolveRunDeadlineAt({
    budgetMs: DEEP_PASS_RUN_BUDGET_MS,
    jobStartedAtMs,
    epochNow,
    monotonicNow,
  });
}

/** Classify histories until the shared run deadline, then fail closed. */
export function classifyFleetWithinDeadline(services, histories, {
  classify,
  deadlineAt,
  monotonicNow = () => performance.now(),
}) {
  return services.map((service) => {
    const history = histories.get(service.id) ?? {
      deployments: null,
      error: 'no history was read for this service',
    };
    if (monotonicNow() >= deadlineAt) {
      return classify(service, {
        deployments: null,
        error: 'run deadline reached before deployment history classification',
      });
    }
    return classify(service, history);
  });
}

// A deep read that surfaces only an ANCIENT running record must not upgrade
// the service to a healthy verdict (#6483 review, verified by execution): a
// cron seeder records a running-status record per tick, so "nothing newer at
// any depth" is evidence the container stopped ticking, and CURRENT_FOR_CLOSURE
// on a months-dead service is the green-while-stale outcome the BUILD_STALLED
// age bound already exists to prevent. Seven days sits far above the fleet's
// slowest observed healthy cadence (oldest healthy runningAt measured 51.7h on
// 2026-08-12) and far below the dead case that motivated the guard.
export const DEEP_HEALTHY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Both verdicts mean "the shallow window never identified the live source":
// NO_BUILD_IN_WINDOW when no rejection is outstanding, REJECTED_PUSH_UNKNOWN_SOURCE
// when one is. Deepening only the first would leave the second unresolved.
const DEEP_CANDIDATE_VERDICTS = new Set(['NO_BUILD_IN_WINDOW', 'REJECTED_PUSH_UNKNOWN_SOURCE']);

/**
 * Re-read the services whose shallow window never identified a live source
 * with a deeper window, and reclassify from the superset.
 *
 * These verdicts usually mean the newest RUNNING deployment sits past the
 * window's horizon, not that none exists (#6483: 29 of 80 services read
 * NO_BUILD_IN_WINDOW while every one was serving). They are undeterminable;
 * the only honest way to shrink them is to actually read deeper. Fail-closed
 * at every exit: a deep read that
 * throws, stays buildless, or surfaces only a stale build leaves the shallow
 * verdict in place, reported.
 */
export async function deepenNoBuildWindows(results, {
  services,
  readDeep,
  reclassify,
  concurrency = DEFAULT_CONCURRENCY,
  now = Date.now(),
  deadlineAt = Number.POSITIVE_INFINITY,
  monotonicNow = () => performance.now(),
}) {
  const byName = new Map(services.map((service) => [service.name, service]));
  const eligible = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => DEEP_CANDIDATE_VERDICTS.has(result.verdict) && byName.has(result.service));
  // Keep the cap, but rotate its starting point once per workflow tick. A
  // stable incident otherwise reselects the same alphabetically-first 40 on
  // every run and the overflow never receives its promised deeper retry.
  const rotationOffset = eligible.length === 0
    ? 0
    : (Math.floor(now / DEEP_PASS_ROTATION_MS) * DEEP_PASS_MAX_CANDIDATES) % eligible.length;
  const rotated = [...eligible.slice(rotationOffset), ...eligible.slice(0, rotationOffset)];
  const candidates = rotated.slice(0, DEEP_PASS_MAX_CANDIDATES);
  const capped = eligible.length - candidates.length;
  const out = [...results];
  let reclassified = 0;
  let unchanged = 0;
  let failed = 0;
  let deadlineDeferred = 0;
  const deepenedServices = [];
  await mapWithConcurrency(candidates, concurrency, async ({ result, index }) => {
    if (monotonicNow() >= deadlineAt) {
      deadlineDeferred += 1;
      return;
    }
    const service = byName.get(result.service);
    deepenedServices.push(result.service);
    try {
      const deployments = await readDeep(service);
      if (!Array.isArray(deployments)) {
        throw new Error('Railway deployment history was not an array');
      }
      const next = reclassify(service, { deployments, error: null });
      // The healthy-upgrade age guard. Guarded only when the verdict rests on
      // a running record (PENDING_BUILD with no running source is fresh
      // in-flight evidence, not an old build). A refused upgrade keeps the
      // shallow verdict and counts as neither reclassified nor failed — the
      // "unchanged" remainder in the caller's summary line.
      if (!isProblemVerdict(next.verdict) && next.runningSha) {
        const runningAtMs = Date.parse(next.runningAt ?? '');
        if (!Number.isFinite(runningAtMs) || now - runningAtMs > DEEP_HEALTHY_MAX_AGE_MS) {
          unchanged += 1;
          return;
        }
      }
      // A deeper but still undeterminable classification is not stronger than
      // the shallow fact we already established. Keep that original alarm in
      // place instead of replacing it with NO_DEPLOYMENTS, UNKNOWN_STATUS, or
      // another inconclusive label.
      if (UNDETERMINABLE_VERDICTS.includes(next.verdict)) {
        unchanged += 1;
        return;
      }
      out[index] = next;
      reclassified += 1;
    } catch (error) {
      // The shallow answer stands. Replacing it with QUERY_FAILED would erase
      // the one fact the shallow read DID establish, and going green here would
      // convert an unread answer into a healthy one — the exact failure mode
      // UNDETERMINABLE_VERDICTS exists to prevent. The failure itself must be
      // visible, though: an inert deep pass (rate-limited --limit 400, expired
      // token) is otherwise indistinguishable from a genuinely buildless fleet.
      failed += 1;
      console.error(`Deep history re-read failed for ${result.service}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return {
    results: out,
    deepened: deepenedServices.length,
    reclassified,
    unchanged,
    failed,
    capped,
    deadlineDeferred,
    deepenedServices,
  };
}

function normalizeAuthorizedLineage(result, isOnAuthorizedMainLineage) {
  if (result.verdict !== 'AHEAD'
    || (typeof isOnAuthorizedMainLineage === 'function'
      && isOnAuthorizedMainLineage(result.runningSha) === true)) {
    return result;
  }
  return {
    ...result,
    verdict: 'AHEAD_LINEAGE_UNPROVEN',
    detail: 'the running descendant is not proven reachable from the authorized main ref',
  };
}

export function summarizeDeployDrift(
  results,
  { isOnAuthorizedMainLineage = null } = {},
) {
  const evaluated = results.map((result) => (
    normalizeAuthorizedLineage(result, isOnAuthorizedMainLineage)
  ));
  const counts = {};
  for (const result of evaluated) {
    counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;
  }
  const problems = evaluated.filter((result) => isProblemVerdict(result.verdict));
  return {
    counts,
    blocking: problems,
    ok: evaluated.length > 0 && problems.length === 0,
    detail: evaluated.length === 0
      ? 'no services to check — the Railway service query returned nothing, which is a query failure rather than a healthy fleet'
      : problems.length === 0
        ? `${evaluated.length} service(s) are running the head commit or building it`
        : `${problems.length} of ${evaluated.length} service(s) are not running the head commit`,
  };
}

// Recovery acceptance is intentionally stricter than the recurring monitor.
// The monitor may call a young build healthy. A reconciliation generation is terminal only
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
    const evaluated = normalizeAuthorizedLineage(result, isOnAuthorizedMainLineage);
    if (!STRICT_TERMINAL_VERDICTS.has(evaluated.verdict)) {
      blocking.push(evaluated);
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

export function resolveOriginMainRelation(headSha, originMainSha, ancestry) {
  if (!originMainSha) return 'unavailable';
  if (headSha === originMainSha) return 'exact';
  const forward = ancestry(headSha, originMainSha);
  if (forward === 'yes') return 'behind';
  const reverse = ancestry(originMainSha, headSha);
  if (reverse === 'yes') return 'ahead';
  return forward === 'no' && reverse === 'no' ? 'diverged' : 'unknown';
}

export function resolveComparisonHead(argv, {
  git = runGit,
  ancestry = () => 'unknown',
} = {}) {
  const explicit = readArgument(argv, '--head', null);
  if (explicit === null) {
    git([
      'fetch',
      '--quiet',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
  }
  let originMainSha = null;
  try {
    originMainSha = git(['rev-parse', '--verify', '--end-of-options', 'origin/main^{commit}']);
  } catch (error) {
    if (explicit === null) {
      throw new Error(
        'cannot resolve origin/main for the deploy-drift comparison; fetch main or pass --head explicitly',
        { cause: error },
      );
    }
  }

  let headSha = originMainSha;
  let headSource = 'origin/main';
  if (explicit !== null) {
    headSource = '--head';
    try {
      headSha = git(['rev-parse', '--verify', '--end-of-options', `${explicit}^{commit}`]);
    } catch (error) {
      throw new Error(`cannot resolve --head ${explicit} to a commit`, { cause: error });
    }
  }

  return {
    headSha,
    headSource,
    originMainSha,
    originMainRelation: resolveOriginMainRelation(headSha, originMainSha, ancestry),
  };
}

export function formatComparisonHead({ headSource, originMainRelation }) {
  return `source=${headSource} vs-origin-main=${originMainRelation}`;
}



function printReport(results, summary, headSha, graceSha, headContext) {
  console.log(`Railway deploy-drift check: head=${headSha.slice(0, 9)} ${formatComparisonHead(headContext)} grace=${graceSha.slice(0, 9)} services=${results.length} ${JSON.stringify(summary.counts)}`);

  if (summary.blocking.length > 0) {
    console.error(`Railway deploy-drift check found ${summary.blocking.length} service(s) not running the head commit:`);
    for (const problem of summary.blocking) {
      console.error(`- ${problem.service} [${problem.verdict}] ${problem.detail}`);
    }
  }

  if (summary.ok) {
    console.log(`Every service this repository deploys is running ${headSha.slice(0, 9)} or building it.`);
  } else if (summary.blocking.length === 0) {
    console.error(`- ${summary.detail}`);
  }
}

async function main() {
  const runStartedAt = performance.now();
  const jobStartedAtMs = Number(process.env.RAILWAY_DRIFT_JOB_STARTED_AT_MS);
  const deepPassDeadlineAt = resolveDeepPassDeadlineAt({
    jobStartedAtMs,
    monotonicNow: runStartedAt,
  });
  const asJson = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');
  const auditDeploymentConfig = process.argv.includes('--audit-deployment-config');
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

  // Manual/operator runs default to the production line, never a feature
  // worktree's HEAD. The workflow passes its immutable event SHA explicitly,
  // then fetches newer main ancestry without moving this target.
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
  const headContext = resolveComparisonHead(process.argv, { git: runGit, ancestry });
  const { headSha, originMainSha: authorizedMainSha } = headContext;
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

  const assertRailwayCallCanStart = (operation) => {
    if (performance.now() >= deepPassDeadlineAt) {
      throw new Error(`Deploy-drift run deadline reached before ${operation}`);
    }
  };
  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (!projectId) throw new Error('RAILWAY_PROJECT_ID is required for the Viewer deployment projection');
  assertRailwayCallCanStart('reading the Railway service list');
  const services = selectExpectedRepositoryServices(
    readServices(environment, { projectId }),
    readExpectedRepositoryFleet(),
  );
  // What each service's container can be affected by. The registry is the
  // repository's declaration and the live config is what Railway is actually
  // filtering on; resolveServiceClosure unions them, because between a merged
  // registry edit and the audit's --apply each knows a path the other does not.
  const registry = JSON.parse(readFileSync(REGISTRY_URL, 'utf8'));
  const registryByService = new Map(registry.map((entry) => [entry.service, entry]));
  // The dedicated Viewer cannot see environment-variable values. Read only the
  // explicit source/build/deploy projection used by closure classification.
  assertRailwayCallCanStart('resolving the Railway environment id');
  const remainingEnvironmentMs = deepPassDeadlineAt - performance.now();
  const environmentId = resolveEnvironmentId(environment, projectId, {
    timeoutMs: Math.min(
      RAILWAY_CALL_TIMEOUT_MS,
      Math.max(1, Math.floor(remainingEnvironmentMs)),
    ),
  });
  assertRailwayCallCanStart('reading the Railway deployment configuration');
  const liveById = (await readViewerDeploymentConfig(environment, services, {
    projectId,
    environmentId,
    concurrency,
    includeActiveDeployments: true,
    deadlineAt: deepPassDeadlineAt,
  })).services;
  const configurationDrift = auditDeploymentConfig
    ? auditRailwayServiceConfig(
        { services: liveById },
        new Map(services.map((service) => [service.name, service.id])),
        registry,
        {
          evaluateRequiredEnv: false,
          requireMainTrigger: true,
        },
      )
    : [];
  if (auditDeploymentConfig && !asJson) printAudit(configurationDrift);
  const initialDeploymentsByService = new Map(
    Object.entries(liveById).map(([serviceId, config]) => [
      serviceId,
      config.activeDeployments,
    ]),
  );
  const changedPathsSince = createChangedPathsReader(headSha, { git: runGit });
  const changedPathsIn = createCommitPathsReader({ git: runGit });

  // One fleet-wide query instead of 77, which is what took this check ~7
  // minutes. Falls back per service for anything the stream does not reach.
  let headCommittedAt = Number.NEGATIVE_INFINITY;
  try {
    headCommittedAt = Number(runGit(['show', '-s', '--format=%ct', headSha])) * 1000;
  } catch {
    // Unknown head time pages to the service-coverage rule alone.
  }
  const histories = await readDeploymentsForFleet({
    services,
    environment,
    environmentId,
    projectId,
    window,
    concurrency,
    notBefore: headCommittedAt,
    accumulatorFactory: (args) => createFleetAccumulator({
      ...args,
      initialDeploymentsByService,
    }),
    onRoute: (route) => {
      // stderr, not stdout: --json must remain one parseable document, and a
      // human progress line in front of it breaks every machine consumer.
      console.error(route.route === 'fleet'
        ? `Read ${services.length} service histories in ${route.pages} fleet page(s) (${route.records} records), ${route.fellBack} direct fallback(s).`
        : `Reading service histories one at a time: ${route.reason}`);
    },
    deadlineAt: deepPassDeadlineAt,
    monotonicNow: () => performance.now(),
  });

  // One classifier closure for both passes: the shallow fleet read and the
  // deep per-service re-read must judge a history identically, or the deepen
  // pass could reach a different verdict for reasons other than depth.
  const classificationDeadlineReached = () => performance.now() >= deepPassDeadlineAt;
  const classifyFrom = (service, { deployments, error }) => classifyServiceDeploy({
    service: service.name,
    deployments,
    error,
    headSha,
    graceSha,
    isAncestor: (ancestor, descendant) => (
      classificationDeadlineReached() ? false : isAncestor(ancestor, descendant)
    ),
    closure: resolveServiceClosure({
      registryEntry: registryByService.get(service.name) ?? null,
      liveService: liveById[service.id] ?? null,
    }),
    changedPathsSince: (sha) => (
      classificationDeadlineReached() ? null : changedPathsSince(sha)
    ),
    changedPathsIn: (sha) => (
      classificationDeadlineReached() ? null : changedPathsIn(sha)
    ),
  });

  const shallowResults = classifyFleetWithinDeadline(services, histories, {
    classify: classifyFrom,
    deadlineAt: deepPassDeadlineAt,
  }).sort((left, right) => left.service.localeCompare(right.service));

  const deepPass = await deepenNoBuildWindows(shallowResults, {
    services,
    readDeep: (service) => readDeployments(service, environment, DEEP_DEPLOYMENT_WINDOW, {
      projectId,
    }),
    reclassify: classifyFrom,
    concurrency,
    deadlineAt: deepPassDeadlineAt,
  });
  const { results } = deepPass;
  if (deepPass.deepened > 0) {
    // stderr for the same reason the route line is: --json stays one document.
    // The three counts are distinct states an operator must be able to tell
    // apart: reclassified (the deep read answered), failed (the read never
    // landed — a tooling problem, not fleet state), unchanged (read landed but
    // stayed inconclusive or refused a stale healthy upgrade).
    console.error(`Deepened ${deepPass.deepened} service history read(s) whose ${window}-record window left the source unidentified (deep window ${DEEP_DEPLOYMENT_WINDOW}): ${deepPass.reclassified} reclassified, ${deepPass.failed} failed, ${deepPass.unchanged} unchanged.`);
  }
  if (deepPass.capped > 0) {
    console.error(`Deep pass capped at ${DEEP_PASS_MAX_CANDIDATES} candidate(s); ${deepPass.capped} kept their shallow verdict this run and retry next tick.`);
  }
  if (deepPass.deadlineDeferred > 0) {
    console.error(`Deep pass reached its ${DEEP_PASS_RUN_BUDGET_MS / 60_000}-minute run deadline; ${deepPass.deadlineDeferred} candidate(s) kept their shallow verdict so this run can report before the next tick.`);
  }

  const summary = strict
    ? summarizeStrictDeployDrift(results, expectedServices, {
      isOnAuthorizedMainLineage: (runningSha) => authorizedMainSha !== null
        && ancestry(runningSha, authorizedMainSha) === 'yes',
    })
    : summarizeDeployDrift(results, {
      isOnAuthorizedMainLineage: (runningSha) => authorizedMainSha !== null
        && ancestry(runningSha, authorizedMainSha) === 'yes',
    });
  // deepPass in the machine payload for the same reason the stderr line
  // exists: a service that flaps between shallow-undeterminable and
  // deep-reclassified across runs is invisible to a JSON consumer otherwise.
  if (asJson) {
    console.log(JSON.stringify({
      environment,
      headSha,
      headSource: headContext.headSource,
      originMainRelation: headContext.originMainRelation,
      graceSha,
      deepPass: {
        attempted: deepPass.deepenedServices,
        reclassified: deepPass.reclassified,
        unchanged: deepPass.unchanged,
        failed: deepPass.failed,
        capped: deepPass.capped,
        deadlineDeferred: deepPass.deadlineDeferred,
      },
      configurationAudit: {
        evaluated: auditDeploymentConfig,
        drift: configurationDrift,
      },
      summary,
      results,
    }, null, 2));
  }
  else if (strict) {
    console.log(`Strict Railway deploy-drift check: head=${headSha.slice(0, 9)} ${formatComparisonHead(headContext)} services=${results.length}`);
    for (const problem of summary.blocking) {
      console.error(`- ${problem.service ?? 'unknown'} [${problem.verdict}] ${problem.detail ?? ''}`);
    }
    for (const service of summary.missing) console.error(`- ${service} [MISSING] was not positively classified`);
  } else printReport(results, summary, headSha, graceSha, headContext);
  if (!summary.ok || configurationDrift.length > 0) process.exitCode = 1;
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
