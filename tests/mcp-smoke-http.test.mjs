import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  createTimedFetch,
  safeUrlLabel,
  serializeSafeError,
  validateMalformedOAuthResponse,
} from '../scripts/mcp-smoke-http.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('records a successful empty HEAD response through completion', async () => {
  await withServer((req, res) => {
    assert.equal(req.method, 'HEAD');
    res.writeHead(200, { 'content-type': 'text/markdown', 'cf-ray': 'test-ray' });
    res.end();
  }, async (origin) => {
    const records = [];
    const timedFetch = createTimedFetch({ deadlineMs: 100, onRecord: (record) => records.push(record) });

    const result = await timedFetch(`${origin}/mcp?must-not-appear=1`, { method: 'HEAD' }, {
      group: 'discovery',
      rpcMethod: 'tools/list',
    });

    assert.equal(result.text, '');
    assert.equal(records.length, 1);
    assert.equal(records[0].sequence, 1);
    assert.equal(records[0].group, 'discovery');
    assert.equal(records[0].hostname, '127.0.0.1');
    assert.equal(records[0].pathname, '/mcp');
    assert.equal(records[0].method, 'HEAD');
    assert.equal(records[0].rpcMethod, 'tools/list');
    assert.ok(records[0].elapsedMs >= 0);
    assert.equal(records[0].deadlineMs, 100);
    assert.equal(records[0].stage, 'complete');
    assert.equal(records[0].status, 200);
    assert.equal(records[0].outcome, 'response');
    assert.deepEqual(records[0].responseHeaders, { 'content-type': 'text/markdown', 'cf-ray': 'test-ray' });
  });
});

test('records a connection error before headers as transport_error', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');

  const records = [];
  const timedFetch = createTimedFetch({ deadlineMs: 200, onRecord: (record) => records.push(record) });

  await assert.rejects(
    timedFetch(`http://127.0.0.1:${port}/mcp`, {}, { group: 'canonical' }),
    TypeError,
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].stage, 'headers');
  assert.equal(records[0].status, null);
  assert.equal(records[0].outcome, 'transport_error');
  assert.equal(records[0].error.name, 'TypeError');
});

test('records an invalid URL as a safe parse-stage transport error before fetch', async () => {
  const sentinel = 'MCP_SMOKE_INVALID_URL_SECRET';
  const records = [];
  const timedFetch = createTimedFetch({
    deadlineMs: 100,
    fetchImpl: async () => assert.fail('fetch must not run for an invalid URL'),
    onRecord: (record) => records.push(record),
  });

  await assert.rejects(timedFetch(`https://user:${sentinel}@%zz/mcp?token=${sentinel}`, {}, { group: 'rpc' }));

  assert.equal(records.length, 1);
  assert.equal(records[0].sequence, 1);
  assert.equal(records[0].group, 'rpc');
  assert.equal(records[0].hostname, null);
  assert.equal(records[0].pathname, null);
  assert.equal(records[0].stage, 'parse');
  assert.equal(records[0].status, null);
  assert.equal(records[0].outcome, 'transport_error');
  assert.doesNotMatch(JSON.stringify(records[0]), new RegExp(sentinel));
});

test('records a stalled body as timeout and preserves safe response headers', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-vercel-id': 'sfo1::fixture' });
    res.flushHeaders();
    res.write('{');
  }, async (origin) => {
    const records = [];
    const timedFetch = createTimedFetch({ deadlineMs: 30, onRecord: (record) => records.push(record) });

    await assert.rejects(timedFetch(`${origin}/mcp`, {}, { group: 'rpc' }));

    assert.equal(records.length, 1);
    assert.equal(records[0].stage, 'body');
    assert.equal(records[0].status, 200);
    assert.equal(records[0].outcome, 'timeout');
    assert.deepEqual(records[0].responseHeaders, {
      'content-type': 'application/json',
      'x-vercel-id': 'sfo1::fixture',
    });
  });
});

test('bounds nested and cyclic errors without serializing secrets or stacks', () => {
  const sentinel = 'MCP_SMOKE_SENTINEL_SECRET';
  const root = new Error(`Authorization: Bearer ${sentinel}`);
  root.code = 'ECONNRESET';
  root.stack = `stack ${sentinel}`;
  root.cause = root;
  root.errors = [new Error(`cookie=${sentinel}`), root, new Error('third')];

  const safe = serializeSafeError(root);
  const json = JSON.stringify(safe);

  assert.equal(safe.name, 'Error');
  assert.equal(safe.code, 'ECONNRESET');
  assert.match(safe.message, /REDACTED/);
  assert.doesNotMatch(json, new RegExp(sentinel));
  assert.doesNotMatch(json, /stack/i);
  assert.equal(safe.cause.cycle, true);
  assert.equal(safe.errors.length, 3);
  assert.equal(
    safeUrlLabel(`https://user:MCP_SMOKE_SENTINEL_SECRET@worldmonitor.app/mcp?token=MCP_SMOKE_SENTINEL_SECRET`),
    'https://worldmonitor.app/mcp',
  );
});

test('classifies a fast AbortError as transport_error unless its deadline fired', async () => {
  const records = [];
  const timedFetch = createTimedFetch({
    deadlineMs: 100,
    fetchImpl: async () => {
      const error = new Error('caller aborted');
      error.name = 'AbortError';
      throw error;
    },
    onRecord: (record) => records.push(record),
  });

  await assert.rejects(timedFetch('https://worldmonitor.app/mcp', {}, { group: 'rpc' }));
  assert.equal(records[0].outcome, 'transport_error');
});

test('only accepts the existing malformed OAuth 400 JSON error contract', async () => {
  const accepted = validateMalformedOAuthResponse(new Response(JSON.stringify({ error: 'invalid_request' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  }), JSON.stringify({ error: 'invalid_request' }));
  assert.deepEqual(accepted, { ok: true, detail: 'HTTP 400 invalid_request' });

  const rejected = validateMalformedOAuthResponse(new Response('upstream failed', { status: 500 }), 'upstream failed');
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /HTTP 500/);
});
