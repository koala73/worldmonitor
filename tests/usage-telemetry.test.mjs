import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  __resetWmSessionTelemetryForTests,
  deriveExecutionRegion,
  emitOAuthTokenUsage,
  emitWmSessionUsage,
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

test('deriveExecutionRegion extracts the Vercel edge region prefix from x-vercel-id', () => {
  const withRegion = new Request('https://api.worldmonitor.app/api/wm-session', {
    headers: { 'x-vercel-id': 'iad1::12345-abcdef' },
  });
  const withoutSeparator = new Request('https://api.worldmonitor.app/api/wm-session', {
    headers: { 'x-vercel-id': 'no-region' },
  });
  const withoutHeader = new Request('https://api.worldmonitor.app/api/wm-session');

  assert.equal(deriveExecutionRegion(withRegion), 'iad1');
  assert.equal(deriveExecutionRegion(withoutSeparator), null);
  assert.equal(deriveExecutionRegion(withoutHeader), null);
});

test('emitWmSessionUsage emits allowlisted request metadata without leaking secrets or query strings', async () => {
  const events = [];
  const deliveryHeaders = [];
  globalThis.fetch = async (_input, init) => {
    deliveryHeaders.push(init.headers);
    events.push(...JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  };
  const { ctx, settle } = makeWaitUntilCtx();

  const req = new Request('https://api.worldmonitor.app/api/wm-session?secret=must-not-pass', {
    method: 'POST',
    headers: {
      origin: 'https://worldmonitor.app',
      referer: 'https://worldmonitor.app/dashboard?token=must-not-pass',
      cookie: 'wm-session=must-not-pass',
      'x-vercel-id': 'iad1::req-1',
      'user-agent': 'test-browser/1.0',
    },
  });
  const res = new Response(null, { status: 204 });

  emitWmSessionUsage(ctx, req, res, Date.now() - 10, 'minted');
  await settle();

  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'request');
  assert.equal(events[0].route, '/api/wm-session');
  assert.equal(events[0].domain, 'auth');
  assert.equal(events[0].status, 204);
  assert.equal(events[0].reason, 'minted');
  assert.equal(events[0].execution_region, 'iad1');
  assert.equal(events[0].referer, 'https://worldmonitor.app/dashboard');
  assert.equal(JSON.stringify(events[0]).includes('must-not-pass'), false);
  assert.equal(deliveryHeaders.length, 1);
  assert.equal(deliveryHeaders[0]['User-Agent'], 'worldmonitor-edge/1.0');
});

test('emitOAuthTokenUsage is disabled without telemetry configuration or waitUntil', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response('{}', { status: 200 });
  };
  const req = new Request('https://api.worldmonitor.app/api/oauth/token', { method: 'POST' });
  const res = new Response('{}', { status: 429 });

  emitOAuthTokenUsage(undefined, req, res, Date.now(), 'rate_limited');
  delete process.env.USAGE_TELEMETRY;
  const { ctx, settle } = makeWaitUntilCtx();
  emitOAuthTokenUsage(ctx, req, res, Date.now(), 'rate_limited');
  await settle();

  assert.equal(attempts, 0);
});

test('telemetry circuit breaker trips after repeated delivery failures and skips while open', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response('{}', { status: 503 });
  };
  const req = new Request('https://api.worldmonitor.app/api/oauth/token', { method: 'POST' });
  const res = new Response('{}', { status: 200 });

  for (let index = 0; index < 25; index += 1) {
    const { ctx, settle } = makeWaitUntilCtx();
    emitOAuthTokenUsage(ctx, req, res, Date.now(), 'issued');
    await settle();
  }

  assert.equal(attempts, 20);
});
