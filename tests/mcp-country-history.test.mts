import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { COUNTRY_HISTORY_TOOL } from '../api/mcp/registry/country-history-tool';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('MCP history normalizes country, validates days before fetch and carries the caller credential to the bounded reader', async () => {
  let calls = 0;
  const tool = COUNTRY_HISTORY_TOOL;
  assert.ok('_execute' in tool && tool._execute);
  const context = { kind: 'env_key' as const, apiKey: 'history-fixture' };
  globalThis.fetch = (async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.pathname, '/api/intelligence/v1/get-country-history');
    assert.equal(url.searchParams.get('country'), 'US');
    assert.equal(url.searchParams.get('days'), '365');
    assert.equal(new Headers(init?.headers).get('X-WorldMonitor-Key'), 'history-fixture');
    return Response.json({ country: 'US', allowedDays: 365, effectiveDays: 365, returnedDays: 0, points: [], upstreamUnavailable: false });
  }) as typeof fetch;
  await assert.rejects(tool._execute({ country_code: 'US', days: 366 }, 'https://api.worldmonitor.app', context));
  assert.equal(calls, 0);
  const result = await tool._execute({ country_code: 'us', days: 365 }, 'https://api.worldmonitor.app', context);
  assert.equal((result as { allowedDays: number }).allowedDays, 365);
  assert.equal(calls, 1);
});

test('history output budget preserves all score dates and labels reduced event selection', () => {
  const result = { points: [{ date: '2026-10-19', cii: { score: 0 }, keySignals: [], topEvents: [{ title: 'one' }, { title: 'two' }] }] };
  const reduced = COUNTRY_HISTORY_TOOL._fitToBudget!(result, 1048576, {}) as typeof result;
  assert.equal(reduced.points.length, 1);
  assert.equal(reduced.points[0]!.cii.score, 0);
  assert.equal(reduced.points[0]!.topEvents.length, 1);
  assert.deepEqual(reduced.points[0]!.keySignals, ['events_reduced_for_output_budget']);
  assert.equal(result.points[0]!.topEvents.length, 2);
});
