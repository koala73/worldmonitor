import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectEscalationSignals,
  generateDisasterTitle,
  generateEscalationTitle,
  generateMilitaryTitle,
} from '../scripts/seed-correlation.mjs';

const now = Date.now();

const quake = (magnitude, place) => ({
  type: 'earthquake', source: 'usgs', severity: 50, lat: 35, lon: 139, timestamp: now,
  label: `M${magnitude.toFixed(1)} \u2014 ${place}`, magnitude,
});

const verifiedProtest = {
  title: 'Dockworkers march on parliament', country: 'France', eventType: 'UNREST_EVENT_TYPE_PROTEST',
  severity: 'SEVERITY_LEVEL_MEDIUM', sourceType: 'UNREST_SOURCE_TYPE_ACLED', confidence: 'CONFIDENCE_LEVEL_HIGH',
  occurredAt: now - 60_000, location: { latitude: 48.86, longitude: 2.35 },
};

const gdeltMention = {
  title: 'Lagos', country: 'Nigeria', eventType: 'UNREST_EVENT_TYPE_UNSPECIFIED',
  severity: 'SEVERITY_LEVEL_UNSPECIFIED', sourceType: 'UNREST_SOURCE_TYPE_GDELT', confidence: 'CONFIDENCE_LEVEL_LOW',
  summary: 'Unverified media signal. This location is mentioned in unrest-related articles; a local event is not verified.',
  occurredAt: now - 60_000, location: { latitude: 6.52, longitude: 3.38 },
};

describe('seeded correlation card text', () => {
  it('pairs the strongest earthquake magnitude with its own place', () => {
    const title = generateDisasterTitle([quake(4.6, 'Honshu, Japan'), quake(6.8, 'Hokkaido, Japan')]);
    assert.equal(title, 'Disaster cascade: M6.8 seismic \u2014 Hokkaido, Japan');
  });

  it('does not turn unverified media mentions into conflict signals', () => {
    const signals = collectEscalationSignals([verifiedProtest, gdeltMention], [], []);
    assert.deepEqual(signals.map(s => s.country), ['FR']);
  });

  it('labels unrest events with readable event types', () => {
    const [signal] = collectEscalationSignals([verifiedProtest], [], []);
    assert.equal(signal.label, 'Protest: Dockworkers march on parliament');
  });

  it('names the escalation country instead of its ISO code', () => {
    const title = generateEscalationTitle([{ type: 'conflict_event', country: 'FR' }]);
    assert.equal(title, 'conflict \u2014 France');
  });

  it('places military flight clusters at their centroid', () => {
    const flights = [
      { type: 'military_flight', country: 'USA', aircraftType: 'transport' },
      { type: 'military_flight', country: 'USA', aircraftType: 'transport' },
    ];
    assert.equal(
      generateMilitaryTitle(flights, undefined, { lat: 26.71, lon: -80.11 }),
      'Military flight cluster \u2014 USA near 26.7\u00b0N, 80.1\u00b0W',
    );
  });
});
