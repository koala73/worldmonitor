import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import oref from '../api/oref-alerts.js';
import { checkRateLimit } from '../api/_rate-limit.js';
import { getCorsHeaders, getOriginDeniedCorsHeaders, isDisallowedOrigin } from '../api/_cors.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('OREF redirects noncanonical queries without relay or limiter work', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected I/O'); };
  for (const [query, canonical] of [
    ['?unused=anything', ''], ['?endpoint=unknown', ''],
    ['?endpoint=history&unused=x', '?endpoint=history'],
    ['?endpoint=history&endpoint=alerts', '?endpoint=history'],
  ]) {
    const response = await oref(new Request(`https://worldmonitor.app/api/oref-alerts${query}`));
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('Location'), `https://worldmonitor.app/api/oref-alerts${canonical}`);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
  assert.equal(calls, 0);
});

test('OREF keeps origin and method checks ahead of canonical redirects', async () => {
  const url = 'https://worldmonitor.app/api/oref-alerts?unused=x';
  assert.equal((await oref(new Request(url, { headers: { Origin: 'https://evil.example' } }))).status, 403);
  assert.equal((await oref(new Request(url, { method: 'POST' }))).status, 405);
  assert.equal((await oref(new Request(url, { method: 'OPTIONS' }))).status, 204);
});

function slack({ admission = null, pipeline = [{ result: 'OK' }], token = 'redis-token', realAdmission = false } = {}) {
  const source = readFileSync(new URL('../api/slack/oauth/start.ts', import.meta.url), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls = { auth: 0, limit: [], writes: [] };
  const exports = {};
  runInNewContext(javascript, {
    exports, process: { env: { SLACK_CLIENT_ID: 'client', SLACK_REDIRECT_URI: 'https://worldmonitor.app/api/slack/oauth/callback', UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: token } },
    Request, Response, URL, AbortSignal, crypto, Uint8Array, btoa,
    require: name => {
      if (name.endsWith('_cors.js')) return { getCorsHeaders, getOriginDeniedCorsHeaders, isDisallowedOrigin };
      if (name.endsWith('_rate-limit.js')) return { checkRateLimit: async (...args) => { calls.limit.push(args); return realAdmission ? checkRateLimit(...args) : admission; } };
      if (name.endsWith('auth-session')) return { validateBearerToken: async () => { calls.auth++; return { valid: true, userId: 'user-1' }; } };
      if (name.endsWith('pro-entitlement')) return { checkTierProEntitlement: async () => ({ allowed: true }) };
      throw new Error(name);
    },
    fetch: async (_url, init) => { calls.writes.push(JSON.parse(init.body)); assert.equal(init.headers['User-Agent'], 'worldmonitor-edge/1.0'); return typeof pipeline === 'string' ? new Response(pipeline) : Response.json(pipeline); },
  });
  return { calls, request: (origin, method = 'POST') => exports.default(new Request('https://worldmonitor.app/api/slack/oauth/start', { method, headers: { Authorization: 'Bearer token', ...(origin ? { Origin: origin } : {}) } })) };
}

test('Slack rejects foreign Origin before authentication and requires Redis token', async () => {
  const app = slack();
  for (const method of ['POST', 'OPTIONS']) {
    const denied = await app.request('https://evil.example', method);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('Access-Control-Allow-Origin'), 'https://evil.example');
  }
  assert.equal(app.calls.auth, 0);
  const missing = slack({ token: '' });
  assert.equal((await missing.request()).status, 503);
  assert.equal(missing.calls.auth, 0);
});

test('Slack admission is fail-closed and user-scoped before state writes', async () => {
  for (const status of [429, 503]) {
    const app = slack({ admission: new Response(null, { status }) });
    assert.equal((await app.request()).status, status);
    assert.equal(app.calls.writes.length, 0);
    const options = app.calls.limit[0][2];
    assert.equal(options.identifier, 'user-1');
    assert.equal(options.scope, 'slack-oauth-start');
    assert.equal(options.limit, 5);
    assert.equal(options.window, '60 s');
    assert.equal(options.failClosed, true);
  }
});

test('Slack requires confirmed SET success before returning an authorization URL', async () => {
  for (const pipeline of [[{ error: 'denied' }], [{ result: null }], {}, 'bad-json']) {
    const app = slack({ pipeline });
    assert.equal((await app.request()).status, 503);
  }
  const app = slack();
  const response = await app.request();
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).oauthUrl);
  assert.equal(url.hostname, 'slack.com');
  assert.equal(app.calls.writes[0][0][1], `wm:slack:oauth:${url.searchParams.get('state')}`);
});

test('canonical OREF responses retain aggregation and caller admission', async () => {
  const saved = { ...process.env };
  process.env.WS_RELAY_URL = 'https://relay.example';
  process.env.UPSTASH_REDIS_REST_URL = 'https://oref-redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  const relayPaths = [];
  let rateCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'oref-redis.example') {
      rateCalls++;
      return Response.json([{ result: [599, 600] }]);
    }
    relayPaths.push(url.pathname);
    return Response.json({ alerts: [] });
  };
  try {
    for (const suffix of ['', '?endpoint=history']) {
      const response = await oref(new Request(`https://worldmonitor.app/api/oref-alerts${suffix}`));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Cache-Control'), /^public,/);
    }
    assert.deepEqual(relayPaths, ['/oref/alerts', '/oref/history']);
    assert.equal(rateCalls, 2);
  } finally {
    for (const key of ['WS_RELAY_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});


test('Slack real limiter admits the handler before its confirmed state SET', async () => {
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://slack-admission.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  const commands = [];
  globalThis.fetch = async (_input, init) => {
    const batch = JSON.parse(init.body);
    commands.push(...batch);
    return Response.json(batch.map(() => ({ result: [4, 5] })));
  };
  try {
    const app = slack({ realAdmission: true });
    assert.equal((await app.request()).status, 200);
    assert.ok(commands.some(command => JSON.stringify(command).includes('rl:slack-oauth-start:user-1')));
    assert.equal(app.calls.writes.length, 1);
    assert.equal(app.calls.writes[0][0][0], 'SET');
  } finally {
    if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
    if (savedToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
  }
});
