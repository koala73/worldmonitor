// #10873 / #3936: an airport delay is critical only when the delays are long.
// The delayed share alone used to reach 'severe' (a critical notification), so
// "GRU: Avg 28min delay, 100% delayed" and "BOG: 20 min delay" both woke every
// realtime subscriber.
import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import { AIRPORTS, aviationDetermineSeverity, seedIntlDelays } from '../scripts/seed-aviation.mjs';

describe('aviationDetermineSeverity', () => {
  it('does not let the delayed share alone reach severe or major', () => {
    assert.equal(aviationDetermineSeverity(28, 100, 60), 'moderate');
    assert.equal(aviationDetermineSeverity(20, 80, 60), 'moderate');
    assert.equal(aviationDetermineSeverity(12, 90, 60), 'minor');
  });

  it('needs an hour of average delay for severe', () => {
    assert.equal(aviationDetermineSeverity(60, 20, 40), 'severe');
    assert.equal(aviationDetermineSeverity(59, 100, 40), 'major');
  });

  it('reaches major on 45 minutes, or 30 minutes across most flights', () => {
    assert.equal(aviationDetermineSeverity(45, 10, 40), 'major');
    assert.equal(aviationDetermineSeverity(30, 60, 40), 'major');
    assert.equal(aviationDetermineSeverity(30, 59, 40), 'moderate');
  });

  it('caps a small sample at moderate', () => {
    assert.equal(aviationDetermineSeverity(120, 100, 4), 'moderate');
    assert.equal(aviationDetermineSeverity(5, 50, 4), 'normal');
  });
});

const quietLogger = { log() {}, warn() {} };
const GRU = AIRPORTS.find((a) => a.iata === 'GRU');

test('a page of short delays on every flight is no longer a severe disruption', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    flight_status: 'active',
    departure: { scheduled: new Date(Date.now() - (i + 1) * 60_000).toISOString(), delay: 28 },
  }));
  const result = await seedIntlDelays({
    apiKey: 'fixture-key',
    airports: [GRU],
    logger: quietLogger,
    fetchFn: async () => Response.json({ pagination: { limit: 100, offset: 0, count: rows.length, total: rows.length }, data: rows }),
  });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].severity, 'FLIGHT_DELAY_SEVERITY_MODERATE');
});

test('classifies on the exact average, so 59.5 minutes is not an hour', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    flight_status: 'active',
    departure: { scheduled: new Date(Date.now() - (i + 1) * 60_000).toISOString(), delay: i < 5 ? 59 : 60 },
  }));
  const result = await seedIntlDelays({
    apiKey: 'fixture-key',
    airports: [GRU],
    logger: quietLogger,
    fetchFn: async () => Response.json({ pagination: { limit: 100, offset: 0, count: rows.length, total: rows.length }, data: rows }),
  });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].severity, 'FLIGHT_DELAY_SEVERITY_MAJOR');
  assert.match(result.alerts[0].reason, /Avg 60min/);
});
