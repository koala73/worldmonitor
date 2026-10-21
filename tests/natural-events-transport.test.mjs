import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import dns from 'node:dns';
import { gzipSync } from 'node:zlib';
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

test('late EONET headers leave progressing body time within the shared budget', { timeout: 25_000 }, async t => {
  const body = JSON.stringify({ events: [event] });
  const timers = [];
  const server = createServer((_req, res) => {
    timers.push(setTimeout(() => { res.writeHead(200); res.write(body.slice(0, 20)); }, 12_900));
    timers.push(setTimeout(() => res.end(body.slice(20)), 16_000));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { timers.forEach(clearTimeout); server.closeAllConnections(); server.close(); });
  const transport = fixture((source, attempt, options) => {
    if (source !== 'eonet') return;
    if (attempt === 1) throw dualFamilyFailure();
    return fetch(`http://127.0.0.1:${server.address().port}`, options);
  });
  const started = performance.now();
  const result = await run(transport);
  assert.ok(result.events.some(item => item.id === event.id));
  assert.equal(result._eonetFailed, false);
  assert.ok(performance.now() - started < 20_000);
  assert.equal(transport.calls.get('eonet'), 2);
});

test('EONET aborts a silent body and retries within the existing source budget', { timeout: 15_000 }, async t => {
  let disconnected = 0;
  const server = createServer((req, res) => {
    req.on('close', () => disconnected++);
    res.writeHead(200); res.write('{"events":[');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const transport = fixture((source, _attempt, options) => source === 'eonet'
    ? fetch(`http://127.0.0.1:${server.address().port}`, options) : undefined);
  const started = performance.now();
  const result = await run(transport);
  assert.equal(result._eonetFailed, true);
  assert.equal(transport.calls.get('eonet'), 2);
  assert.ok(performance.now() - started < 13_000);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(disconnected, 2);
});

test('EONET progressing body cannot renew the total deadline', { timeout: 35_000 }, async t => {
  let interval;
  let disconnected = false;
  const server = createServer((req, res) => {
    res.writeHead(200); res.write('{"events":[');
    interval = setInterval(() => res.write(' '), 250);
    req.on('close', () => { disconnected = true; clearInterval(interval); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { clearInterval(interval); server.closeAllConnections(); server.close(); });
  const transport = fixture((source, _attempt, options) => source === 'eonet'
    ? fetch(`http://127.0.0.1:${server.address().port}`, options) : undefined);
  const started = performance.now();
  const result = await run(transport);
  const elapsed = performance.now() - started;
  assert.equal(result._eonetFailed, true);
  assert.equal(transport.calls.get('eonet'), 1);
  assert.ok(elapsed >= 30_000 && elapsed < 33_000, `elapsed=${elapsed}`);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(disconnected, true);
});

test('EONET decoded-size rejection cancels acquisition and preserves last-good without retry', async () => {
  let cancelled = false;
  const first = await run(fixture());
  const transport = fixture(source => source === 'eonet' ? new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })) : undefined);
  const result = await fetchNaturalEvents({ now: NOW + 1000, previousSources: first._sourceSnapshots,
    fetchFn: transport.fetchFn, fetchHkoWarningsFn: async () => ({ warnings: [], dataAvailable: true }) });
  assert.equal(result._eonetFailed, true);
  assert.equal(transport.calls.get('eonet'), 1);
  assert.equal(cancelled, true);
  assert.deepEqual(result._sourceSnapshots.eonet, first._sourceSnapshots.eonet);
});

test('EONET streamed JSON preserves native BOM and invalid UTF-8 decoding', async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ events: [event] }).replace('Volcano', 'VolcXno'))]);
  bytes[bytes.indexOf('X')] = 0xff;
  const expected = await new Response(bytes).json();
  const result = await run(fixture(source => source === 'eonet' ? new Response(bytes) : undefined));
  assert.equal(result._eonetFailed, false);
  assert.equal(result.events.find(item => item.id === event.id).title, expected.events[0].title);
});

test('EONET bounds decompressed bytes and rejects a truncated native response', async t => {
  const compressed = gzipSync(JSON.stringify({ events: [], padding: 'x'.repeat(2 * 1024 * 1024) }));
  let mode = 'oversize';
  const server = createServer((_req, res) => {
    if (mode === 'oversize') { res.writeHead(200, { 'Content-Encoding': 'gzip' }); res.end(compressed); }
    else { res.writeHead(200, { 'Content-Length': '1000' }); res.end('{"events":['); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (mode of ['oversize', 'truncated']) {
    const transport = fixture((source, _attempt, options) => source === 'eonet'
      ? fetch(`http://127.0.0.1:${server.address().port}`, options) : undefined);
    const result = await run(transport);
    assert.equal(result._eonetFailed, true);
    assert.equal(transport.calls.get('eonet'), mode === 'oversize' ? 1 : 2);
    assert.equal(result._sourceSnapshots.eonet, null);
  }
});

test('EONET success and malformed JSON release header and idle timers', async t => {
  const active = new Set();
  const timer = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const handle = timer(callback, delay, ...args);
    if (delay === 5000 || delay === 15000) active.add(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => { active.delete(handle); clear(handle); });
  for (const body of [JSON.stringify({ events: [event] }), '{"events":']) {
    await run(fixture(source => source === 'eonet' ? new Response(body) : undefined));
    assert.equal(active.size, 0);
  }
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
  assert.equal(health.retainedUntil, NOW + 18 * 3_600_000);
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
  assert.equal(result._sourceSnapshots.eonet.retainedUntil, NOW + 18 * 3_600_000);
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
  const realTimer = globalThis.setTimeout;
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    if (delay !== 2000) return realTimer(callback, delay);
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
  const realTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    if (delay !== 500) return realTimer(callback, delay);
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
  const realTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    if (delay !== 500) return realTimer(callback, delay);
    clock += 500; queueMicrotask(callback);
  });
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

test('failed native attempts log isolated wire progress without logging response content', async t => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', () => timeout(100));
  const body = '{"private":"secret';
  const server = createServer((_req, res) => { res.writeHead(200); res.write(body); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const transport = fixture((source, _attempt, options) => source === 'eonet'
    ? fetch(`http://127.0.0.1:${server.address().port}/private?token=secret`, options) : undefined);
  const result = await run(transport);
  const progress = logs.flatMap(line => [...line.matchAll(/ progress=(\{[^}]+\})/g)].map(match => JSON.parse(match[1])));
  assert.equal(progress.length, 2);
  for (const item of progress) {
    assert.equal(item.observed, true);
    assert.equal(item.requestCount, 1);
    assert.equal(item.requestSendObserved, true);
    assert.equal(item.responseHeadersObserved, true);
    assert.equal(item.wireBodyBytes, Buffer.byteLength(body));
    assert.equal(item.wireBodyComplete, false);
    assert.ok(item.firstBodyByteMs >= 0);
    assert.ok(item.lastBodyByteMs >= item.firstBodyByteMs);
  }
  assert.doesNotMatch(logs.join('\n'), /private|secret|127\.0\.0\.1/);
  assert.equal(transport.calls.get('eonet'), 2);
  for (const [source, count] of transport.calls) if (source !== 'eonet') assert.equal(count, 1, source);
  assert.deepEqual(naturalEventsAfterPublish(result).freshnessMetaPatch.failedSources, ['eonet']);
});
