import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getFlightStatus } from '../server/worldmonitor/aviation/v1/get-flight-status.ts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { drainResponseHeaders } from '../server/_shared/response-headers.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const PATH = '/api/aviation/v1/get-flight-status';
const KEY = 'synthetic-flight-status-key';
const valid = { flightNumber: 'EK03', date: '2028-02-29', origin: 'DXB' };
let calls: URL[];
let budgetReservations: number;
let redis: ReturnType<typeof installRedis>;
beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = KEY;
  process.env.WS_RELAY_URL = 'https://relay.example.test';
  process.env.AVIATIONSTACK_MONTHLY_BUDGET = '100';
  process.env.AVIATIONSTACK_REQUEST_BUDGET = '50';
  delete process.env.LOCAL_API_MODE;
  calls = [];
  budgetReservations = 0;
  redis = installRedis({});
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === 'relay.example.test') return Response.json({ data: [{ flight: { iata: 'EK3' }, departure: { iata: 'DXB', scheduled: '2028-02-29T10:00:00Z' }, arrival: { iata: 'LHR' }, flight_status: 'scheduled' }] });
    if (url.hostname === 'redis.example' && url.pathname === '/pipeline' && init?.body) {
      const commands = JSON.parse(String(init.body));
      if (commands[0]?.[0] === 'INCRBY') {
        budgetReservations += Number(commands[0][2]);
        return Response.json([{ result: budgetReservations }, { result: 1 }]);
      }
    }
    return redis.fetchImpl(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
function request(params: Record<string, string> = {}, authenticated = true) {
  return new Request(`https://api.worldmonitor.app${PATH}?${new URLSearchParams({ flight_number: 'EK03', date: valid.date, ...params })}`, {
    headers: authenticated ? { 'X-WorldMonitor-Key': KEY } : {},
  });
}
function ctx(req = request()) { return { request: req, pathParams: {}, headers: {} }; }
const gateway = createDomainGateway(createAviationServiceRoutes(aviationHandler, serverOptions));
const relayCalls = () => calls.filter(url => url.hostname === 'relay.example.test');

describe('flight-status origin and date boundary', () => {
  for (const [field, value] of [
    ['origin', 'DXB:nonce'], ['origin', 'A'.repeat(1000)], ['origin', 'KJFK'], ['origin', 'AB1'],
    ['date', 'xxxxxxxxxx'], ['date', '2028-13-01'], ['date', '2027-02-29'], ['date', '2028-04-31'],
  ]) {
    it(`rejects invalid ${field} before cache, budget or relay I/O: ${value.slice(0, 20)}`, async () => {
      const context = ctx();
      const result = await getFlightStatus(context, { ...valid, [field]: value });
      assert.deepEqual(result, { flights: [], source: 'invalid', cacheHit: false });
      assert.equal(calls.length, 0);
      assert.equal(redis.redis.size, 0);
      assert.equal(budgetReservations, 0);
      assert.equal(drainResponseHeaders(context.request)?.['X-No-Cache'], '1');
    });
  }

  it('preserves valid leap day, flight-number normalization and origin case cache reuse', async () => {
    const cold = await getFlightStatus(ctx(), { ...valid, origin: 'dxb' });
    const warm = await getFlightStatus(ctx(), { ...valid, flightNumber: 'EK3' });
    assert.equal(cold.source, 'aviationstack');
    assert.equal(cold.cacheHit, false);
    assert.equal(warm.cacheHit, true);
    assert.equal(warm.flights[0]?.flightNumber, 'EK3');
    assert.equal(relayCalls().length, 1);
    assert.equal(budgetReservations, 1);
    assert.equal(relayCalls()[0]!.searchParams.get('dep_iata'), 'DXB');
    assert.equal(relayCalls()[0]!.searchParams.get('flight_iata'), 'EK3');
    assert.equal(relayCalls()[0]!.searchParams.get('flight_date'), valid.date);
  });

  it('preserves empty date default and omitted origin in the handler', async () => {
    const result = await getFlightStatus(ctx(), { ...valid, date: '', origin: '' });
    assert.equal(result.source, 'aviationstack');
    assert.equal(relayCalls()[0]!.searchParams.get('flight_date'), new Date().toISOString().slice(0, 10));
    assert.equal(relayCalls()[0]!.searchParams.has('dep_iata'), false);
  });

  it('returns invalid/no-store through the real generated gateway', async () => {
    const response = await gateway(request({ origin: 'DXB:nonce' }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).source, 'invalid');
    assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
    assert.equal(relayCalls().length, 0);
    assert.ok([...redis.redis.keys()].every(key => !key.startsWith('aviation:status:') && !key.startsWith('aviation:avstack:calls:')));
  });

  it('retains the existing generated gateway rejection of an empty date', async () => {
    const response = await gateway(request({ date: '', origin: '' }));
    assert.equal(response.status, 400);
    assert.equal(relayCalls().length, 0);
  });

  it('accepts an omitted origin through the generated gateway with a valid date', async () => {
    const response = await gateway(request());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).source, 'aviationstack');
    assert.equal(relayCalls()[0]!.searchParams.has('dep_iata'), false);
  });

  it('keeps authentication ahead of input inspection', async () => {
    const response = await gateway(request({ origin: 'DXB:nonce' }, false));
    assert.ok([401, 403].includes(response.status));
    assert.equal(relayCalls().length, 0);
  });
});
