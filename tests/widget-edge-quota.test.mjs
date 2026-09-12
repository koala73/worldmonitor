import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as quota from '../api/_widget-quota.js';
import * as cors from '../api/_cors.js';
import * as secrets from '../api/_crypto.js';
import * as sessionShape from '../api/_session.js';
import { quotaStore } from './widget-quota-fixture.mjs';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});
function fixture() {
  Object.assign(process.env, {
    WIDGET_AGENT_KEY: 'basic-secret',
    PRO_WIDGET_KEY: 'pro-secret',
    WORLDMONITOR_VALID_KEYS: 'tester-secret',
    WIDGET_QUOTA_SIGNING_KEY: 'synthetic-signing-key-at-least-32-bytes',
    UPSTASH_REDIS_REST_URL: 'https://quota.test',
    UPSTASH_REDIS_REST_TOKEN: 'synthetic-token',
  });
  const ledger = quotaStore();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (url === 'https://quota.test') return ledger.fetch(url, init);
    calls.push({ url, init });
    return new Response('data: {"type":"done"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  const exports = {};
  const modules = {
    './_widget-quota.js': quota,
    './_cors.js': cors,
    './_crypto.js': secrets,
    './_session.js': sessionShape,
    './_sentry-edge.js': { captureSilentError: () => {} },
    '../server/auth-session': {
      validateBearerToken: async (token) => ({
        valid: true,
        userId: token,
        role: token === 'clerk-pro' ? 'pro' : 'free',
      }),
    },
    '../server/_shared/entitlement-check': {
      getEntitlements: async () => ({ features: { tier: 1 } }),
      getBillingVerificationDenial: () => null,
    },
  };
  const source = ts.transpileModule(
    readFileSync(new URL('../api/widget-agent.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  vm.runInNewContext(source, {
    exports,
    require: (name) => {
      assert.ok(name in modules, name);
      return modules[name];
    },
    process,
    Request,
    Response,
    Headers,
    AbortSignal,
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
    console,
    fetch: (...args) => globalThis.fetch(...args),
  });
  const request = (headers = {}, method = 'POST') =>
    exports.default(
      new Request('https://www.worldmonitor.app/api/widget-agent', {
        method,
        headers: { Origin: 'https://www.worldmonitor.app', ...headers },
        ...(method === 'POST'
          ? { body: JSON.stringify({ prompt: 'Build chart' }) }
          : {}),
      }),
    );
  return { ledger, calls, request };
}
test('all authenticated paths reserve using the verified credential or user, and forward a valid signed stream request', async () => {
  const f = fixture();
  for (const [headers, kind, id] of [
    [{ 'X-WorldMonitor-Key': 'tester-secret' }, 'key', 'tester-secret'],
    [{ 'X-Api-Key': 'tester-secret' }, 'key', 'tester-secret'],
    [{ Cookie: 'wm-pro-key=tester-secret' }, 'key', 'tester-secret'],
    [{ Cookie: 'wm-widget-key=tester-secret' }, 'key', 'tester-secret'],
    [{ 'X-Pro-Key': 'pro-secret' }, 'key', 'pro-secret'],
    [{ 'X-Widget-Key': 'basic-secret' }, 'key', 'basic-secret'],
    [{ Cookie: 'wm-pro-key=pro-secret' }, 'key', 'pro-secret'],
    [{ Cookie: 'wm-widget-key=basic-secret' }, 'key', 'basic-secret'],
    [{ Authorization: 'Bearer clerk-pro' }, 'user', 'clerk-pro'],
    [{ Authorization: 'Bearer clerk-entitled' }, 'user', 'clerk-entitled'],
  ]) {
    const res = await f.request({
      ...headers,
      'X-Widget-Principal': 'spoofed',
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /done/);
    const principal = await quota.widgetPrincipal(kind, id);
    const forwarded = f.calls.at(-1).init;
    const proof = Object.fromEntries(
      Object.entries(forwarded.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    assert.equal(
      await quota.verifyWidgetPrincipal(
        proof,
        JSON.parse(forwarded.body).tier,
        forwarded.body,
      ),
      principal,
    );
    assert.ok(JSON.parse(f.ledger.store.get(principal)).edgeCount > 0);
  }
});
test('exhausted rate and absent quota state return CORS-correct errors without relay calls; health and preflight remain nonbillable', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await f.request({ 'X-Widget-Key': 'basic-secret' })).status,
      200,
    );
  const denied = await f.request({ 'X-Widget-Key': 'basic-secret' });
  assert.equal(denied.status, 429);
  assert.ok(denied.headers.get('Retry-After'));
  assert.equal(
    denied.headers.get('Access-Control-Allow-Origin'),
    'https://www.worldmonitor.app',
  );
  assert.equal(f.calls.length, 10);
  f.ledger.store.delete('spent');
  assert.equal((await f.request({ 'X-Pro-Key': 'pro-secret' })).status, 503);
  assert.equal(f.calls.length, 10);
  assert.equal(
    (await f.request({ 'X-Pro-Key': 'pro-secret' }, 'GET')).status,
    200,
  );
  assert.equal((await f.request({}, 'OPTIONS')).status, 204);
  assert.equal(f.calls.length, 11);
});
