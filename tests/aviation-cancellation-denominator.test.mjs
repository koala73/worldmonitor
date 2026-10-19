// AviationStack's first 100 departures for a busy hub are the day's LATEST
// flights, so for most of the day the page holds no departed flight at all.
// Dividing cancellations by "resolved" rows then turned a page of future
// pre-cancellations into cancelled/cancelled = 100%, and Riyadh (RUH) stayed
// "Airport closure / airspace restrictions" (22/22) on 2026-10-19 after it had
// reopened. The fixture below mirrors that live page: 79 scheduled + 21
// cancelled rows, every one scheduled after the fetch.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AIRPORTS, seedIntlDelays } from '../scripts/seed-aviation.mjs';

const RUH = AIRPORTS.find((a) => a.iata === 'RUH');
const HOUR = 3_600_000;
const quietLogger = { log() {}, warn() {} };

function flight(status, offsetMs, extra = {}) {
  return {
    flight_status: status,
    departure: { scheduled: new Date(Date.now() + offsetMs).toISOString(), delay: null, ...extra },
  };
}

async function classify(rows) {
  const result = await seedIntlDelays({
    apiKey: 'fixture-key',
    airports: [RUH],
    logger: quietLogger,
    fetchFn: async () => Response.json({ pagination: { limit: 100, offset: 0, count: rows.length, total: 515 }, data: rows }),
  });
  assert.equal(result.coverage[0].status, result.alerts.length ? 'disruption' : 'normal');
  return result.alerts[0] ?? null;
}

test('a page of future flights with some pre-cancellations is not an airport closure', async () => {
  const rows = [
    ...Array.from({ length: 79 }, (_, i) => flight('scheduled', HOUR + i * 5 * 60_000)),
    ...Array.from({ length: 21 }, (_, i) => flight('cancelled', 2 * HOUR + i * 5 * 60_000)),
  ];
  const alert = await classify(rows);
  assert.ok(alert, '21% of the page is cancelled, which is still a disruption');
  assert.notEqual(alert.delayType, 'FLIGHT_DELAY_TYPE_CLOSURE');
  assert.notEqual(alert.severity, 'FLIGHT_DELAY_SEVERITY_SEVERE');
  assert.equal(alert.reason, '21% flights cancelled');
  assert.equal(alert.cancelledFlights, 21);
  assert.equal(alert.totalFlights, 100);
});

test('flights already due and all cancelled are still a closure', async () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => flight('cancelled', -(i + 1) * 10 * 60_000)),
    ...Array.from({ length: 70 }, (_, i) => flight('scheduled', (i + 1) * 5 * 60_000)),
  ];
  const alert = await classify(rows);
  assert.equal(alert.delayType, 'FLIGHT_DELAY_TYPE_CLOSURE');
  assert.equal(alert.severity, 'FLIGHT_DELAY_SEVERITY_SEVERE');
  assert.equal(alert.cancelledFlights, 30);
  assert.equal(alert.totalFlights, 30);
});

test('the cancellation rate among due flights ignores future scheduled rows (#1209)', async () => {
  const rows = [
    ...Array.from({ length: 24 }, (_, i) => flight('cancelled', -(i + 1) * 5 * 60_000)),
    ...Array.from({ length: 16 }, (_, i) => flight('landed', -(i + 1) * 5 * 60_000)),
    ...Array.from({ length: 60 }, (_, i) => flight('scheduled', (i + 1) * 5 * 60_000)),
  ];
  const alert = await classify(rows);
  assert.equal(alert.delayType, 'FLIGHT_DELAY_TYPE_GROUND_STOP');
  assert.equal(alert.reason, '60% flights cancelled');
  assert.equal(alert.totalFlights, 40);
});

test('delays are measured over the same flights as the denominator', async () => {
  // Live 2026-10-19: BCN "179% delayed", PVG "142% delayed", both SEVERE.
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => flight('landed', -(i + 1) * 5 * 60_000, { delay: i < 6 ? 20 : null })),
    ...Array.from({ length: 88 }, (_, i) => flight('scheduled', (i + 1) * 5 * 60_000, { delay: i < 40 ? 30 : null })),
  ];
  const alert = await classify(rows);
  assert.equal(alert.delayedFlightsPct, 50);
  assert.equal(alert.avgDelayMinutes, 20);
  assert.equal(alert.totalFlights, 12);
  assert.equal(alert.reason, 'Avg 20min delay, 50% delayed');
});

test('a departed flight counts as due even when its schedule is later than now', async () => {
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => flight('active', 10 * 60_000, { delay: i < 6 ? 20 : null })),
    ...Array.from({ length: 88 }, (_, i) => flight('scheduled', HOUR + i * 60_000, { delay: i < 40 ? 30 : null })),
  ];
  // Ignoring 'active' would leave no due flight and fall back to the whole
  // page: 46/100 delayed at ~29min. Counting it gives 6/12 at 20min.
  const alert = await classify(rows);
  assert.equal(alert.totalFlights, 12);
  assert.equal(alert.delayedFlightsPct, 50);
  assert.equal(alert.avgDelayMinutes, 20);
});
