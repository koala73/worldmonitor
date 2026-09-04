import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runMcpProxyProbe } from '../scripts/mcp-proxy-live-smoke.mjs';

const PROXY_URL = 'https://www.worldmonitor.app/api/mcp-proxy?serverUrl=https%3A%2F%2Fexample.com%2Fmcp';
const APEX_PROXY_URL = 'https://worldmonitor.app/api/mcp-proxy?serverUrl=https%3A%2F%2Fexample.com%2Fmcp';
const APEX_REDIRECT_URL = 'https://www.worldmonitor.app/api/mcp-proxy?serverUrl=https%3A%2F%2Fexample.com%2Fmcp';

function reply(status, text = '', headers = {}) {
  return { res: new Response(null, { status, headers }), text, ms: 1 };
}

function sequence(...responses) {
  const requests = [];
  const timedFetch = async (url, init = {}) => {
    requests.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, 'probe made more requests than the test supplied');
    return next;
  };
  return { requests, timedFetch };
}

function abortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function assertRequestOrder(requests, url, count) {
  assert.equal(requests.length, count);
  assert.equal(requests[0].url, url);
  assert.equal(requests[0].init.method, 'OPTIONS');
  assert.deepEqual(requests[0].init.headers, {
    Origin: 'https://www.worldmonitor.app',
    'Access-Control-Request-Method': 'POST',
  });
  if (count === 2) {
    assert.equal(requests[1].url, url);
    assert.equal(requests[1].init.method, undefined);
    assert.deepEqual(requests[1].init.headers, { Origin: 'https://www.worldmonitor.app' });
  }
}

test('accepts a healthy OPTIONS preflight and exact anonymous auth wall', async () => {
  const { requests, timedFetch } = sequence(
    reply(204),
    reply(401, JSON.stringify({ error: 'Pro authentication required' }), { 'content-type': 'application/json' }),
  );

  const records = await runMcpProxyProbe(PROXY_URL, timedFetch);

  assert.deepEqual(records, [
    { check: 'mcp-proxy OPTIONS', ok: true, detail: '204' },
    { check: 'mcp-proxy anon GET', ok: true, detail: '401 "Pro authentication required"' },
  ]);
  assertRequestOrder(requests, PROXY_URL, 2);
});

test('accepts only the exact 301 apex redirect with the same path and query', async () => {
  const { requests, timedFetch } = sequence(
    reply(301, '', { location: APEX_REDIRECT_URL }),
  );

  const records = await runMcpProxyProbe(APEX_PROXY_URL, timedFetch);

  assert.deepEqual(records, [{
    check: 'mcp-proxy OPTIONS',
    ok: true,
    detail: `301 → ${APEX_REDIRECT_URL} (expected apex → www host split; www carries the assertions)`,
  }]);
  assertRequestOrder(requests, APEX_PROXY_URL, 1);
});

test('rejects a redirect on the www host', async () => {
  const { requests, timedFetch } = sequence(
    reply(301),
  );

  const records = await runMcpProxyProbe(PROXY_URL, timedFetch);

  assert.equal(records.length, 1);
  assert.equal(records[0].check, 'mcp-proxy OPTIONS');
  assert.equal(records[0].ok, false);
  assert.match(records[0].detail, /unexpected redirect/i);
  assertRequestOrder(requests, PROXY_URL, 1);
});

for (const [name, status, location] of [
  ['wrong apex redirect status', 308, APEX_REDIRECT_URL],
  ['wrong apex redirect destination', 301, `${APEX_REDIRECT_URL}&changed=true`],
]) {
  test(`rejects ${name}`, async () => {
    const { requests, timedFetch } = sequence(reply(status, '', { location }));

    const records = await runMcpProxyProbe(APEX_PROXY_URL, timedFetch);

    assert.equal(records.length, 1);
    assert.equal(records[0].ok, false);
    assert.match(records[0].detail, /unexpected redirect/i);
    assertRequestOrder(requests, APEX_PROXY_URL, 1);
  });
}

test('rejects a redirect on a custom host', async () => {
  const url = 'https://mcp.example.net/api/mcp-proxy?serverUrl=https%3A%2F%2Fexample.com%2Fmcp';
  const { requests, timedFetch } = sequence(
    reply(301, '', { location: APEX_REDIRECT_URL }),
  );

  const records = await runMcpProxyProbe(url, timedFetch);

  assert.equal(records.length, 1);
  assert.equal(records[0].ok, false);
  assert.match(records[0].detail, /no redirect on this host/i);
  assertRequestOrder(requests, url, 1);
});

test('allows an apex 204 and verifies its anonymous GET', async () => {
  const { requests, timedFetch } = sequence(
    reply(204),
    reply(401, JSON.stringify({ error: 'Pro authentication required', requestId: 'extra-is-allowed' })),
  );

  const records = await runMcpProxyProbe(APEX_PROXY_URL, timedFetch);

  assert.deepEqual(records.map(({ check, ok }) => ({ check, ok })), [
    { check: 'mcp-proxy OPTIONS', ok: true },
    { check: 'mcp-proxy anon GET', ok: true },
  ]);
  assertRequestOrder(requests, APEX_PROXY_URL, 2);
});

test('continues to GET after a non-204 non-redirecting OPTIONS response', async () => {
  const { requests, timedFetch } = sequence(
    reply(405),
    reply(401, JSON.stringify({ error: 'Pro authentication required' })),
  );

  const records = await runMcpProxyProbe(PROXY_URL, timedFetch);

  assert.deepEqual(records.map(({ check, ok }) => ({ check, ok })), [
    { check: 'mcp-proxy OPTIONS', ok: false },
    { check: 'mcp-proxy anon GET', ok: true },
  ]);
  assert.match(records[0].detail, /expected 204, got 405/);
  assertRequestOrder(requests, PROXY_URL, 2);
});

for (const [name, text, detail] of [
  ['generic error', JSON.stringify({ error: 'Unauthorized' }), /must be exactly/],
  ['missing error', JSON.stringify({ message: 'Unauthorized' }), /must be exactly/],
  ['malformed JSON', '{"error":', /not the handler's JSON/],
]) {
  test(`rejects a 401 with ${name}`, async () => {
    const { requests, timedFetch } = sequence(reply(204), reply(401, text));

    const records = await runMcpProxyProbe(PROXY_URL, timedFetch);

    assert.equal(records[1].ok, false);
    assert.match(records[1].detail, detail);
    assertRequestOrder(requests, PROXY_URL, 2);
  });
}

test('identifies an HTML 403 as a bot-gate failure', async () => {
  const { requests, timedFetch } = sequence(
    reply(204),
    reply(403, '<html><body>blocked</body></html>', { 'content-type': 'text/html; charset=utf-8' }),
  );

  const records = await runMcpProxyProbe(PROXY_URL, timedFetch);

  assert.equal(records[1].ok, false);
  assert.match(records[1].detail, /bot gate is blocking this probe UA/);
  assertRequestOrder(requests, PROXY_URL, 2);
});

test('rejects a 5xx anonymous GET', async () => {
  const { requests, timedFetch } = sequence(reply(204), reply(500, 'FUNCTION_INVOCATION_FAILED'));

  const records = await runMcpProxyProbe(PROXY_URL, timedFetch);

  assert.equal(records[1].ok, false);
  assert.match(records[1].detail, /FUNCTION_INVOCATION_FAILED fingerprint/);
  assertRequestOrder(requests, PROXY_URL, 2);
});

test('stops after an OPTIONS timeout', async () => {
  const { requests, timedFetch } = sequence(abortError('OPTIONS timed out'));

  const records = await runMcpProxyProbe(PROXY_URL, timedFetch);

  assert.deepEqual(records, [{
    check: 'mcp-proxy OPTIONS',
    ok: false,
    detail: 'HANG/transport error: AbortError',
  }]);
  assertRequestOrder(requests, PROXY_URL, 1);
});

test('records a GET timeout after a healthy OPTIONS response', async () => {
  const { requests, timedFetch } = sequence(reply(204), abortError('GET timed out'));

  const records = await runMcpProxyProbe(PROXY_URL, timedFetch);

  assert.deepEqual(records, [
    { check: 'mcp-proxy OPTIONS', ok: true, detail: '204' },
    { check: 'mcp-proxy anon GET', ok: false, detail: 'HANG/transport error: AbortError' },
  ]);
  assertRequestOrder(requests, PROXY_URL, 2);
});
