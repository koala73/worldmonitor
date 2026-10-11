import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import http from 'node:http';

const fixtureEnv = {
  LLM_PROVIDER: 'generic', WS_RELAY_URL: 'ws://127.0.0.1:3004', LOCAL_API_MODE: 'docker',
  WIDGET_AGENT_KEY: 'local-widget-key', PRO_WIDGET_KEY: 'local-pro-key',
  WORLDMONITOR_VALID_KEYS: 'local-operator-key', RELAY_SHARED_SECRET: 'local-relay-secret',
};
const savedEnv = new Map(Object.keys(fixtureEnv).map(key => [key, process.env[key]]));
Object.assign(process.env, fixtureEnv);
const originalFetch = globalThis.fetch;
const { default: handler, __setWidgetAgentSpendDepsForTests } = await import('../api/widget-agent.ts');
__setWidgetAgentSpendDepsForTests({
  checkRateLimit: async () => null,
  runRedisPipeline: async () => [{ result: 1 }, { result: 1 }],
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('operator widget requests use the local relay with server credentials and preserve streaming', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response('data: {"type":"done"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const response = await handler(new Request('http://localhost:4100/api/widget-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': 'local-operator-key' },
    body: JSON.stringify({ prompt: 'Show quake data', tier: 'pro' }),
  }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: {"type":"done"}\n\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3004/widget-agent');
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get('X-Pro-Key'), 'local-pro-key');
  assert.equal(headers.get('X-Relay-Key'), 'local-relay-secret');
  assert.equal(headers.get('X-WorldMonitor-Key'), null);
  assert.equal(calls[0].init?.redirect, 'manual');
  assert.equal((calls[0].init as Record<symbol, unknown>)[Symbol.for('worldmonitor.localWidgetRelayFetch')], true);
  const health = await handler(new Request('http://localhost:4100/api/widget-agent', {
    headers: { 'X-WorldMonitor-Key': 'local-operator-key' },
  }));
  assert.equal(health.status, 200);
  assert.equal(calls[1].url, 'http://127.0.0.1:3004/widget-agent/health');
  assert.equal((calls[1].init as Record<symbol, unknown>)[Symbol.for('worldmonitor.localWidgetRelayFetch')], true);
});

test('widget health and generation reject redirects without forwarding server credentials or prompts', async t => {
  const captured: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  const leaked: string[] = [];
  const listen = async (server: http.Server) => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }));
    return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  };
  const destination = await listen(http.createServer((req, res) => {
    leaked.push(req.url || '');
    res.end('unexpected redirect destination');
  }));
  const source = await listen(http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    captured.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(307, { Location: `${destination}/capture` });
    res.end();
  }));
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).origin, 'http://127.0.0.1:3004');
    assert.equal(init?.redirect, 'manual', 'use the Edge-supported non-following mode');
    return originalFetch(`${source}${new URL(String(input)).pathname}`, init);
  };
  for (const method of ['GET', 'POST']) {
    const response = await handler(new Request('http://localhost:4100/api/widget-agent', {
      method,
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': 'local-operator-key' },
      ...(method === 'POST' ? { body: JSON.stringify({ prompt: 'Synthetic private widget request' }) } : {}),
    }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Location'), null);
  }
  assert.equal(captured.length, 2);
  assert.ok(captured.every(request => request.headers['x-relay-key'] === 'local-relay-secret'));
  assert.match(captured[1].body, /Synthetic private widget request/);
  assert.deepEqual(leaked, []);
});

test('local model mode without a relay URL never forwards to the hosted relay', async () => {
  delete process.env.WS_RELAY_URL;
  const moduleUrl = new URL('../api/widget-agent.ts?local-relay-missing=1', import.meta.url);
  const { default: missingRelayHandler } = await import(moduleUrl.href);
  globalThis.fetch = async () => assert.fail('Missing local relay configuration must not issue a request');
  const response = await missingRelayHandler(new Request('http://localhost:4100/api/widget-agent', {
    headers: { 'X-WorldMonitor-Key': 'local-operator-key' },
  }));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /WS_RELAY_URL/);
});
