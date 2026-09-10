import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as quota from '../api/_widget-quota.js';
import { quotaStore } from './widget-quota-fixture.mjs';
const source = readFileSync(
  new URL('../scripts/ais-relay.cjs', import.meta.url),
  'utf8',
);
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});
function fixture({ limit = 100000000, responses = [], corrupt = false } = {}) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://quota.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-token';
  process.env.WIDGET_QUOTA_SIGNING_KEY =
    'synthetic-signing-key-at-least-32-bytes';
  const ledger = quotaStore(limit);
  if (corrupt) ledger.store.delete('spent');
  globalThis.fetch = ledger.fetch;
  const calls = [],
    clients = [],
    searches = [];
  const sdk = {
    default: class {
      constructor(options) {
        clients.push(options);
      }
      messages = {
        create: async (body) => {
          calls.push(body);
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return (
            next ?? {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'html' }],
            }
          );
        },
      };
    },
  };
  const context = vm.createContext({
    quotaModule: quota,
    sdk,
    WIDGET_AGENT_KEY: 'basic-secret',
    PRO_WIDGET_KEY: 'pro-secret',
    WIDGET_ANTHROPIC_KEY: 'synthetic-model-key',
    WIDGET_MAX_HTML: 50000,
    WIDGET_PRO_MAX_HTML: 80000,
    WIDGET_SYSTEM_PROMPT: 'basic',
    WIDGET_PRO_SYSTEM_PROMPT: 'pro',
    WIDGET_FETCH_TOOL: { name: 'fetch_worldmonitor_data' },
    WIDGET_SEARCH_TOOL: { name: 'search_web' },
    safeTokenEquals: (a, b) => a === b,
    safeEnd: (res, status, headers, body) => {
      res.writeHead(status, headers);
      res.end(body);
    },
    isWidgetInjectionAttempt: () => false,
    parseWidgetAgentResponse: () => ({ html: '<p>ok</p>', title: 'OK' }),
    sanitizeToolContent: (s) => s,
    isWidgetEndpointAllowed: () => false,
    WIDGET_EXA_KEY: 'synthetic-exa-key',
    WIDGET_BRAVE_KEY: 'synthetic-brave-key',
    URL,
    AbortSignal,
    fetch: async (url) => {
      searches.push(String(url).includes('exa.ai') ? 'exa' : 'brave');
      return new Response('{}', { status: 500 });
    },
    classifyWidgetAgentError: (e) => e.message,
    console: { error() {}, warn() {} },
    Buffer,
    setTimeout,
    clearTimeout,
  });
  let code = source.slice(
    source.indexOf('function getWidgetAgentStatus()'),
    source.indexOf('// Map a thrown error from the agent loop'),
  );
  code = code
    .replace("await import('../api/_widget-quota.js')", 'quotaModule')
    .replace("await import('@anthropic-ai/sdk')", 'sdk');
  vm.runInContext(
    source.slice(
      source.indexOf('async function performWidgetWebSearch'),
      source.indexOf('function getWidgetAgentStatus()'),
    ) + code,
    context,
  );
  async function request(
    headers = { 'x-pro-key': 'pro-secret' },
    body = { prompt: 'Build chart' },
  ) {
    const raw = JSON.stringify(body);
    const req = new EventEmitter();
    req.headers = headers;
    req.socket = { remoteAddress: 'shared-relay-ip' };
    const res = {
      status: 0,
      headers: {},
      chunks: [],
      writableEnded: false,
      writeHead(status, h) {
        this.status = status;
        this.headers = h;
      },
      write(s) {
        this.chunks.push(s);
      },
      end(s) {
        if (s) this.chunks.push(s);
        this.writableEnded = true;
      },
    };
    const pending = context.handleWidgetAgentRequest(req, res);
    setImmediate(() => {
      req.emit('data', Buffer.from(raw));
      req.emit('end');
    });
    await pending;
    return res;
  }
  return { ledger, calls, clients, searches, request, context };
}
test('direct relay admission ignores spoofed IP and enforces quota before any model call', async () => {
  const f = fixture({ limit: 0 });
  const res = await f.request({
    'x-pro-key': 'pro-secret',
    'cf-connecting-ip': 'attacker-choice',
  });
  assert.equal(f.calls.length, 0);
  assert.match(res.chunks.join(''), /quota exhausted/);
});
test('corrupt/missing ledger returns 503 before SSE and before SDK construction', async () => {
  const f = fixture({ corrupt: true });
  const res = await f.request();
  assert.equal(res.status, 503);
  assert.equal(f.calls.length, 0);
  assert.equal(f.clients.length, 0);
});
test('unsigned or tampered identity does not charge a victim', async () => {
  const f = fixture();
  const res = await f.request({
    'x-pro-key': 'pro-secret',
    'x-widget-principal': await quota.widgetPrincipal('user', 'victim'),
  });
  assert.equal(res.status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal(f.ledger.store.get('spent'), '0');
});
test('signed users behind one IP retain separate budgets and allowed streams', async () => {
  const f = fixture();
  const body = { prompt: 'Build chart', tier: 'pro' };
  for (const user of ['one', 'two']) {
    const principal = await quota.widgetPrincipal('user', user);
    const proof = await quota.signWidgetPrincipal(
      principal,
      'pro',
      JSON.stringify(body),
    );
    const headers = Object.fromEntries(
      Object.entries(proof).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const res = await f.request(
      { ...headers, 'x-pro-key': 'pro-secret' },
      body,
    );
    assert.equal(res.status, 200);
    assert.match(res.chunks.join(''), /html_complete/);
    assert.match(res.chunks.join(''), /"type":"done"/);
    assert.equal(
      JSON.parse(f.ledger.store.get(principal)).spent,
      quota.WIDGET_MODEL_POLICY.pro.microUsd,
    );
  }
  assert.equal(f.calls.length, 2);
  assert.equal(f.clients[0].maxRetries, 0);
  assert.equal(f.clients[0].baseURL, 'https://api.anthropic.com');
  assert.equal(f.calls[0].service_tier, 'standard_only');
});
test('every tool-loop model turn reserves; exhaustion stops the next paid call', async () => {
  const f = fixture({
    limit: quota.WIDGET_MODEL_POLICY.pro.microUsd,
    responses: [{ stop_reason: 'tool_use', content: [] }],
  });
  const res = await f.request();
  assert.equal(f.calls.length, 1);
  assert.match(res.chunks.join(''), /quota exhausted/);
  assert.equal(
    f.ledger.store.get('spent'),
    String(quota.WIDGET_MODEL_POLICY.pro.microUsd),
  );
});
test('model failure retains reservation and is not retried', async () => {
  const f = fixture({ responses: [new Error('upstream failed')] });
  await f.request();
  assert.equal(f.calls.length, 1);
  assert.equal(f.clients[0].maxRetries, 0);
  assert.equal(
    f.ledger.store.get('spent'),
    String(quota.WIDGET_MODEL_POLICY.pro.microUsd),
  );
});
test('search fallback requires a second reservation; no second provider call when exhausted', async () => {
  const f = fixture({
    limit:
      quota.WIDGET_MODEL_POLICY.pro.microUsd + quota.WIDGET_SEARCH_MICRO_USD,
    responses: [
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'search-1',
            name: 'search_web',
            input: { query: 'news' },
          },
        ],
      },
    ],
  });
  const res = await f.request();
  assert.deepEqual(f.searches, ['exa']);
  assert.equal(f.calls.length, 1);
  assert.match(res.chunks.join(''), /quota exhausted/);
});
test('legacy basic relay uses the same principal as the edge and bounded Haiku output', async () => {
  const f = fixture();
  await f.request({ 'x-widget-key': 'basic-secret' });
  const principal = await quota.widgetPrincipal('key', 'basic-secret');
  assert.equal(
    JSON.parse(f.ledger.store.get(principal)).spent,
    quota.WIDGET_MODEL_POLICY.basic.microUsd,
  );
  assert.equal(f.calls[0].model, quota.WIDGET_MODEL_POLICY.basic.model);
  assert.equal(f.calls[0].max_tokens, 4096);
});
