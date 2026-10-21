/**
 * #4923: pure "new since your last visit" partition, extracted from
 * NewsPanel's first render so the behavior is unit-testable (review
 * finding on PR #4926 — a source-regex test cannot catch broken wiring).
 *
 * SEMANTIC DECISION (explicit, revisit deliberately): a cluster counts as
 * new-since-away when its `firstSeen` — the EARLIEST article in the
 * cluster — postdates the previous visit. Genuinely new stories flag NEW;
 * a long-running story that merely gained an update while away does NOT
 * (using lastUpdated would keep rolling stories perpetually NEW on every
 * return, which trains users to ignore the signal).
 *
 * prevVisitAt <= 0 means "no known previous visit" — everything is seen,
 * matching the pre-#4923 first-render behavior.
 */

export interface NewSinceVisitCluster {
  id: string;
  firstSeen: Date | string | number;
}

export function computeNewSinceVisit(
  clusters: readonly NewSinceVisitCluster[],
  prevVisitAt: number,
): { newIds: string[]; seenIds: string[] } {
  const newIds: string[] = [];
  const seenIds: string[] = [];
  for (const cluster of clusters) {
    const firstSeenMs = new Date(cluster.firstSeen).getTime();
    if (prevVisitAt > 0 && Number.isFinite(firstSeenMs) && firstSeenMs > prevVisitAt) {
      newIds.push(cluster.id);
    } else {
      seenIds.push(cluster.id);
    }
  }
  return { newIds, seenIds };
}
