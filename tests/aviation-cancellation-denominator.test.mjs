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

test('a page of future flights with some pre-cancellations is not a disruption', async () => {
  const rows = [
    ...Array.from({ length: 79 }, (_, i) => flight('scheduled', HOUR + i * 5 * 60_000)),
    ...Array.from({ length: 21 }, (_, i) => flight('cancelled', 2 * HOUR + i * 5 * 60_000)),
  ];
  assert.equal(await classify(rows), null);
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

// AviationStack writes departure times as the airport's local wall clock with a
// "+00:00" suffix. Riyadh is UTC+3 all year.
function riyadhFlight(status, offsetMs, { codeshared = false, ...extra } = {}) {
  const wall = new Date(Date.now() + offsetMs + 3 * HOUR).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  return {
    flight_status: status,
    flight: { codeshared: codeshared ? { airline_iata: 'SV', flight_iata: 'SV1' } : null },
    departure: { timezone: 'Asia/Riyadh', scheduled: wall, delay: null, ...extra },
  };
}

test('departure times are read in the airport time zone', async () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => riyadhFlight('cancelled', -(i + 1) * 2 * 60_000)),
    ...Array.from({ length: 70 }, (_, i) => riyadhFlight('scheduled', (i + 1) * 2 * 60_000)),
  ];
  // Read as UTC, every row is still three hours away and none is due.
  const alert = await classify(rows);
  assert.equal(alert.delayType, 'FLIGHT_DELAY_TYPE_CLOSURE');
  assert.equal(alert.totalFlights, 30);
});

test('a codeshare row is the same departure, counted once', async () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => riyadhFlight('landed', -(i + 1) * 60_000)),
    ...Array.from({ length: 20 }, (_, i) => riyadhFlight('cancelled', -(i + 1) * 60_000)),
    ...Array.from({ length: 40 }, (_, i) => riyadhFlight('cancelled', -(i + 1) * 60_000, { codeshared: true })),
  ];
  const alert = await classify(rows);
  assert.equal(alert.reason, '50% flights cancelled');
  assert.equal(alert.cancelledFlights, 20);
  assert.equal(alert.totalFlights, 40);
});

test('advance cancellations late in the day are not most flights cancelled', async () => {
  // Live 2026-10-25 17:59 UTC: the page was RUH's last 100 of 621 departures,
  // 20:40 to 23:55 local. 6 were due, 67 cancelled, 46 of those codeshares.
  const rows = [
    ...Array.from({ length: 6 }, () => riyadhFlight('active', -10 * 60_000)),
    ...Array.from({ length: 21 }, (_, i) => riyadhFlight('cancelled', HOUR + i * 5 * 60_000)),
    ...Array.from({ length: 46 }, (_, i) => riyadhFlight('cancelled', HOUR + i * 4 * 60_000, { codeshared: true })),
    ...Array.from({ length: 15 }, (_, i) => riyadhFlight('scheduled', HOUR + i * 9 * 60_000)),
    ...Array.from({ length: 12 }, (_, i) => riyadhFlight('scheduled', HOUR + i * 9 * 60_000, { codeshared: true })),
  ];
  assert.equal(await classify(rows), null);
});

test('a page of future flights almost all cancelled is still a closure', async () => {
  const rows = [
    ...Array.from({ length: 90 }, (_, i) => flight('cancelled', HOUR + i * 60_000)),
    ...Array.from({ length: 10 }, (_, i) => flight('scheduled', HOUR + i * 60_000)),
  ];
  const alert = await classify(rows);
  assert.equal(alert.delayType, 'FLIGHT_DELAY_TYPE_CLOSURE');
  assert.equal(alert.totalFlights, 100);
});

test('a delay alert from a page of future flights carries no cancellations', async () => {
  // get-airport-ops-summary rebuilds the cancellation rate from these fields.
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => flight('active', -10 * 60_000, { delay: i === 0 ? 20 : null })),
    ...Array.from({ length: 60 }, (_, i) => flight('cancelled', HOUR + i * 60_000)),
    ...Array.from({ length: 34 }, (_, i) => flight('scheduled', HOUR + i * 60_000)),
  ];
  const alert = await classify(rows);
  assert.ok(alert, 'the delay still raises an alert');
  assert.equal(alert.cancelledFlights, 0);
});

test('a page of only codeshare rows is omitted, not normal', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => riyadhFlight('scheduled', -(i + 1) * 60_000, { codeshared: true }));
  const result = await seedIntlDelays({
    apiKey: 'fixture-key',
    airports: [RUH],
    logger: quietLogger,
    fetchFn: async () => Response.json({ pagination: { limit: 100, offset: 0, count: rows.length, total: 20 }, data: rows }),
  });
  assert.equal(result.coverage[0].status, 'omitted');
  assert.equal(result.coverage[0].flightCount, 0);
});

test('the time zone offset is taken at the departure, not at the wall clock read as UTC', async (t) => {
  // Paris moves to summer time at 01:00 UTC on 2026-03-29. A 01:30 local
  // departure is 00:30 UTC; the offset at 01:30 UTC would put it at 23:30.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-29T00:00:00Z') });
  const paris = (status, wall) => ({
    flight_status: status,
    flight: { codeshared: null },
    departure: { timezone: 'Europe/Paris', scheduled: `2026-03-29T${wall}:00+00:00`, delay: null },
  });
  const rows = [
    ...Array.from({ length: 30 }, () => paris('cancelled', '01:30')),
    ...Array.from({ length: 70 }, () => paris('scheduled', '03:30')),
  ];
  assert.equal(await classify(rows), null);
});
