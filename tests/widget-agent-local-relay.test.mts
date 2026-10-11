import assert from 'node:assert/strict';
import { after, test } from 'node:test';

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
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal((calls[0].init as Record<symbol, unknown>)[Symbol.for('worldmonitor.localWidgetRelayFetch')], true);
  const health = await handler(new Request('http://localhost:4100/api/widget-agent', {
    headers: { 'X-WorldMonitor-Key': 'local-operator-key' },
  }));
  assert.equal(health.status, 200);
  assert.equal(calls[1].url, 'http://127.0.0.1:3004/widget-agent/health');
  assert.equal((calls[1].init as Record<symbol, unknown>)[Symbol.for('worldmonitor.localWidgetRelayFetch')], true);
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
