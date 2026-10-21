import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import handler from '../api/bootstrap.js';

const PRIMARY_KEY = 'alerts:canada:v1';
const SIBLING_KEY = 'alerts:canada:alberta-aea:v1';
const LEGACY_KEY = 'alerts:alberta-aea:v1';
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
    [SIBLING_KEY, alberta],
    [LEGACY_KEY, alberta],
  ]));

  const response = await handler(makePublicFastRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data.canadaAlerts, aggregate);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].some(command => command[0] === 'GET' && command[1] === PRIMARY_KEY));
  assert.ok(calls[0].some(command => command[0] === 'GET' && command[1] === SIBLING_KEY));
  assert.ok(calls[0].some(command => command[0] === 'GET' && command[1] === LEGACY_KEY));
});

test('public canadaAlerts prefers the Alberta sibling when the aggregate is missing', async () => {
  const sibling = { alerts: [{ id: 'ab-sibling', province: 'AB' }] };
  const legacy = { alerts: [{ id: 'ab-legacy', province: 'AB' }] };
  const calls = installRedis(new Map([
    [SIBLING_KEY, sibling],
    [LEGACY_KEY, legacy],
  ]));

  const response = await handler(makePublicFastRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data.canadaAlerts, sibling);
  assert.ok(!body.missing.includes('canadaAlerts'));
  assert.equal(calls.length, 1);
});

test('public canadaAlerts uses the abandoned legacy key when only it remains', async () => {
  const legacy = { alerts: [{ id: 'ab-alert', province: 'AB' }] };
  installRedis(new Map([[LEGACY_KEY, legacy]]));

  const response = await handler(makePublicFastRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data.canadaAlerts, legacy);
  assert.ok(!body.missing.includes('canadaAlerts'));
});

test('public canadaAlerts does not resurrect Alberta data when the union is an empty payload', async () => {
  const emptyUnion = { alerts: [] };
  const alberta = { alerts: [{ id: 'ab-alert', province: 'AB' }] };
  installRedis(new Map([
    [PRIMARY_KEY, emptyUnion],
    [SIBLING_KEY, alberta],
    [LEGACY_KEY, alberta],
  ]));

  const response = await handler(makePublicFastRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data.canadaAlerts, emptyUnion);
});

test('public canadaAlerts stays missing when a present aggregate unwraps to undefined', async () => {
  const alberta = { alerts: [{ id: 'ab-alert', province: 'AB' }] };
  installRedis(new Map([
    [PRIMARY_KEY, { _seed: { fetchedAt: 1 } }],
    [SIBLING_KEY, alberta],
    [LEGACY_KEY, alberta],
  ]));

  const response = await handler(makePublicFastRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(body.data, 'canadaAlerts'), false);
  assert.ok(body.missing.includes('canadaAlerts'));
});
