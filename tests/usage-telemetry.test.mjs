import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  __resetWmSessionTelemetryForTests,
  emitBootstrapR2Shadow,
} from '../api/_usage-telemetry.js';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeWaitUntilCtx() {
  const pending = [];
  return {
    ctx: { waitUntil: promise => pending.push(promise) },
    settle: async () => Promise.allSettled(pending),
  };
}

beforeEach(() => {
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-test-token';
  __resetWmSessionTelemetryForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
  __resetWmSessionTelemetryForTests();
});

test('bootstrap R2 shadow telemetry emits only the exact privacy allowlist', async () => {
  const events = [];
  globalThis.fetch = async (_input, init) => {
    events.push(...JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  };
  const { ctx, settle } = makeWaitUntilCtx();

  emitBootstrapR2Shadow(ctx, {
    r2Outcome: 'fallback',
    r2Reason: 'timeout',
    bootstrapTier: 'slow',
    r2DurationMs: 432.75,
    redisDurationMs: 125.5,
    executionRegion: 'iad1',
    executionCold: true,
    status: 200,
    request_id: 'must-not-pass',
    ip: '203.0.113.10',
    user_agent: 'must-not-pass',
    cookie: 'secret=must-not-pass',
    url: 'https://example.test/?token=must-not-pass',
    body: { token: 'must-not-pass' },
  });
  await settle();

  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), [
    'bootstrap_tier',
    'event_type',
    'execution_cold',
    'execution_region',
    'r2_duration_ms',
    'redis_duration_ms',
    'r2_outcome',
    'r2_reason',
    'route',
    'status',
  ].sort());
  assert.deepEqual(events[0], {
    event_type: 'bootstrap_r2_shadow',
    route: '/api/bootstrap',
    r2_outcome: 'fallback',
    r2_reason: 'timeout',
    bootstrap_tier: 'slow',
    r2_duration_ms: 432.75,
    redis_duration_ms: 125.5,
    execution_region: 'iad1',
    execution_cold: true,
    status: 200,
  });
  assert.equal(JSON.stringify(events[0]).includes('must-not-pass'), false);
});

test('bootstrap R2 shadow telemetry is disabled without telemetry configuration or waitUntil', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response('{}', { status: 200 });
  };
  const input = {
    r2Outcome: 'r2',
    r2Reason: null,
    bootstrapTier: 'fast',
    r2DurationMs: 12,
    executionRegion: null,
    executionCold: false,
    status: 200,
  };

  emitBootstrapR2Shadow(undefined, input);
  delete process.env.USAGE_TELEMETRY;
  const { ctx, settle } = makeWaitUntilCtx();
  emitBootstrapR2Shadow(ctx, input);
  await settle();

  assert.equal(attempts, 0);
});

test('bootstrap R2 delivery failures produce only a privacy-minimal platform log', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const { ctx, settle } = makeWaitUntilCtx();
    emitBootstrapR2Shadow(ctx, {
      r2Outcome: 'fallback',
      r2Reason: 'timeout',
      bootstrapTier: 'fast',
      r2DurationMs: 5000,
      executionRegion: 'iad1',
      executionCold: true,
      status: 200,
      secret: 'must-not-pass',
    });
    await settle();

    assert.equal(warnings.length, 1);
    assert.deepEqual(JSON.parse(warnings[0][0]), {
      event_type: 'bootstrap_r2_telemetry_delivery',
      failure_class: 'http_error',
      breaker_state: 'closed',
    });
    assert.equal(JSON.stringify(warnings).includes('must-not-pass'), false);
    assert.equal(JSON.stringify(warnings).includes('iad1'), false);
  } finally {
    console.warn = originalWarn;
  }
});

test('bootstrap R2 telemetry logs the circuit-breaker transition without event payloads', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response('{}', { status: 503 });
  };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    for (let index = 0; index < 20; index += 1) {
      const { ctx, settle } = makeWaitUntilCtx();
      emitBootstrapR2Shadow(ctx, {
        r2Outcome: 'fallback',
        r2Reason: 'unreadable',
        bootstrapTier: 'slow',
        r2DurationMs: index,
        executionRegion: 'sfo1',
        executionCold: index === 0,
        status: 200,
      });
      await settle();
    }

    const parsed = warnings.map(args => JSON.parse(args[0]));
    assert.equal(attempts, 20);
    assert.deepEqual(parsed.at(-1), {
      event_type: 'bootstrap_r2_telemetry_delivery',
      failure_class: 'breaker_transition',
      breaker_state: 'open',
    });
    assert.equal(JSON.stringify(parsed).includes('sfo1'), false);
    assert.equal(JSON.stringify(parsed).includes('slow'), false);
  } finally {
    console.warn = originalWarn;
  }
});
