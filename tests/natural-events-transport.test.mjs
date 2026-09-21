import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import dns from 'node:dns';
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

function dualFamilyFailure() {
  return new TypeError('fetch failed', { cause: Object.assign(new AggregateError([
    Object.assign(new Error(), { code: 'ETIMEDOUT', syscall: 'connect', address: '127.0.0.1' }),
    Object.assign(new Error(), { code: 'ENETUNREACH', syscall: 'connect', address: '::1' }),
  ]), { code: 'ETIMEDOUT' }) });
}

test('EONET retries the dual-family connect failure over IPv4 and destroys its dispatcher', async t => {
  const server = createServer((_req, res) => { res.end(JSON.stringify({ events: [event] })); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const lookup = dns.lookup;
  const families = [];
  t.mock.method(dns, 'lookup', (host, options, callback) => {
    if (host !== 'eonet.fixture.invalid') return lookup(host, options, callback);
    families.push(options.family);
    process.nextTick(callback, null, '127.0.0.1', 4);
  });
  let dispatcher;
  const transport = fixture(async (source, attempt, options) => {
    if (source !== 'eonet') { assert.equal(options.dispatcher, undefined); return; }
    if (attempt === 1) { assert.equal(options.dispatcher, undefined); throw dualFamilyFailure(); }
    dispatcher = options.dispatcher;
    return fetch(`http://eonet.fixture.invalid:${server.address().port}`, options);
  });
  const result = await run(transport);
  assert.deepEqual(families, [4]);
  assert.equal(dispatcher.destroyed, true);
  assert.equal(transport.calls.get('eonet'), 2);
  for (const [source, count] of transport.calls) if (source !== 'eonet') assert.equal(count, 1, source);
  assert.ok(result.events.some(item => item.id === event.id));
  assert.equal(result._sourceSnapshots.eonet.fetchedAt, NOW);
});

test('IPv4 fallback is limited to EONET and the exact connect failure signature', async () => {
  const wrongFamily = dualFamilyFailure();
  wrongFamily.cause.errors[1].address = '127.0.0.2';
  const wrongCode = dualFamilyFailure();
  wrongCode.cause.errors[1].code = 'ECONNREFUSED';
  for (const [source, failure] of [
    ['gdacs:TC', dualFamilyFailure()],
    ['eonet', new DOMException('timeout', 'TimeoutError')],
    ['eonet', new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } })],
    ['eonet', new TypeError('fetch failed', { cause: new AggregateError([]) })],
    ['eonet', wrongFamily],
    ['eonet', wrongCode],
  ]) {
    const transport = fixture((current, _attempt, options) => {
      assert.equal(options.dispatcher, undefined);
      if (current === source) throw failure;
    });
    await run(transport);
    assert.equal(transport.calls.get(source), 2);
  }
});

test('failed IPv4 retry destroys its dispatcher and preserves the previous success and expiry', async () => {
  const initial = await run(fixture());
  let dispatcher;
  const transport = fixture((source, attempt, options) => {
    if (source !== 'eonet') return;
    if (attempt === 1) throw dualFamilyFailure();
    dispatcher = options.dispatcher;
    throw new DOMException('timeout', 'TimeoutError');
  });
  const now = NOW + 3_600_000;
  const result = await fetchNaturalEvents({
    now, previousSources: initial._sourceSnapshots, fetchFn: transport.fetchFn,
    fetchHkoWarningsFn: async () => ({ warnings: [], dataAvailable: true, sourceDecision: { status: 'used' } }),
  });
  assert.equal(dispatcher.destroyed, true);
  assert.equal(transport.calls.get('eonet'), 2);
  for (const [source, count] of transport.calls) if (source !== 'eonet') assert.equal(count, 1, source);
  const health = naturalEventsAfterPublish(result).freshnessMetaPatch.sourceHealth.eonet;
  assert.equal(health.status, 'retained');
  assert.equal(health.lastSuccessAt, NOW);
  assert.equal(health.lastAttemptAt, now);
  assert.equal(health.retainedUntil, NOW + 9 * 3_600_000);
});

test('a body-stage failure does not select the EONET connect fallback', async () => {
  const transport = fixture((source, _attempt, options) => {
    assert.equal(options.dispatcher, undefined);
    if (source === 'eonet') return { ok: true, json: async () => { throw dualFamilyFailure(); } };
  });
  await run(transport);
  assert.equal(transport.calls.get('eonet'), 2);
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

test('connection diagnostics preserve aggregate members and families without addresses', async t => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const aggregate = new AggregateError([
    Object.assign(new Error('private IPv4 details'), { code: 'ETIMEDOUT', syscall: 'connect', address: '127.0.0.1' }),
    Object.assign(new Error('private IPv6 details'), { code: 'ENETUNREACH', syscall: 'connect', address: '::1' }),
  ]);
  aggregate.code = 'ETIMEDOUT';
  const transport = fixture(source => {
    if (source === 'eonet') throw new TypeError('fetch failed with secret URL', { cause: aggregate });
  });
  const result = await run(transport);
  const output = logs.join('\n');
  assert.match(output, /"code":"ETIMEDOUT","syscall":"connect","family":4/);
  assert.match(output, /"code":"ENETUNREACH","syscall":"connect","family":6/);
  assert.match(output, /attemptElapsedMs=\d+/);
  assert.match(output, /"node":"\d+\.\d+\.\d+"/);
  assert.doesNotMatch(output, /127\.0\.0\.1|::1|private|secret URL/);
  assert.deepEqual(naturalEventsAfterPublish(result).freshnessMetaPatch.failedSources, ['eonet']);
  assert.equal(transport.calls.get('eonet'), 2);
  for (const [source, count] of transport.calls) if (source !== 'eonet') assert.equal(count, 1, source);
});

test('connection diagnostics bound cyclic and wide errors and omit unknown sensitive fields', async t => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const error = new TypeError('secret message');
  error.cause = error;
  error.errors = Array.from({ length: 30 }, () => ({
    name: 'secret name', code: 'secret code', syscall: 'secret syscall',
    address: 'secret hostname', stack: 'secret stack',
  }));
  const transport = fixture(source => { if (source === 'eonet') throw error; });
  await run(transport);
  const line = logs.find(item => item.includes(' details='));
  const details = JSON.parse(line.split(' details=')[1]);
  assert.equal(details.errors.length, 8);
  assert.equal(details.truncated, true);
  assert.doesNotMatch(logs.join('\n'), /secret/);
  assert.ok(line.length < 2000, `diagnostic length ${line.length}`);
  assert.equal(transport.calls.get('eonet'), 2);
});

test('throwing diagnostic getters preserve bounded failures and the retry limit', async t => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const error = new TypeError('private fetch details');
  Object.defineProperty(error, 'errors', { get() { throw new Error('secret getter failure'); } });
  const transport = fixture(source => { if (source === 'eonet') throw error; });
  const result = await run(transport);
  const output = logs.join('\n');
  assert.match(output, /eonet request FETCH_FAILED attempt=2 elapsedMs=\d+ attemptElapsedMs=\d+/);
  assert.match(output, /details=\{"unavailable":true\}/);
  assert.doesNotMatch(output, /secret|private/);
  assert.equal(transport.calls.get('eonet'), 2);
  for (const [source, count] of transport.calls) if (source !== 'eonet') assert.equal(count, 1, source);
  assert.deepEqual(naturalEventsAfterPublish(result).freshnessMetaPatch.failedSources, ['eonet']);
});

test('failure timing separates each request duration from total elapsed time', async t => {
  let clock = 0;
  const logs = [];
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    clock += 500;
    queueMicrotask(callback);
  });
  const transport = fixture(source => {
    if (source !== 'eonet') return;
    clock += 250;
    throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
  });
  await run(transport);
  assert.match(logs.join('\n'), /attempt=1 elapsedMs=250 attemptElapsedMs=250/);
  assert.match(logs.join('\n'), /attempt=2 elapsedMs=1000 attemptElapsedMs=250/);
});

test('failure phase timings distinguish late headers from a stalled body and reset on retry', async t => {
  let clock = 0;
  const logs = [];
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(globalThis, 'setTimeout', callback => { clock += 500; queueMicrotask(callback); });
  const initial = await run(fixture());
  const transport = fixture((source, attempt) => {
    if (source !== 'eonet') return;
    clock += attempt === 1 ? 14000 : 100;
    return { ok: true, json: async () => {
      clock += attempt === 1 ? 1000 : 14900;
      throw new DOMException('private body content', 'TimeoutError');
    } };
  });
  const result = await fetchNaturalEvents({
    now: NOW + 1000, previousSources: initial._sourceSnapshots, fetchFn: transport.fetchFn,
    fetchHkoWarningsFn: async () => ({ warnings: [], dataAvailable: true, sourceDecision: { status: 'used' } }),
  });
  const output = logs.join('\n');
  assert.match(output, /attempt=1 elapsedMs=15000 attemptElapsedMs=15000 headersElapsedMs=14000 bodyElapsedMs=1000/);
  assert.match(output, /attempt=2 elapsedMs=30500 attemptElapsedMs=15000 headersElapsedMs=100 bodyElapsedMs=14900/);
  assert.doesNotMatch(output, /private body content/);
  assert.equal(transport.calls.get('eonet'), 2);
  for (const [source, count] of transport.calls) if (source !== 'eonet') assert.equal(count, 1, source);
  assert.equal(result._sourceSnapshots.eonet.fetchedAt, NOW);
  assert.equal(result._sourceSnapshots.eonet.retainedUntil, initial._sourceSnapshots.eonet.retainedUntil);
});

test('request failures omit unobserved phase timings and successful responses add no diagnostics', async t => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const transport = fixture((source, attempt) => {
    if (source === 'eonet' && attempt === 1) throw new TypeError('fetch failed');
  });
  const result = await run(transport);
  assert.ok(result.events.some(item => item.id === event.id));
  assert.equal(result._sourceSnapshots.eonet.fetchedAt, NOW);
  assert.doesNotMatch(logs.join('\n'), /headersElapsedMs|bodyElapsedMs|attempt=2/);
});
