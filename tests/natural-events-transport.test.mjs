import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fetchNaturalEvents, naturalEventsAfterPublish } from '../scripts/seed-natural-events.mjs';

const NOW = Date.parse('2026-09-18T06:00:00Z');
const event = {
  id: 'eonet-recovered', title: 'Volcano', categories: [{ id: 'volcanoes' }],
  geometry: [{ type: 'Point', coordinates: [10, 20], date: new Date(NOW).toISOString() }],
  sources: [], closed: null,
};
const sourceOf = input => {
  const url = new URL(input);
  if (url.hostname.includes('eonet')) return 'eonet';
  if (url.hostname === 'www.gdacs.org') return `gdacs:${url.searchParams.get('eventtype') || url.searchParams.get('eventlist')}`;
  return url.pathname;
};
const flood = {
  type: 'Feature', geometry: { type: 'Point', coordinates: [30, 40] },
  properties: { eventtype: 'FL', eventid: 1, alertlevel: 'Orange', name: 'Flood', fromdate: new Date(NOW).toISOString() },
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
      if (failure) return failure;
      if (source === 'eonet') return Response.json({ events: [event] });
      return Response.json({ type: 'FeatureCollection', features: source === 'gdacs:FL' ? [flood] : [] });
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

test('retryable HTTP errors recover and cancel unread error bodies', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let cancelled = 0;
    const transport = fixture((source, attempt) => source === 'eonet' && attempt === 1 ? {
      ok: false, status, headers: new Headers(), body: { cancel: async () => { cancelled++; } },
    } : undefined);
    const result = await run(transport);
    assert.equal(transport.calls.get('eonet'), 2, String(status));
    assert.equal(cancelled, 1);
    assert.ok(result.events.some(item => item.id === event.id));
  }
});

test('permanent HTTP errors, invalid JSON and malformed source data are not retried', async () => {
  for (const response of [
    () => new Response('', { status: 400 }),
    () => new Response('', { status: 403 }),
    () => new Response('', { status: 404 }),
    () => new Response('broken json'),
    () => Response.json({ events: null }),
    () => Response.json({ events: [{ ...event, geometry: [] }] }),
  ]) {
    const transport = fixture(source => source === 'eonet' ? response() : undefined);
    const result = await run(transport);
    assert.equal(transport.calls.get('eonet'), 1);
    assert.deepEqual(naturalEventsAfterPublish(result).freshnessMetaPatch.failedSources, ['eonet']);
  }
});

test('Retry-After outside the source budget fails immediately without undercutting it', async () => {
  const transport = fixture(source => source === 'eonet'
    ? new Response('', { status: 429, headers: { 'Retry-After': '60' } }) : undefined);
  const result = await run(transport);
  assert.equal(transport.calls.get('eonet'), 1);
  assert.deepEqual(naturalEventsAfterPublish(result).freshnessMetaPatch.failedSources, ['eonet']);
});

test('exhaustion preserves last success and fixed expiry while companions succeed', async () => {
  const initial = await run(fixture());
  const transport = fixture(source => {
    if (source === 'eonet') throw new DOMException('aborted', 'TimeoutError');
  });
  const now = NOW + 3_600_000;
  const result = await fetchNaturalEvents({
    now, previousSources: initial._sourceSnapshots, fetchFn: transport.fetchFn,
    fetchHkoWarningsFn: async () => ({ warnings: [], dataAvailable: true, sourceDecision: { status: 'used' } }),
  });
  assert.equal(transport.calls.get('eonet'), 2);
  assert.equal(transport.calls.get('gdacs:FL'), 1);
  const source = naturalEventsAfterPublish(result).freshnessMetaPatch.sourceHealth.eonet;
  assert.equal(source.status, 'retained');
  assert.equal(source.lastSuccessAt, NOW);
  assert.equal(source.lastAttemptAt, now);
  assert.equal(result._sourceSnapshots.eonet.retainedUntil, NOW + 9 * 3_600_000);
});

test('safe diagnostics retain source, stage and code without raw error content', async t => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const transport = fixture(source => {
    if (source === 'eonet') throw new TypeError('https://user:secret@example.test?token=secret', {
      cause: Object.assign(new Error('credential secret'), { code: 'ECONNRESET' }),
    });
  });
  await run(transport);
  assert.match(logs.join('\n'), /eonet request ECONNRESET attempt=2 elapsedMs=\d+/);
  assert.doesNotMatch(logs.join('\n'), /secret|example\.test/);
});

test('elapsed request time reduces the next timeout within the shared deadline', async t => {
  const durations = [];
  const originalTimeout = AbortSignal.timeout;
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(AbortSignal, 'timeout', ms => {
    durations.push(ms);
    return originalTimeout(ms);
  });
  const transport = fixture((source, attempt) => {
    if (source !== 'eonet') return;
    if (attempt === 1) {
      clock = 20_000;
      return new Response('', { status: 503 });
    }
  });
  const result = await run(transport);
  assert.equal(transport.calls.get('eonet'), 2);
  assert.equal(durations.at(-1), 10_500);
  assert.ok(result.events.some(item => item.id === event.id));
});

test('native fetch covers header and body stalls and exhausts within the source deadline', { timeout: 40_000 }, async t => {
  let eonetRequests = 0;
  let tcRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/eonet') {
      if (++eonetRequests === 1) return;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ events: [event] }));
    } else {
      tcRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"features":');
    }
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transport = fixture((source, _attempt, options) => {
    if (source === 'eonet' || source === 'gdacs:TC') {
      return fetch(`${origin}/${source === 'eonet' ? 'eonet' : 'tc'}`, options);
    }
  });
  const started = performance.now();
  const result = await run(transport);
  const elapsed = performance.now() - started;
  assert.equal(eonetRequests, 2);
  assert.equal(tcRequests, 2);
  assert.equal(transport.calls.get('gdacs:FL'), 1);
  assert.ok(result.events.some(item => item.id === event.id));
  assert.deepEqual(naturalEventsAfterPublish(result).freshnessMetaPatch.failedSources, ['gdacs:TC']);
  assert.ok(elapsed >= 29_000, `elapsed ${elapsed}ms`);
});

test('Retry-After is honored and an elapsed deadline prevents a late retry', async t => {
  const originalDelay = process.env.WM_SEED_RETRY_DELAY_MS;
  delete process.env.WM_SEED_RETRY_DELAY_MS;
  t.after(() => {
    if (originalDelay === undefined) delete process.env.WM_SEED_RETRY_DELAY_MS;
    else process.env.WM_SEED_RETRY_DELAY_MS = originalDelay;
  });
  let clock = 0;
  const waits = [];
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    waits.push(delay);
    clock = 31_000;
    queueMicrotask(callback);
  });
  const transport = fixture(source => source === 'eonet'
    ? new Response('', { status: 429, headers: { 'Retry-After': '2' } }) : undefined);
  const result = await run(transport);
  assert.deepEqual(waits, [2000]);
  assert.equal(transport.calls.get('eonet'), 1);
  assert.deepEqual(naturalEventsAfterPublish(result).freshnessMetaPatch.failedSources, ['eonet']);
});

test('an errored response body cannot turn a permanent HTTP status into a retry', async () => {
  const transport = fixture(source => source === 'eonet' ? {
    ok: false, status: 404, headers: new Headers(),
    body: { cancel: async () => { throw new TypeError('stream already errored'); } },
  } : undefined);
  const result = await run(transport);
  assert.equal(transport.calls.get('eonet'), 1);
  assert.deepEqual(naturalEventsAfterPublish(result).freshnessMetaPatch.failedSources, ['eonet']);
});
