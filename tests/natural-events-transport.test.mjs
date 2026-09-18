import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchNaturalEvents, naturalEventsAfterPublish } from '../scripts/seed-natural-events.mjs';

const NOW = Date.parse('2026-09-18T06:00:00Z');
const event = {
  id: 'eonet-recovered', title: 'Volcano', categories: [{ id: 'volcanoes' }],
  geometry: [{ type: 'Point', coordinates: [10, 20], date: new Date(NOW).toISOString() }],
  sources: [], closed: null,
};
const sourceOf = input => {
  const url = new URL(input);
  return url.hostname.includes('eonet') ? 'eonet'
    : url.hostname === 'www.gdacs.org' ? `gdacs:${url.searchParams.get('eventtype') || url.searchParams.get('eventlist')}`
      : url.pathname;
};
function fixture(fail) {
  const calls = new Map();
  return {
    calls,
    fetchFn: async (input, options) => {
      const source = sourceOf(input);
      const attempt = (calls.get(source) || 0) + 1;
      calls.set(source, attempt);
      const failure = await fail?.(source, attempt, options);
      return failure || (source === 'eonet' ? Response.json({ events: [event] })
        : Response.json({ type: 'FeatureCollection', features: source === 'gdacs:FL' ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [30, 40] }, properties: { eventtype: 'FL', eventid: 1, alertlevel: 'Orange', name: 'Flood', fromdate: new Date(NOW).toISOString() } }] : [] }));
    },
  };
}
const run = transport => fetchNaturalEvents({
  now: NOW, fetchFn: transport.fetchFn,
  fetchHkoWarningsFn: async () => ({ warnings: [], dataAvailable: true, sourceDecision: { status: 'used' } }),
});

test('transient EONET request and GDACS body failure recover without replaying companions', async () => {
  const transport = fixture((source, attempt) => {
    if (attempt !== 1) return;
    if (source === 'eonet') throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });
    if (source === 'gdacs:TC') return { ok: true, json: async () => { throw new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }); } };
  });
  const result = await run(transport);
  assert.deepEqual(naturalEventsAfterPublish(result).freshnessMetaPatch.failedSources, []);
  assert.equal(transport.calls.get('eonet'), 2);
  assert.equal(transport.calls.get('gdacs:TC'), 2);
  for (const [source, count] of transport.calls) {
    if (!['eonet', 'gdacs:TC'].includes(source)) assert.equal(count, 1, source);
  }
  assert.deepEqual(result.events.map(item => item.id), ['gdacs-FL-1', 'eonet-recovered']);
  assert.equal(result._sourceSnapshots.eonet.fetchedAt, NOW);
});
