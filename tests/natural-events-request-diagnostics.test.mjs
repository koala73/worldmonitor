import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import { gzipSync } from 'node:zlib';
import { withSourceRequestDiagnostics } from '../scripts/natural/source-request-diagnostics.mjs';

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function observe(url) {
  return withSourceRequestDiagnostics(async snapshot => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(150) });
      const value = await response.json();
      return { value, progress: snapshot() };
    } catch (error) {
      return { error: error.name, progress: snapshot() };
    }
  });
}

test('concurrent requests to one origin keep complete, incomplete and header-wait facts separate', async t => {
  const origin = await fixture(t, (req, res) => {
    if (req.url === '/headers') return;
    if (req.url === '/partial') { res.writeHead(200); res.write('{"private":'); return; }
    res.end('{"ok":true}');
  });
  const [complete, partial, headers] = await Promise.all([
    observe(`${origin}/complete`), observe(`${origin}/partial`), observe(`${origin}/headers`),
  ]);
  assert.deepEqual(complete.value, { ok: true });
  assert.equal(complete.progress.wireBodyComplete, true);
  assert.equal(complete.progress.wireBodyBytes, 11);
  assert.equal(partial.error, 'TimeoutError');
  assert.equal(partial.progress.wireBodyBytes, 11);
  assert.equal(partial.progress.responseHeadersObserved, true);
  assert.equal(partial.progress.wireBodyComplete, false);
  assert.equal(headers.error, 'TimeoutError');
  assert.equal(headers.progress.requestSendObserved, true);
  assert.equal(headers.progress.responseHeadersObserved, false);
  assert.equal(headers.progress.wireBodyBytes, null);
  assert.equal(headers.progress.firstBodyByteMs, null);
  assert.equal(headers.progress.lastBodyByteMs, null);
  assert.equal(channel('undici:request:create').hasSubscribers, false);
});

test('wire counters measure compressed bytes and keep complete malformed JSON distinct from incomplete bodies', async t => {
  const body = gzipSync('{"private":"data",');
  const origin = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Encoding': 'gzip' });
    res.end(body);
  });
  const result = await observe(origin);
  assert.equal(result.error, 'SyntaxError');
  assert.equal(result.progress.wireBodyBytes, body.byteLength);
  assert.equal(result.progress.wireBodyComplete, true);
  assert.doesNotMatch(JSON.stringify(result.progress), /private|data|127\.0\.0\.1/);
});

test('a complete gzip payload without HTTP completion remains incomplete', async t => {
  const body = gzipSync('{"ok":true}');
  const origin = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Encoding': 'gzip' });
    res.write(body);
  });
  const result = await observe(origin);
  assert.equal(result.error, 'TimeoutError');
  assert.equal(result.progress.wireBodyBytes, body.byteLength);
  assert.equal(result.progress.wireBodyComplete, false);
});

test('redirects describe the final hop without adding earlier response bytes', async t => {
  const origin = await fixture(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/final' }); res.end('redirect body'); return; }
    res.writeHead(200); res.write('{');
  });
  const result = await observe(`${origin}/redirect`);
  assert.equal(result.error, 'TimeoutError');
  assert.equal(result.progress.requestCount, 2);
  assert.equal(result.progress.wireBodyBytes, 1);
  assert.equal(result.progress.wireBodyComplete, false);
});

test('unobserved transports remain unknown and throwing operations release subscriptions', async () => {
  assert.deepEqual(await withSourceRequestDiagnostics(snapshot => snapshot()), { observed: false, requestCount: 0 });
  const error = new Error('fixture');
  await assert.rejects(withSourceRequestDiagnostics(() => { throw error; }), value => value === error);
  for (const name of ['request:create', 'client:sendHeaders', 'request:headers', 'request:bodyChunkReceived', 'request:trailers']) {
    assert.equal(channel(`undici:${name}`).hasSubscribers, false, name);
  }
});

test('request events without body-chunk telemetry leave byte measurements unknown', async () => {
  const progress = await withSourceRequestDiagnostics(snapshot => {
    const request = {};
    channel('undici:request:create').publish({ request });
    channel('undici:request:headers').publish({ request, response: { statusCode: 200, headers: [] } });
    channel('undici:request:trailers').publish({ request });
    return snapshot();
  });
  assert.equal(progress.observed, true);
  assert.equal(progress.responseHeadersObserved, true);
  assert.equal(progress.wireBodyComplete, true);
  assert.equal(progress.wireBodyBytes, null);
  assert.equal(progress.firstBodyByteMs, null);
  assert.equal(progress.lastBodyByteMs, null);
});

test('HTTP diagnostics retain bounded response facts and correlation without private headers or bodies', async t => {
  const origin = await fixture(t, (_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html; private=secret', 'X-Request-Id': 'request-123', 'Set-Cookie': 'secret=session', 'X-Private': 'secret' });
    res.end('private response');
  });
  const a = await observe(origin);
  const b = await observe(origin);
  assert.equal(a.progress.statusCode, 404);
  assert.equal(a.progress.contentType, 'text/html');
  assert.equal(a.progress.responseRequestId, 'request-123');
  assert.match(a.progress.requestId, /^[a-f0-9-]{36}$/);
  assert.notEqual(a.progress.requestId, b.progress.requestId);
  assert.ok(Number.isFinite(Date.parse(a.progress.startedAt)));
  assert.doesNotMatch(JSON.stringify(a.progress), /secret|private|127\.0\.0\.1/);
});

test('response correlation rejects oversized and unsafe header values and resets on redirect', async t => {
  const origin = await fixture(t, (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/final', 'X-Request-Id': 'old-hop' });
      res.end();
      return;
    }
    res.writeHead(404, { 'X-Request-Id': 'x'.repeat(129), 'CF-Ray': 'unsafe value', 'Content-Type': 'private/secret' });
    res.end('{}');
  });
  const result = await observe(`${origin}/redirect`);
  assert.equal(result.progress.requestCount, 2);
  assert.equal(result.progress.statusCode, 404);
  assert.equal(result.progress.responseRequestId, undefined);
  assert.equal(result.progress.cfRay, undefined);
  assert.equal(result.progress.contentType, undefined);
});

test('informational headers do not leak into final response facts', async () => {
  const result = await withSourceRequestDiagnostics(snapshot => {
    const request = {};
    channel('undici:request:create').publish({ request });
    channel('undici:request:headers').publish({ request, response: { statusCode: 103, headers: [Buffer.from('x-request-id'), Buffer.from('early')] } });
    assert.equal(snapshot().responseHeadersObserved, false);
    channel('undici:request:headers').publish({ request, response: { statusCode: 404, headers: [] } });
    return snapshot();
  });
  assert.equal(result.statusCode, 404);
  assert.equal(result.responseRequestId, undefined);
});

test('HTTP/2 header objects retain correlation without treating a length header as an array', async () => {
  const result = await withSourceRequestDiagnostics(snapshot => {
    const request = {};
    channel('undici:request:create').publish({ request });
    channel('undici:request:headers').publish({ request, response: { statusCode: 404, headers: { 'x-request-id': 'h2-request', 'content-type': 'application/json', length: '1' } } });
    return snapshot();
  });
  assert.equal(result.statusCode, 404);
  assert.equal(result.responseRequestId, 'h2-request');
  assert.equal(result.contentType, 'application/json');
});
