import type { CountryCoverageEvent } from './country-coverage';
// The canonical story matcher is dependency-free JavaScript shared with server jobs.
import { isSameStory } from '../../shared/story-identity.js';

const STORY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CountryTimelineEvent {
  timestamp: number;
  lane: CountryCoverageEvent['lane'];
  label: string;
  severity?: CountryCoverageEvent['severity'];
}

function matches(a: CountryTimelineEvent, b: CountryTimelineEvent): boolean {
  return a.lane === b.lane
    && Math.abs(a.timestamp - b.timestamp) <= STORY_WINDOW_MS
    && isSameStory(a.label, b.label);
}

function compareCoverage(a: CountryCoverageEvent, b: CountryCoverageEvent): number {
  return b.timestamp - a.timestamp
    || a.lane.localeCompare(b.lane)
    || a.label.localeCompare(b.label)
    || (a.source ?? '').localeCompare(b.source ?? '')
    || (a.link ?? '').localeCompare(b.link ?? '');
}

/** Reconcile feed-derived evidence with authoritative structured timeline data. */
export function reconcileCountryTimelineEvents(
  coverageEvents: readonly CountryCoverageEvent[],
  structuredEvents: readonly CountryTimelineEvent[],
): CountryTimelineEvent[] {
  const retainedCoverage: CountryCoverageEvent[] = [];
  for (const candidate of [...coverageEvents].sort(compareCoverage)) {
    if (structuredEvents.some(event => matches(candidate, event))) continue;
    if (retainedCoverage.some(event => matches(candidate, event))) continue;
    retainedCoverage.push(candidate);
  }

  return [...structuredEvents, ...retainedCoverage].sort((a, b) => (
    b.timestamp - a.timestamp
    || a.lane.localeCompare(b.lane)
    || a.label.localeCompare(b.label)
  ));
}
