import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  SIGNAL_AGGREGATOR_MAX_SIGNALS,
  signalAggregator,
} from '@/services/signal-aggregator';

describe('signalAggregator caps retained singleton state', () => {
  beforeEach(() => {
    signalAggregator.clear();
  });

  it('keeps the newest signals when ingestion exceeds the cap', () => {
    signalAggregator.ingestTemporalAnomalies(
      Array.from({ length: SIGNAL_AGGREGATOR_MAX_SIGNALS + 50 }, (_, index) => ({
        type: `cap-${index}`,
        region: `Region ${index}`,
        currentCount: index + 1,
        expectedCount: 0,
        zScore: 10,
        message: `Temporal signal ${index}`,
        severity: 'high' as const,
      })),
    );

    assert.equal(signalAggregator.getSignalCount(), SIGNAL_AGGREGATOR_MAX_SIGNALS);
    assert.equal(signalAggregator.getSummary().totalSignals, SIGNAL_AGGREGATOR_MAX_SIGNALS);

    const titles = new Set(signalAggregator.getSummary().topCountries.flatMap((cluster) => cluster.signals.map((signal) => signal.title)));
    assert.equal(titles.has('Temporal signal 0'), false, 'oldest overflow signal should be trimmed');
    assert.equal(
      titles.has(`Temporal signal ${SIGNAL_AGGREGATOR_MAX_SIGNALS + 49}`),
      true,
      'newest overflow signal should be retained',
    );
  });

  it('clear resets retained signals and theater-posture references', () => {
    signalAggregator.ingestTheaterPostures([
      {
        targetNation: 'Iran',
        totalAircraft: 4,
        totalVessels: 3,
        postureLevel: 'elevated',
        theaterName: 'Gulf',
      },
    ]);
    assert.equal(signalAggregator.getSignalCount(), 2);

    signalAggregator.clear();
    assert.equal(signalAggregator.getSignalCount(), 0);

    signalAggregator.ingestTheaterPostures([]);
    assert.equal(signalAggregator.getSignalCount(), 0);
  });
});
