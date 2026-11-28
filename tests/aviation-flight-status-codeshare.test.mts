// AviationStack answers a flight-number query with a row per marketing number.
// Each codeshare row carries `flight.codeshared` as one object naming its
// operating flight. get-flight-status typed it as an array and called .map on
// it, so any page holding a codeshare row came back as source "error".
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getFlightStatus } from '../server/worldmonitor/aviation/v1/get-flight-status.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const KEY = 'synthetic-flight-status-key';

const leg = {
  departure: { airport: 'Dubai', timezone: 'Asia/Dubai', iata: 'DXB', icao: 'OMDB', terminal: '3', gate: 'A12', delay: 21, scheduled: '2026-11-27T07:45:00+00:00', estimated: '2026-11-27T07:45:00+00:00', actual: '2026-11-27T08:06:00+00:00' },
  arrival: { airport: 'Heathrow', timezone: 'Europe/London', iata: 'LHR', icao: 'EGLL', terminal: '3', scheduled: '2026-11-27T11:40:00+00:00', estimated: '2026-11-27T11:32:00+00:00', actual: '2026-11-27T11:30:00+00:00' },
  flight_status: 'landed',
  aircraft: { registration: 'A6-EQA', iata: 'B77W', icao: 'B77W', icao24: '896430' },
};
const codeshareOfEk1 = { airline_name: 'emirates', airline_iata: 'ek', airline_icao: 'uae', flight_number: '1', flight_iata: 'ek1', flight_icao: 'uae1' };
const PAGE = [
  { ...leg, airline: { name: 'Emirates', iata: 'EK', icao: 'UAE' }, flight: { number: '1', iata: 'EK1', icao: 'UAE1', codeshared: null } },
  { ...leg, aircraft: null, airline: { name: 'Qantas', iata: 'QF', icao: 'QFA' }, flight: { number: '8001', iata: 'QF8001', icao: 'QFA8001', codeshared: codeshareOfEk1 } },
  { ...leg, aircraft: null, airline: { name: 'Garuda Indonesia', iata: 'GA', icao: 'GIA' }, flight: { number: '8887', iata: 'GA8887', icao: 'GIA8887', codeshared: codeshareOfEk1 } },
];

let page: unknown[];
beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = KEY;
  process.env.WS_RELAY_URL = 'https://relay.example.test';
  process.env.AVIATIONSTACK_MONTHLY_BUDGET = '100';
  process.env.AVIATIONSTACK_REQUEST_BUDGET = '50';
  delete process.env.LOCAL_API_MODE;
  const redis = installRedis({});
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'relay.example.test') return Response.json({ pagination: { count: page.length }, data: page });
    return redis.fetchImpl(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

function status(flightNumber: string) {
  const request = new Request(`https://api.worldmonitor.app/api/aviation/v1/get-flight-status?flight_number=${flightNumber}&date=2026-11-27`, {
    headers: { 'X-WorldMonitor-Key': KEY },
  });
  return getFlightStatus({ request, pathParams: {}, headers: {} } as never, { flightNumber, date: '2026-11-27', origin: '' } as never);
}

describe('flight status with codeshare rows', () => {
  it('folds the codeshare rows into their operating flight', async () => {
    page = PAGE;
    const result = await status('EK1');

    assert.equal(result.source, 'aviationstack');
    assert.equal(result.flights.length, 1);
    const [flight] = result.flights;
    assert.equal(flight!.flightNumber, 'EK1');
    assert.equal(flight!.operatingCarrier.iataCode, 'EK');
    assert.deepEqual(flight!.codeshareFlightNumbers, ['QF8001', 'GA8887']);
    assert.equal(flight!.status, 'FLIGHT_INSTANCE_STATUS_LANDED');
  });

  it('answers from codeshare rows alone when the operating row is off the page', async () => {
    page = PAGE.slice(1);
    const result = await status('QF8001');

    assert.equal(result.source, 'aviationstack');
    assert.deepEqual(result.flights.map(f => [f.flightNumber, f.operatingCarrier.iataCode, f.codeshareFlightNumbers]),
      [['EK1', 'EK', ['QF8001', 'GA8887']]]);
  });

  it('reads the provider wall clock in the airport time zone', async () => {
    page = PAGE;
    const [flight] = (await status('EK1')).flights;

    assert.equal(flight!.scheduledDeparture, Date.parse('2026-11-27T03:45:00Z'), '07:45 in Dubai');
    assert.equal(flight!.actualArrival, Date.parse('2026-11-27T11:30:00Z'), '11:30 in London');
  });
});
