import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTransitWindow, TRANSIT_WINDOW_MS } from '../shared/chokepoint-transit-window.js';

const now = 1_790_000_000_000;
const crossing = (ts, mmsi = '123456789', type = 'tanker') => ({ ts, mmsi, type });

function store() {
  const events = new Map();
  return async (_script, keys, args) => {
    assert.deepEqual(keys, ['supply_chain:chokepoint-crossings:v1']);
    const [at, window, ttl, batch] = args;
    assert.ok(Number(ttl) * 1000 > Number(window));
    for (const row of JSON.parse(batch)) events.set(JSON.stringify(row), row[3]);
    for (const [member, ts] of events) if (ts <= Number(at) - Number(window)) events.delete(member);
    return [...events].filter(([, ts]) => ts <= Number(at)).sort((a, b) => a[1] - b[1]).map(([member]) => member);
  };
}

test('a restart retains published crossings with their original expiry', async () => {
  const evaluate = store();
  const input = new Map([['Strait of Hormuz', [crossing(now - 1000)]]]);
  assert.equal((await readTransitWindow(input, now, evaluate)).get('Strait of Hormuz').length, 1);
  const restarted = await readTransitWindow(new Map(), now + 60_000, evaluate);
  assert.deepEqual(restarted.get('Strait of Hormuz'), input.get('Strait of Hormuz'));
  assert.equal((await readTransitWindow(new Map(), now + TRANSIT_WINDOW_MS, evaluate)).size, 0);
});

test('retries and overlapping relays do not double-count the same crossing', async () => {
  const evaluate = store();
  const input = new Map([['Dover Strait', [crossing(now - 5000)]]]);
  await readTransitWindow(input, now, evaluate);
  assert.equal((await readTransitWindow(input, now, evaluate)).get('Dover Strait').length, 1);
  const otherRelay = new Map([['Dover Strait', [crossing(now - 4000), crossing(now - 3000, '987654321', 'cargo')]]]);
  const result = await readTransitWindow(otherRelay, now, evaluate);
  assert.equal(result.get('Dover Strait').length, 2);
});

test('durable read failure does not become an empty or local-only window', async () => {
  await assert.rejects(readTransitWindow(new Map(), now, async () => null), /transit window/i);
  await assert.rejects(readTransitWindow(new Map(), now, async () => ['invalid']), /transit window/i);
});

test('shifted duplicates cannot revive a crossing after its original expiry', async () => {
  const evaluate = store();
  await readTransitWindow(new Map([['Dover Strait', [crossing(now)]]]), now, evaluate);
  const duplicate = new Map([['Dover Strait', [crossing(now + 29 * 60_000)]]]);
  await readTransitWindow(duplicate, now + 29 * 60_000, evaluate);
  for (const minutes of [0, 1, 28, 29, 30]) {
    assert.equal((await readTransitWindow(duplicate, now + TRANSIT_WINDOW_MS + minutes * 60_000, evaluate)).size, 0);
  }
});

test('a later crossing survives the cooldown and other waterways stay independent', async () => {
  const evaluate = store();
  const input = new Map([
    ['Dover Strait', [crossing(now - 31 * 60_000), crossing(now - 1000)]],
    ['Gibraltar Strait', [crossing(now - 1000)]],
  ]);
  const result = await readTransitWindow(input, now, evaluate);
  assert.equal(result.get('Dover Strait').length, 2);
  assert.equal(result.get('Gibraltar Strait').length, 1);
});
