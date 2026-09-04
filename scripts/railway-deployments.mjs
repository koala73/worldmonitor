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

const VIEWER_ACTIVE_DEPLOYMENTS = new WeakSet();
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isValidDeploymentTimestamp(value) {
  return typeof value === 'string'
    && RFC3339_TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value));
}

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
  return orderedDeployments.find((deployment) => (
    VIEWER_ACTIVE_DEPLOYMENTS.has(deployment)
    && RUNNING_STATUSES.includes(deployment?.status)
  )) ?? orderedDeployments.find((deployment) => RUNNING_STATUSES.includes(deployment?.status));
}

/**
 * Keep the requested recent-event window plus an older running baseline.
 *
 * A busy service can have `window` newer SKIPPED records. Dropping the next
 * record in that case also drops the Viewer-provided answer to "what is
 * running", so retain at most that one extra record.
 */
export function limitDeploymentHistory(orderedDeployments, window) {
  const limited = orderedDeployments.slice(0, window);
  const activeRunning = orderedDeployments.find((deployment) => (
    VIEWER_ACTIVE_DEPLOYMENTS.has(deployment)
    && RUNNING_STATUSES.includes(deployment?.status)
  ));
  if (activeRunning && !limited.includes(activeRunning)) limited.push(activeRunning);
  return limited;
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
 * The Viewer-safe service projection seeds each service's active deployments,
 * so the fleet stream only has to cross the comparison-head timestamp. That
 * captures every recent SKIPPED/FAILED/in-flight event without paging through
 * days of skip noise to rediscover the image Railway already identifies as
 * active. A service still missing a RUNNING record at that boundary is
 * `unresolved` — NOT "a service with no deployments" — and only that service
 * falls back to a direct history read.
 */
export function createFleetAccumulator({
  serviceIds,
  notBefore = Number.NEGATIVE_INFINITY,
  initialDeploymentsByService = new Map(),
}) {
  if (!(initialDeploymentsByService instanceof Map)) {
    throw new TypeError('initial Railway deployments must be a Map keyed by service id');
  }
  const wanted = new Set(serviceIds);
  const byService = new Map(wanted.size > 0 ? [...wanted].map((id) => [id, []]) : []);
  const covered = new Set();
  const seenIds = new Map([...wanted].map((id) => [id, new Map()]));
  const activeEvidenceServices = new Set();
  const newestActiveAt = new Map();
  const staleActiveEvidence = new Set();
  let oldestSeen = Number.POSITIVE_INFINITY;
  let exhausted = false;

  const refreshCoverage = (serviceId) => {
    const deployments = byService.get(serviceId);
    const hasRunning = activeEvidenceServices.has(serviceId)
      ? !staleActiveEvidence.has(serviceId) && deployments.some((deployment) => (
        VIEWER_ACTIVE_DEPLOYMENTS.has(deployment)
        && RUNNING_STATUSES.includes(deployment?.status)
      ))
      : deployments.some((deployment) => RUNNING_STATUSES.includes(deployment?.status));
    if (hasRunning) covered.add(serviceId);
    else covered.delete(serviceId);
  };

  const absorbDeployment = (node, { active = false } = {}) => {
    const id = node?.serviceId;
    if (!wanted.has(id)) return;
    const deployments = byService.get(id);
    const seen = seenIds.get(id);
    if (!active
      && !seen.has(node?.id)
      && activeEvidenceServices.has(id)
      && node?.status !== 'REMOVED'
      && RUNNING_STATUSES.includes(node?.status)
      && createdAtMs(node) >= (newestActiveAt.get(id) ?? Number.POSITIVE_INFINITY)) {
      // A distinct deployable record newer than the earlier Viewer snapshot
      // can be a manual upload or rollback that became active mid-scan. The
      // old active marker is no longer proof; force a fresh direct read unless
      // this fleet stream exhausts and therefore contains the full history.
      staleActiveEvidence.add(id);
      for (const deployment of deployments) VIEWER_ACTIVE_DEPLOYMENTS.delete(deployment);
      refreshCoverage(id);
    }
    if (typeof node?.id === 'string' && node.id.length > 0) {
      const existing = seen.get(node.id);
      if (existing) {
        // The active projection is read first. The later fleet stream can
        // carry the same deployment after BUILDING became FAILED/SUCCESS, so
        // replace only that older snapshot. Repeated fleet records stay
        // newest-first and the first one wins.
        if (!active && existing.active) {
          const preserveActive = !staleActiveEvidence.has(id)
            && deployments[existing.index]?.status === node?.status;
          if (preserveActive) VIEWER_ACTIVE_DEPLOYMENTS.add(node);
          deployments[existing.index] = node;
          seen.set(node.id, { index: existing.index, active: preserveActive });
          refreshCoverage(id);
        }
        return;
      }
      seen.set(node.id, { index: deployments.length, active });
    }
    if (active) VIEWER_ACTIVE_DEPLOYMENTS.add(node);
    deployments.push(node);
    refreshCoverage(id);
  };

  for (const [serviceId, deployments] of initialDeploymentsByService) {
    if (!wanted.has(serviceId)) continue;
    if (!Array.isArray(deployments)) {
      throw new TypeError(`initial Railway deployments for ${serviceId} must be an array`);
    }
    activeEvidenceServices.add(serviceId);
    for (const deployment of deployments) {
      if (deployment?.serviceId !== serviceId) {
        throw new Error(`initial Railway deployment belongs to another service while reading ${serviceId}`);
      }
      if (!isValidDeploymentTimestamp(deployment.createdAt)) {
        throw new Error(`initial Railway deployment for ${serviceId} must have a valid createdAt timestamp`);
      }
      newestActiveAt.set(
        serviceId,
        Math.max(newestActiveAt.get(serviceId) ?? Number.NEGATIVE_INFINITY, Date.parse(deployment.createdAt)),
      );
      // Active deployment evidence answers what is serving, but it must not
      // advance the recent-event cursor. The fleet stream still has to cross
      // the comparison-head timestamp so a skipped or failed push cannot hide
      // behind an older active image.
      absorbDeployment(deployment, { active: true });
    }
  }

  return {
    absorb(nodes) {
      for (const node of nodes ?? []) {
        if (!isValidDeploymentTimestamp(node?.createdAt)) {
          throw new Error('Railway fleet deployment must have a valid createdAt timestamp');
        }
        const at = Date.parse(node.createdAt);
        if (at < oldestSeen) oldestSeen = at;
        absorbDeployment(node);
      }
    },
    markExhausted() { exhausted = true; },
    /** Recent head events are complete, or Railway proved there is no more stream. */
    get done() {
      return exhausted || (
        oldestSeen < notBefore
        && (activeEvidenceServices.size > 0 || covered.size === wanted.size)
      );
    },
    result() {
      return {
        byService: new Map(
          [...byService].map(([serviceId, deployments]) => [
            serviceId,
            orderByRecency(deployments),
          ]),
        ),
        // Exhausting the stream proves a service genuinely has no running
        // deployment; running out of budget proves nothing.
        unresolved: exhausted ? [] : [...wanted].filter((id) => !covered.has(id)),
        oldestSeen,
      };
    },
  };
}
