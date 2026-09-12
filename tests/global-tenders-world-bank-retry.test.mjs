import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGlobalTenders, fetchTed, fetchWorldBank, sourceHealthMeta } from '../scripts/seed-global-tenders.mjs';

const NOW = Date.parse('2026-09-10T10:00:00Z');
const PAYLOAD = { procnotices: [{
  id: 'OP1', notice_type: 'Invitation for Bids', bid_description: 'Network services',
  project_ctry_code: 'IN', submission_deadline_date: '2026-10-01T00:00:00Z',
}] };

function provider(t, respond) {
  const calls = [];
  const waits = [];
  const timeouts = [];
  let elapsed = 0;
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    waits.push(ms);
    elapsed += ms;
    queueMicrotask(callback);
    return 0;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return respond({ elapsed, attempt: calls.length });
  });
  return { calls, waits, timeouts, elapse: (ms) => { elapsed += ms; }, elapsed: () => elapsed };
}

test('World Bank can recover after the former three-second retry window', async (t) => {
  const { calls, waits, timeouts } = provider(t, ({ elapsed }) => elapsed < 10_000
    ? new Response('upstream failure', { status: 500 })
    : Response.json(PAYLOAD));
  const result = await fetchWorldBank({ now: NOW });
  assert.deepEqual(waits, [5000, 10_000]);
  assert.equal(calls.length, 3);
  assert.deepEqual(timeouts, [20_000, 20_000, 20_000]);
  assert.equal(calls[0].options.retryDelayMs, undefined);
  assert.equal(new Set(calls.map((call) => call.url)).size, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/v2/procnotices');
  assert.equal(result.status.state, 'ok');
  assert.equal(result.records[0].id, 'world-bank:OP1');
});

test('other tender sources keep their existing retry interval', async (t) => {
  const { waits } = provider(t, ({ attempt }) => attempt < 3
    ? new Response('upstream failure', { status: 500 })
    : Response.json({ notices: [] }));
  const result = await fetchTed({ now: NOW });
  assert.equal(result.status.state, 'ok');
  assert.deepEqual(waits, [1000, 2000]);
});

test('exhausted World Bank retries retain data without advancing source success', async (t) => {
  const { calls, waits } = provider(t, () => new Response('upstream failure', { status: 500 }));
  const successfulAt = NOW - 60 * 60_000;
  const success = await fetchWorldBank({ now: successfulAt, fetchJsonFn: async () => PAYLOAD });
  let previousSnapshot = { tenders: success.records, sourceStatuses: [success.status], fetchedAt: successfulAt };
  for (const now of [NOW, NOW + 60 * 60_000]) {
    const snapshot = await fetchGlobalTenders({ now, previousSnapshot, adapters: [['world-bank', fetchWorldBank]] });
    assert.equal(snapshot.tenders.length, 1);
    assert.equal(snapshot.sourceStatuses[0].state, 'stale');
    assert.equal(snapshot.sourceStatuses[0].error, 'HTTP 500');
    assert.equal(snapshot.sourceStatuses[0].lastSuccessfulAt, new Date(successfulAt).toISOString());
    assert.equal(sourceHealthMeta(snapshot.sourceStatuses[0]).fetchedAt, successfulAt);
    assert.equal(sourceHealthMeta(snapshot.sourceStatuses[0]).sourceState, 'stale');
    previousSnapshot = snapshot;
  }
  assert.equal(calls.length, 6);
  assert.deepEqual(waits, [5000, 10_000, 5000, 10_000]);
});

test('World Bank permanent errors fail immediately', async (t) => {
  const { calls, waits } = provider(t, () => new Response('forbidden', { status: 403 }));
  await assert.rejects(fetchWorldBank({ now: NOW }), /HTTP 403/);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('World Bank distinguishes a valid empty response from malformed data', async (t) => {
  const { calls } = provider(t, ({ attempt }) => Response.json(attempt === 1 ? { procnotices: [] } : { error: 'unavailable' }));
  const result = await fetchWorldBank({ now: NOW });
  assert.deepEqual(result.records, []);
  assert.equal(result.status.state, 'ok');
  await assert.rejects(fetchWorldBank({ now: NOW }), /missing procnotices/);
  assert.equal(calls.length, 2);
});

test('World Bank retries a timeout while reading the response body', async (t) => {
  const { calls, waits } = provider(t, ({ attempt }) => attempt === 1
    ? { ok: true, json: async () => { throw new DOMException('body timeout', 'TimeoutError'); } }
    : Response.json(PAYLOAD));
  const result = await fetchWorldBank({ now: NOW });
  assert.equal(result.records.length, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [5000]);
});

test('World Bank retries truncated JSON before publishing a source result', async (t) => {
  const { calls } = provider(t, ({ attempt }) => attempt === 1
    ? new Response('{"procnotices":[')
    : Response.json(PAYLOAD));
  assert.equal((await fetchWorldBank({ now: NOW })).status.state, 'ok');
  assert.equal(calls.length, 2);
});

test('World Bank does not sleep through its source budget on Retry-After', async (t) => {
  const { calls, waits } = provider(t, () => new Response('', { status: 503, headers: { 'Retry-After': '120' } }));
  await assert.rejects(fetchWorldBank({ now: NOW }), /503/);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('malformed World Bank rows and incomplete windows are failures, not empty success', async () => {
  for (const payload of [
    { procnotices: [null] }, { procnotices: [{}] },
    { procnotices: [{ id: 'OP1', bid_description: 'Missing deadline' }] },
    { rows: 100, os: 0, total: '2', procnotices: PAYLOAD.procnotices },
  ]) {
    await assert.rejects(fetchWorldBank({ now: NOW, fetchJsonFn: async () => payload }), /World Bank/);
  }
});

test('World Bank failure without prior success never gains a success clock', () => {
  const status = { source: 'world-bank', state: 'error', fetchedAt: new Date(NOW).toISOString(), lastSuccessfulAt: '', recordCount: 0 };
  assert.equal(sourceHealthMeta(status).fetchedAt, 0);
});

test('persistent full-attempt timeouts consume at most 75 seconds and three attempts', async (t) => {
  const clock = provider(t, () => {
    clock.elapse(20_000);
    throw new DOMException('request timeout', 'TimeoutError');
  });
  t.mock.method(Date, 'now', () => NOW + clock.elapsed());
  await assert.rejects(fetchWorldBank({ now: NOW }), /timeout/);
  assert.equal(clock.calls.length, 3);
  assert.equal(clock.elapsed(), 75_000);
  assert.deepEqual(clock.timeouts, [20_000, 20_000, 20_000]);
});

test('Retry-After reduces the remaining attempt timeout instead of exceeding the source budget', async (t) => {
  const clock = provider(t, ({ attempt }) => {
    if (attempt === 1) return new Response('', { status: 503, headers: { 'Retry-After': '60' } });
    clock.elapse(clock.timeouts.at(-1));
    throw new DOMException('request timeout', 'TimeoutError');
  });
  t.mock.method(Date, 'now', () => NOW + clock.elapsed());
  await assert.rejects(fetchWorldBank({ now: NOW }), /timeout/);
  assert.equal(clock.calls.length, 2);
  assert.deepEqual(clock.timeouts, [20_000, 15_000]);
  assert.deepEqual(clock.waits, [60_000]);
  assert.equal(clock.elapsed(), 75_000);
});

test('repeated body failures use the same three-attempt cap and identify the failed phase', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const { calls, waits } = provider(t, () => new Response(new ReadableStream({ start(controller) {
    controller.error(new DOMException('body timeout', 'TimeoutError'));
  } })));
  await assert.rejects(fetchWorldBank({ now: NOW }), /body timeout/);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [5000, 10_000]);
  assert.equal(warnings.filter(line => /\[World-Bank\].*phase=body failure=TimeoutError/.test(line)).length, 3);
});
