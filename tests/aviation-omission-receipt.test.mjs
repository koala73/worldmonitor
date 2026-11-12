import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIRPORTS, seedIntlDelays } from '../scripts/seed-aviation.mjs';

const airport = AIRPORTS.find(a => a.iata === 'CTU');
for (const [name, data, dataType, count] of [
  ['empty', [], 'array', 0],
  ['missing', undefined, 'missing', null],
  ['null', null, 'null', null],
  ['object', { secret: 'response-secret' }, 'object', null],
  ['string', 'response-secret', 'string', null],
  ['codeshares', [{ flight: { codeshared: { secret: 'response-secret' } } }], 'array', 1],
]) {
  test(`omission receipt distinguishes ${name} without exposing response values`, async () => {
    const logs = [];
    let date;
    const result = await seedIntlDelays({
      apiKey: 'credential-secret', airports: [airport],
      logger: { log() {}, warn: line => logs.push(line) },
      fetchFn: async url => {
        date = new URL(url).searchParams.get('flight_date');
        return Response.json({ data, pagination: { limit: 100, offset: 0, count: 0, total: 12, secret: 'response-secret' } });
      },
    });
    assert.equal(result.coverage[0].status, 'omitted');
    assert.equal(result.coverage[0].flightCount, 0);
    assert.equal(result.alerts.length, 0);
    const receipt = logs.find(line => line.startsWith('{'));
    assert.ok(receipt, 'structured omission receipt must be emitted');
    assert.deepEqual(JSON.parse(receipt), {
      event: 'aviationstack_omission', iata: 'CTU', requestDate: date, requestLimit: 100,
      httpStatus: 200, dataType, rawCount: count, operatingCount: 0,
      pagination: { limit: 100, offset: 0, count: 0, total: 12 },
    });
    assert.ok(receipt.length < 512);
    assert.ok(!logs.join('').includes('secret'));
  });
}

test('pagination receipt admits only nonnegative safe integers', async () => {
  const logs = [];
  await seedIntlDelays({ apiKey: 'secret', airports: [airport],
    logger: { log() {}, warn: line => logs.push(line) },
    fetchFn: async () => Response.json({ data: [], pagination: { limit: 'secret', offset: -1, count: 1.5, total: 1e100 } }),
  });
  const receipt = logs.find(line => line.startsWith('{'));
  assert.ok(receipt);
  assert.deepEqual(JSON.parse(receipt).pagination, { limit: null, offset: null, count: null, total: null });
  assert.ok(!receipt.includes('secret'));
});
