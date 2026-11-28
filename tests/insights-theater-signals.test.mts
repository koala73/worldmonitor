import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { signalAggregator } from '@/services/signal-aggregator';

// Insights feeds the published theater posture into the signal aggregator. The
// posture cache returns null once it expires, and theater signals otherwise
// live for the aggregator's 24-hour window, so an empty posture list must clear
// them rather than leave old military activity in the focal points.

const posture = {
  targetNation: 'Iran', totalAircraft: 9, totalVessels: 3, postureLevel: 'elevated' as const, theaterName: 'Iran Theater',
};
const theaterSignals = () => signalAggregator.getSummary().topCountries
  .flatMap((cluster) => cluster.signals)
  .filter((signal) => signal.type === 'military_flight' || signal.type === 'military_vessel');

describe('Insights theater-posture signals', () => {
  beforeEach(() => signalAggregator.clear());

  it('an empty posture list clears the theater signals an earlier list added', () => {
    signalAggregator.ingestTheaterPostures([posture]);
    assert.ok(theaterSignals().length > 0);
    signalAggregator.ingestTheaterPostures([]);
    assert.equal(theaterSignals().length, 0);
  });

  it('InsightsPanel ingests the posture list even when it is empty', () => {
    const source = readFileSync(new URL('../src/components/InsightsPanel.ts', import.meta.url), 'utf8');
    assert.equal((source.match(/ingestTheaterPostures\(/g) ?? []).length, 2);
    assert.doesNotMatch(source, /if \(theaterPostures\.length > 0\) \{\s*signalAggregator\.ingestTheaterPostures/);
  });
});
