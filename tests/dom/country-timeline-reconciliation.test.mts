import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '@/components/CountryTimeline';
import type { CountryCoverageEvent } from '@/services/country-coverage';
import { reconcileCountryTimelineEvents } from '@/services/country-timeline-reconciliation';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-01T12:00:00Z');

function coverage(
  label: string,
  lane: CountryCoverageEvent['lane'] = 'protest',
  offsetHours = 0,
  source = 'Publisher A',
): CountryCoverageEvent {
  return {
    timestamp: NOW + offsetHours * HOUR,
    lane,
    label,
    severity: 'medium',
    source,
    link: `https://example.com/${encodeURIComponent(source)}`,
  };
}

describe('country timeline reconciliation', () => {
  it('collapses publisher variants of the same coverage story deterministically', () => {
    const older = coverage('French unions stage nationwide protest over pension reform', 'protest', -2, 'Publisher B');
    const newer = coverage('Nationwide pension reform protest staged by French unions', 'protest', 0, 'Publisher A');

    expect(reconcileCountryTimelineEvents([older, newer], [])).toEqual([newer]);
    expect(reconcileCountryTimelineEvents([newer, older], [])).toEqual([newer]);
  });

  it('lets a matching structured event replace coverage evidence', () => {
    const feedEvent = coverage('French unions stage nationwide protest over pension reform');
    const structured: TimelineEvent = {
      timestamp: NOW + HOUR,
      lane: 'protest',
      label: 'Nationwide pension reform protest staged by French unions',
      severity: 'high',
    };

    expect(reconcileCountryTimelineEvents([feedEvent], [structured])).toEqual([structured]);
  });

  it('keeps a distinct same-lane story and the same words in a different lane', () => {
    const first = coverage('French unions stage nationwide protest over pension reform');
    const distinct = coverage('Farmers block Paris roads over fuel taxes', 'protest', 2);
    const otherLane = coverage('Nationwide pension reform protest staged by French unions', 'conflict', 1);

    expect(reconcileCountryTimelineEvents([first, distinct, otherLane], [])).toHaveLength(3);
  });

  it('reconciles retained coverage when structured data arrives on a later refresh', () => {
    const feedEvent = coverage('M6.1 earthquake strikes southern France', 'natural');
    expect(reconcileCountryTimelineEvents([feedEvent], [])).toEqual([feedEvent]);

    const newlyArrived: TimelineEvent = {
      timestamp: NOW + 3 * HOUR,
      lane: 'natural',
      label: 'Magnitude 6.1 earthquake strikes southern France',
      severity: 'critical',
    };
    expect(reconcileCountryTimelineEvents([feedEvent], [newlyArrived])).toEqual([newlyArrived]);
  });
});
