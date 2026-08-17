import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import handler from '../api/bootstrap.js';

const PRIMARY_KEY = 'alerts:canada:v1';
const FALLBACK_KEY = 'alerts:alberta-aea:v1';
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function installRedis(values) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('fake.upstash.io')) throw new Error(`unexpected fetch ${url}`);

    const commands = JSON.parse(init.body);
    calls.push(commands);
    return new Response(JSON.stringify(commands.map(([, key]) => ({
      result: values.has(key) ? JSON.stringify(values.get(key)) : null,
    }))));
  };
  return calls;
}

function makePublicFastRequest() {
  return new Request('https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1', {
    headers: { origin: 'https://worldmonitor.app' },
  });
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  delete process.env.BOOTSTRAP_R2_SHADOW_MEASURE;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

test('public canadaAlerts keeps the aggregate authoritative when both cutover keys exist', async () => {
  const aggregate = { alerts: [{ id: 'bc-alert', province: 'BC' }] };
  const alberta = { alerts: [{ id: 'ab-alert', province: 'AB' }] };
  const calls = installRedis(new Map([
    [PRIMARY_KEY, aggregate],
    [FALLBACK_KEY, alberta],
  ]));

  const response = await handler(makePublicFastRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data.canadaAlerts, aggregate);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].some(command => command[0] === 'GET' && command[1] === PRIMARY_KEY));
  assert.ok(calls[0].some(command => command[0] === 'GET' && command[1] === FALLBACK_KEY));
});

test('public canadaAlerts uses the Alberta snapshot when the aggregate is missing', async () => {
  const alberta = { alerts: [{ id: 'ab-alert', province: 'AB' }] };
  const calls = installRedis(new Map([[FALLBACK_KEY, alberta]]));

  const response = await handler(makePublicFastRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data.canadaAlerts, alberta);
  assert.ok(!body.missing.includes('canadaAlerts'));
  assert.equal(calls.length, 1);
});
