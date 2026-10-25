import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tpsSeedDefinition } from '../scripts/lib/tps-seed-runner.mjs';
import { fetchTpsCallsAttended } from '../scripts/lib/tps-open-data.mjs';

test('failed TPS fetches retain safe cause evidence without changing last-good handling', async (t) => {
  const events = [];
  t.mock.method(console, 'warn', (line) => events.push(JSON.parse(line)));
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  for (const [kind, reason, status, expected] of [
    ['calls', 'http_503:calls:package', 503, { reason: 'http_503', stage: 'package' }],
    ['calls', 'timeout:calls', null, { reason: 'timeout', stage: 'source' }],
    ['mci', 'upstream_error:mci:private-response-token', 200, { reason: 'upstream_error', stage: 'source' }],
  ]) {
    const fetchResult = async () => {
      now += 32_000;
      return { ok: false, reason, status };
    };
    const definition = tpsSeedDefinition(kind, { fetchCalls: fetchResult, fetchMci: fetchResult });
    const snapshot = await definition.fetchSnapshot();
    assert.equal(snapshot.sourceReason, reason);
    assert.equal(definition.validateFn(snapshot), false);
    assert.deepEqual(events.at(-1), {
      event: 'tps_source_failure', source: kind, ...expected, status, elapsedMs: 32_000,
    });
  }
  assert.equal(events.length, 3);
  assert.ok(!JSON.stringify(events).includes('private-response-token'));
});

test('successful TPS fetches return the original snapshot without failure logs', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const snapshot = { records: [] };
  const definition = tpsSeedDefinition('calls', { fetchCalls: async () => ({ ok: true, snapshot }) });
  assert.equal(await definition.fetchSnapshot(), snapshot);
  assert.equal(warn.mock.callCount(), 0);
});

test('a real package HTTP failure reaches the runner log without response contents', async (t) => {
  const events = [];
  t.mock.method(console, 'warn', (line) => events.push(JSON.parse(line)));
  const definition = tpsSeedDefinition('calls', {
    fetchCalls: () => fetchTpsCallsAttended({
      fetchImpl: async () => new Response('private provider body', { status: 503 }),
    }),
  });
  const snapshot = await definition.fetchSnapshot();
  assert.equal(snapshot.sourceReason, 'http_503:calls:package');
  assert.equal(definition.validateFn(snapshot), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'http_503');
  assert.equal(events[0].stage, 'package');
  assert.equal(events[0].status, 503);
  assert.ok(events[0].elapsedMs >= 0);
  assert.ok(!JSON.stringify(events).includes('private provider body'));
});
