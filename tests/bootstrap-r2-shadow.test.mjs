import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';

import handler, { __testing__ } from '../api/bootstrap.js';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeRequest(query) {
  return new Request(`https://api.worldmonitor.app/api/bootstrap?${query}`, {
    headers: {
      origin: 'https://worldmonitor.app',
      'x-vercel-id': 'iad1::abc-123',
    },
  });
}

function makeWaitUntilCtx() {
  const pending = [];
  return {
    ctx: { waitUntil: promise => pending.push(promise) },
    pending,
    settle: async () => Promise.allSettled(pending),
  };
}

function installFetchHarness({ r2Status = 200 } = {}) {
  const calls = { redis: 0, redisCommands: [], r2: 0, axiom: 0, events: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    if (url.includes('fake.upstash.io')) {
      calls.redis += 1;
      const commands = JSON.parse(init.body);
      calls.redisCommands.push(commands);
      return new Response(JSON.stringify(commands.map((_, index) => ({
        result: JSON.stringify({ value: index }),
      }))), { status: 200 });
    }
    if (url.includes('r2.cloudflarestorage.com')) {
      calls.r2 += 1;
      if (r2Status !== 200) return new Response(null, { status: r2Status });
      const tier = url.endsWith('/slow.json') ? 'slow' : 'fast';
      return new Response(JSON.stringify({
        generatedAt: Date.now(),
        tier,
        payload: { data: { ignored: true }, missing: [] },
      }), { status: 200 });
    }
    if (url.includes('axiom.co')) {
      calls.axiom += 1;
      calls.events.push(...JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return calls;
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  process.env.R2_ACCOUNT_ID = 'account-id';
  process.env.R2_BOOTSTRAP_BUCKET = 'bootstrap';
  process.env.R2_BOOTSTRAP_READ_KEY_ID = 'read-id';
  process.env.R2_BOOTSTRAP_READ_SECRET = 'read-secret';
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-token';
  process.env.VERCEL_ENV = 'production';
  __testing__.resetBootstrapR2ShadowForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
  __testing__.resetBootstrapR2ShadowForTests();
});

test('flag-off public tier response performs no probe and preserves the normal response contract', async () => {
  delete process.env.BOOTSTRAP_R2_SHADOW_MEASURE;
  const calls = installFetchHarness();
  const { ctx, pending } = makeWaitUntilCtx();

  const response = await handler(makeRequest('tier=fast&public=1'), ctx);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('server-timing'), null);
  assert.equal(calls.redis, 1);
  assert.equal(calls.r2, 0);
  assert.equal(calls.axiom, 0);
  assert.equal(pending.length, 0);
});

test('shadow credentials are never exercised outside the production Vercel environment', async () => {
  process.env.BOOTSTRAP_R2_SHADOW_MEASURE = '1';
  process.env.VERCEL_ENV = 'preview';
  const calls = installFetchHarness();
  const wait = makeWaitUntilCtx();

  const response = await handler(makeRequest('tier=fast&public=1'), wait.ctx);

  assert.equal(response.headers.get('server-timing'), null);
  assert.equal(calls.redis, 1);
  assert.equal(calls.r2, 0);
  assert.equal(calls.axiom, 0);
  assert.equal(wait.pending.length, 0);
});

for (const [label, r2Status, expectedOutcome, expectedReason] of [
  ['success', 200, 'r2', null],
  ['failure', 403, 'fallback', 'unreadable'],
]) {
  test(`shadow ${label} returns Redis unchanged and emits one background result`, async () => {
    process.env.BOOTSTRAP_R2_SHADOW_MEASURE = '1';
    const calls = installFetchHarness({ r2Status });
    const wait = makeWaitUntilCtx();

    const response = await handler(makeRequest('tier=slow&public=1'), wait.ctx);
    const body = await response.json();
    await wait.settle();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('server-timing') ?? '', /^wm_bootstrap_redis;dur=\d+(?:\.\d+)?$/);
    assert.equal(calls.redis, 1);
    assert.equal(calls.r2, 1);
    assert.equal(calls.axiom, 1);
    assert.equal(wait.pending.length, 1, 'the probe and its telemetry must share one waitUntil task');
    assert.equal(body.data.ignored, undefined, 'the R2 payload must never become the shadow response');
    assert.equal(calls.events[0].r2_outcome, expectedOutcome);
    assert.equal(calls.events[0].r2_reason, expectedReason);
    assert.equal(calls.events[0].bootstrap_tier, 'slow');
    assert.equal(calls.events[0].execution_region, 'iad1');
    assert.equal(calls.events[0].status, 200);
    assert.deepEqual(
      calls.redisCommands[0].at(-1),
      ['GET', 'bootstrap:r2-shadow-origin-marker:slow'],
      'the MONITOR denominator must distinguish serving from publisher pipelines',
    );
    const exposed = response.headers.get('access-control-expose-headers') ?? '';
    assert.match(exposed, /Server-Timing/i);
    assert.match(exposed, /X-Vercel-Cache/i);
    assert.match(exposed, /CF-Cache-Status/i);
  });
}

test('only the first shadow probe in an isolate is marked cold', async () => {
  process.env.BOOTSTRAP_R2_SHADOW_MEASURE = '1';
  const calls = installFetchHarness();
  for (const tier of ['fast', 'slow']) {
    const wait = makeWaitUntilCtx();
    await handler(makeRequest(`tier=${tier}&public=1`), wait.ctx);
    await wait.settle();
  }

  assert.deepEqual(calls.events.map(event => event.execution_cold), [true, false]);
});

test('shadow ignores on-demand requests but uses the Vercel scheduler without handler context', async () => {
  process.env.BOOTSTRAP_R2_SHADOW_MEASURE = '1';
  const calls = installFetchHarness();
  const onDemand = makeWaitUntilCtx();
  const background = makeWaitUntilCtx();
  __testing__.setWaitUntilForTests(background.ctx.waitUntil);

  const onDemandResponse = await handler(makeRequest('keys=bisDsr&public=1'), onDemand.ctx);
  const noContextResponse = await handler(makeRequest('tier=fast&public=1'));
  await background.settle();

  assert.equal(onDemandResponse.headers.get('server-timing'), null);
  assert.match(
    noContextResponse.headers.get('server-timing') ?? '',
    /^wm_bootstrap_redis;dur=\d+(?:\.\d+)?$/,
  );
  assert.equal(calls.redis, 2);
  assert.equal(calls.r2, 1);
  assert.equal(calls.axiom, 1);
  assert.equal(onDemand.pending.length, 0);
  assert.equal(background.pending.length, 1);
});

test('shadow source pins the uncensored probe ceiling and cannot consume serving timeouts', () => {
  const source = readFileSync(new URL('../api/bootstrap.js', import.meta.url), 'utf8');
  assert.match(source, /readBootstrapTierObject\(tier,\s*\{\s*timeoutMs:\s*BOOTSTRAP_R2_PROBE_CEILING_MS,?\s*\}\)/);
  assert.doesNotMatch(source, /bootstrapR2ServingTimeoutMs|BOOTSTRAP_R2_TIMEOUT_MS_FAST|BOOTSTRAP_R2_TIMEOUT_MS_SLOW/);

  const timerStop = source.indexOf('const redisDurationMs = measureR2Shadow');
  const responseSerialization = source.indexOf('const response = jsonResponse({ data, missing }');
  assert.ok(timerStop >= 0 && responseSerialization >= 0);
  assert.ok(
    timerStop < responseSerialization,
    'the replaceable Redis assembly timer must stop before final response serialization',
  );
});
