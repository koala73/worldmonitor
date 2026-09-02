import { clusterTexts, isSameStory } from '../../shared/story-identity.js';

export type CountryTimelineLane = 'protest' | 'conflict' | 'natural' | 'military';
export type CountryTimelineSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface CountryTimelineIncident {
  timestamp: number;
  lane: CountryTimelineLane;
  label: string;
  severity: CountryTimelineSeverity;
}

/** Same-lane coverage reprints of one incident are clustered inside this window. */
export const COVERAGE_CLUSTER_WINDOW_MS = 36 * 60 * 60 * 1000;

const SEVERITY_RANK: Record<CountryTimelineSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function splitByTimeWindow<T extends CountryTimelineIncident>(members: T[]): T[][] {
  const sorted = [...members].sort((a, b) => a.timestamp - b.timestamp || a.label.localeCompare(b.label));
  const groups: T[][] = [];
  let current: T[] = [];
  for (const member of sorted) {
    const first = current[0];
    if (first && member.timestamp - first.timestamp > COVERAGE_CLUSTER_WINDOW_MS) {
      groups.push(current);
      current = [];
    }
    current.push(member);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function representCluster<T extends CountryTimelineIncident>(members: T[]): T {
  const [earliest] = [...members].sort((a, b) => a.timestamp - b.timestamp || a.label.localeCompare(b.label));
  if (!earliest) {
    throw new Error('country timeline cluster must contain at least one incident');
  }
  let severity = earliest.severity;
  for (const member of members) {
    if (SEVERITY_RANK[member.severity] > SEVERITY_RANK[severity]) severity = member.severity;
  }
  return { ...earliest, severity };
}

export function clusterCountryTimelineIncidents<T extends CountryTimelineIncident>(
  events: readonly T[],
): T[] {
  const byLane = new Map<CountryTimelineLane, T[]>();
  for (const event of events) {
    const laneEvents = byLane.get(event.lane);
    if (laneEvents) laneEvents.push(event);
    else byLane.set(event.lane, [event]);
  }

  const clustered: T[] = [];
  for (const laneEvents of byLane.values()) {
    for (const memberIndices of clusterTexts(laneEvents.map(event => event.label))) {
      const storyMembers = memberIndices.map(index => laneEvents[index]).filter(
        (event): event is T => event !== undefined,
      );
      for (const windowMembers of splitByTimeWindow(storyMembers)) {
        clustered.push(representCluster(windowMembers));
      }
    }
  }
  return clustered.sort((a, b) => a.timestamp - b.timestamp || a.label.localeCompare(b.label));
}

export function incidentsMatchSameCoverage(
  left: CountryTimelineIncident,
  right: CountryTimelineIncident,
): boolean {
  return left.lane === right.lane
    && Math.abs(left.timestamp - right.timestamp) <= COVERAGE_CLUSTER_WINDOW_MS
    && isSameStory(left.label, right.label);
}

/**
 * Keep structured records, drop coverage reprints that describe the same
 * same-lane incident, and cluster leftover coverage articles.
 */
export function reconcileCountryTimelineIncidents<T extends CountryTimelineIncident>(
  coverageEvents: readonly T[],
  structuredEvents: readonly T[],
): T[] {
  const clusteredCoverage = clusterCountryTimelineIncidents(coverageEvents);
  const unmatchedCoverage = clusteredCoverage.filter(coverage =>
    !structuredEvents.some(structured => incidentsMatchSameCoverage(coverage, structured)),
  );
  return [...structuredEvents, ...unmatchedCoverage]
    .sort((a, b) => a.timestamp - b.timestamp || a.label.localeCompare(b.label));
}
