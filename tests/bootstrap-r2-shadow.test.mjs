import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';

import handler, { __testing__ } from '../api/bootstrap.js';
import { BOOTSTRAP_R2_PROBE_CEILING_MS } from '../api/_bootstrap-r2.js';

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

function installFetchHarness({ r2Status = 200, redisFailure = null } = {}) {
  const calls = { redis: 0, redisCommands: [], r2: 0, axiom: 0, events: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    if (url.includes('fake.upstash.io')) {
      calls.redis += 1;
      const commands = JSON.parse(init.body);
      calls.redisCommands.push(commands);
      if (redisFailure === 'http') return new Response(null, { status: 503 });
      if (redisFailure === 'command') {
        return new Response(JSON.stringify(commands.map((_, index) => (
          index === 0 ? { error: 'ERR test failure' } : { result: null }
        ))), { status: 200 });
      }
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

function assertRedisDurationMatchesHeader(response, event) {
  const header = response.headers.get('x-worldmonitor-bootstrap-redis-duration');
  assert.match(header ?? '', /^\d+(?:\.\d+)?$/);
  assert.equal(typeof event.redis_duration_ms, 'number');
  assert.ok(event.redis_duration_ms >= 0);
  assert.equal(event.redis_duration_ms.toFixed(3), header);
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
  assert.equal(response.headers.get('x-worldmonitor-bootstrap-redis-duration'), null);
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
  assert.equal(response.headers.get('x-worldmonitor-bootstrap-redis-duration'), null);
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
    assert.match(
      response.headers.get('x-worldmonitor-bootstrap-redis-duration') ?? '',
      /^\d+(?:\.\d+)?$/,
    );
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('cdn-cache-control') ?? '', /^public, /);
    assert.equal(calls.redis, 1);
    assert.equal(calls.r2, 1);
    assert.equal(calls.axiom, 1);
    assert.equal(wait.pending.length, 1, 'the probe and its telemetry must share one waitUntil task');
    assert.equal(body.data.ignored, undefined, 'the R2 payload must never become the shadow response');
    assert.equal(calls.events[0].r2_outcome, expectedOutcome);
    assert.equal(calls.events[0].r2_reason, expectedReason);
    assert.equal(calls.events[0].bootstrap_tier, 'slow');
    assertRedisDurationMatchesHeader(response, calls.events[0]);
    assert.equal(calls.events[0].execution_region, 'iad1');
    assert.equal(calls.events[0].status, 200);
    assert.deepEqual(
      calls.redisCommands[0].at(-1),
      ['GET', 'bootstrap:r2-shadow-origin-marker:slow'],
      'the MONITOR denominator must distinguish serving from publisher pipelines',
    );
    const exposed = response.headers.get('access-control-expose-headers') ?? '';
    assert.match(exposed, /Server-Timing/i);
    assert.match(exposed, /X-WorldMonitor-Bootstrap-Redis-Duration/i);
    assert.match(exposed, /X-Vercel-Cache/i);
    assert.match(exposed, /CF-Cache-Status/i);
  });
}

test('a rejected shadow reader emits unreadable fallback telemetry without altering Redis', async () => {
  process.env.BOOTSTRAP_R2_SHADOW_MEASURE = '1';
  const calls = installFetchHarness();
  const wait = makeWaitUntilCtx();
  let readerInput;
  __testing__.setBootstrapR2ShadowReaderForTests(async (tier, options) => {
    readerInput = { tier, options };
    throw new Error('rejected test probe');
  });

  const response = await handler(makeRequest('tier=slow&public=1'), wait.ctx);
  const body = await response.json();
  await wait.settle();

  assert.equal(response.status, 200);
  assert.equal(calls.redis, 1);
  assert.equal(calls.r2, 0);
  assert.equal(calls.axiom, 1);
  assert.equal(wait.pending.length, 1);
  assert.equal(body.data.ignored, undefined, 'the rejected R2 probe must not alter the Redis response');
  assert.equal(calls.events[0].r2_outcome, 'fallback');
  assert.equal(calls.events[0].r2_reason, 'unreadable');
  assert.equal(calls.events[0].r2_duration_ms, 0);
  assert.equal(calls.events[0].status, 200);
  assert.deepEqual(readerInput, {
    tier: 'slow',
    options: { timeoutMs: BOOTSTRAP_R2_PROBE_CEILING_MS },
  });
  assertRedisDurationMatchesHeader(response, calls.events[0]);
});

for (const [label, redisFailure] of [
  ['HTTP', 'http'],
  ['command', 'command'],
]) {
  test(`a Redis ${label} failure preserves the 503 response and records its timer`, async () => {
    process.env.BOOTSTRAP_R2_SHADOW_MEASURE = '1';
    const calls = installFetchHarness({ redisFailure });
    const wait = makeWaitUntilCtx();

    const response = await handler(makeRequest('tier=fast&public=1'), wait.ctx);
    const body = await response.json();
    await wait.settle();

    assert.equal(response.status, 503);
    assert.deepEqual(body, { error: 'Bootstrap service temporarily unavailable' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('cdn-cache-control'), null);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.equal(calls.redis, 1);
    assert.equal(calls.r2, 1);
    assert.equal(calls.axiom, 1);
    assert.equal(wait.pending.length, 1);
    assert.equal(calls.events[0].status, 503);
    assertRedisDurationMatchesHeader(response, calls.events[0]);
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
  assert.doesNotMatch(source, /bootstrapR2ServingTimeoutMs|BOOTSTRAP_R2_TIMEOUT_MS_FAST|BOOTSTRAP_R2_TIMEOUT_MS_SLOW/);

  const timerStop = source.indexOf('const redisDurationMs = measureR2Shadow');
  const responseSerialization = source.indexOf('const response = jsonResponse({ data, missing }');
  assert.ok(timerStop >= 0 && responseSerialization >= 0);
  assert.ok(
    timerStop < responseSerialization,
    'the replaceable Redis assembly timer must stop before final response serialization',
  );
});
