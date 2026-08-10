// What a Railway deployment record means, with no I/O.
//
// scripts/check-railway-deploy-drift.mjs and scripts/trigger-railway-deploys.mjs
// both decide "which deployment is this service running" from the same
// `railway deployment list --json` array, and they must never disagree about
// one service — the drift check would report a service the trigger considers
// handled, or the trigger would deploy one the check calls current.
//
// They disagreed once already: the trigger's own copy of the recency sort used
// `Date.parse(x?.createdAt ?? 0)`, which yields NaN on a malformed timestamp
// and leaves the sort order undefined, while the check's collapsed NaN to
// "oldest". That is exactly the class of divergence this file exists to make
// impossible, so the semantics live here once and both scripts import them.

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

export function isKnownStatus(status) {
  return status === REJECTED_STATUS
    || RUNNING_STATUSES.includes(status)
    || IN_FLIGHT_STATUSES.includes(status)
    || FAILED_STATUSES.includes(status);
}

/**
 * A deployment's creation time in epoch ms, with an unreadable timestamp
 * sorting OLDEST rather than producing NaN comparisons.
 *
 * NaN would make the sort order undefined, and the record chosen as "running"
 * would then depend on the input order — which Railway does not document.
 */
export function createdAtMs(deployment) {
  const parsed = Date.parse(deployment?.createdAt ?? '');
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Deployment records newest first.
 *
 * Railway returns newest-first today. Sorting anyway costs nothing and keeps
 * "which deployment is live" from depending on an undocumented ordering.
 */
export function orderByRecency(deployments) {
  return [...deployments].sort((left, right) => createdAtMs(right) - createdAtMs(left));
}

/** The newest record that actually reached a running state, or undefined. */
export function newestRunning(orderedDeployments) {
  return orderedDeployments.find((deployment) => RUNNING_STATUSES.includes(deployment?.status));
}

/**
 * Accumulate a fleet-wide, newest-first deployment stream into per-service
 * histories, and decide when enough of it has been read.
 *
 * Pure, so the stopping rule can be tested without paging anything. The rule
 * has to satisfy BOTH questions its callers ask, and they bottom out at
 * different depths:
 *
 *   1. "what is this service running" — needs each service's newest RUNNING
 *      record. Slow-ticking services surface late, so this is what sets the
 *      depth (measured: 6 pages of 500 for a 78-service fleet).
 *   2. "did Railway take head" — needs any record carrying headSha. Those can
 *      only exist at or after head's commit time, so once the stream is older
 *      than that, no later page can hold one.
 *
 * A service still missing a RUNNING record when paging stops is `unresolved` —
 * NOT "a service with no deployments". Conflating those would let an exhausted
 * page budget fabricate NEVER_DEPLOYED for a healthy service, which is the same
 * fail-open shape as every other bug in this file's history. The caller falls
 * back to a direct per-service read for those.
 */
export function createFleetAccumulator({ serviceIds, notBefore = Number.NEGATIVE_INFINITY }) {
  const wanted = new Set(serviceIds);
  const byService = new Map(wanted.size > 0 ? [...wanted].map((id) => [id, []]) : []);
  const covered = new Set();
  let oldestSeen = Number.POSITIVE_INFINITY;
  let exhausted = false;

  return {
    absorb(nodes) {
      for (const node of nodes ?? []) {
        const at = createdAtMs(node);
        if (at < oldestSeen) oldestSeen = at;
        const id = node?.serviceId;
        if (!wanted.has(id)) continue;
        byService.get(id).push(node);
        if (RUNNING_STATUSES.includes(node?.status)) covered.add(id);
      }
    },
    markExhausted() { exhausted = true; },
    /** Every service located AND the stream is older than head — or there is no more stream. */
    get done() {
      return exhausted || (covered.size === wanted.size && oldestSeen < notBefore);
    },
    result() {
      return {
        byService,
        // Exhausting the stream proves a service genuinely has no running
        // deployment; running out of budget proves nothing.
        unresolved: exhausted ? [] : [...wanted].filter((id) => !covered.has(id)),
        oldestSeen,
      };
    },
  };
}
