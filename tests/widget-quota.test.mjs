import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { quotaStore } from './widget-quota-fixture.mjs';
import {
  reserveWidgetQuota,
  widgetPrincipal,
  signWidgetPrincipal,
  verifyWidgetPrincipal,
  WIDGET_MODEL_POLICY,
} from '../api/_widget-quota.js';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});
function setup(limit) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://quota.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-token';
  process.env.WIDGET_QUOTA_SIGNING_KEY =
    'synthetic-signing-secret-at-least-32-bytes';
  const store = quotaStore(limit);
  globalThis.fetch = store.fetch;
  return store;
}
const principal = await widgetPrincipal('user', 'synthetic-user');
test('real Lua serializes concurrent replicas, denies exhaustion, and rolls over by Redis time', async () => {
  const ledger = setup(1000);
  const attempts = await Promise.allSettled(
    Array.from({ length: 30 }, () =>
      reserveWidgetQuota(principal, 'pro', 'paid', 100),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 10);
  assert.equal(ledger.store.get('spent'), '1000');
  globalThis.fetch = ledger.fetch; // a new caller has no local counter state
  await assert.rejects(reserveWidgetQuota(principal, 'pro', 'paid', 1), {
    status: 429,
  });
  ledger.clock.now += 86400;
  await reserveWidgetQuota(principal, 'pro', 'paid', 100);
  assert.equal(ledger.store.get('spent'), '100');
});
test('global cap covers multiple users; per-user cap does not charge peers', async () => {
  const ledger = setup(500);
  ledger.store.set('proLimit', '200');
  const peer = await widgetPrincipal('user', 'peer');
  await reserveWidgetQuota(principal, 'pro', 'paid', 200);
  await assert.rejects(reserveWidgetQuota(principal, 'pro', 'paid', 1), {
    status: 429,
  });
  await reserveWidgetQuota(peer, 'pro', 'paid', 200);
  await assert.rejects(
    reserveWidgetQuota(
      await widgetPrincipal('user', 'third'),
      'pro',
      'paid',
      101,
    ),
    { status: 429 },
  );
});
test('hourly admission is shared across replicas, separate at edge and relay, and cannot reset by tier switching', async () => {
  const ledger = setup();
  for (let i = 0; i < 20; i++)
    await reserveWidgetQuota(principal, 'pro', 'edge');
  await assert.rejects(reserveWidgetQuota(principal, 'pro', 'edge'), {
    status: 429,
  });
  await assert.rejects(reserveWidgetQuota(principal, 'basic', 'edge'), {
    status: 429,
  });
  for (let i = 0; i < 10; i++)
    await reserveWidgetQuota(principal, 'basic', 'relay');
  await assert.rejects(reserveWidgetQuota(principal, 'basic', 'relay'), {
    status: 429,
  });
  ledger.clock.now += 3600;
  await reserveWidgetQuota(principal, 'basic', 'relay');
});
test('missing, corrupt, future, and partial ledger state fail closed without repair', async () => {
  for (const [field, value] of [
    ['tariff', null],
    ['spent', null],
    ['spent', '-1'],
    ['day', '999999'],
    ['globalLimit', 'NaN'],
    [principal, '{'],
    [principal, '{}'],
  ]) {
    const ledger = setup();
    if (value === null) ledger.store.delete(field);
    else ledger.store.set(field, value);
    const before = [...ledger.store];
    await assert.rejects(reserveWidgetQuota(principal, 'pro', 'paid', 1), {
      status: 503,
    });
    assert.deepEqual([...ledger.store], before);
  }
});
test('missing configuration and malformed/failed Redis responses deny', async () => {
  setup();
  for (const payload of [
    null,
    {},
    { result: null },
    { result: ['200', 0] },
    { result: [200, 1] },
    { result: [200, 0], error: 'ERR' },
  ]) {
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(reserveWidgetQuota(principal, 'pro', 'paid', 1), {
      status: 503,
    });
  }
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  await assert.rejects(reserveWidgetQuota(principal, 'pro', 'paid', 1), {
    status: 503,
  });
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  await assert.rejects(reserveWidgetQuota(principal, 'pro', 'paid', 1), {
    status: 503,
  });
});
test('signature binds authenticated principal, tier, body, and time; tester keys cannot sign', async () => {
  setup();
  const proof = Object.fromEntries(
    Object.entries(await signWidgetPrincipal(principal, 'pro', '{}')).map(
      ([k, v]) => [k.toLowerCase(), v],
    ),
  );
  assert.equal(await verifyWidgetPrincipal(proof, 'pro', '{}'), principal);
  for (const [headers, tier, body] of [
    [proof, 'basic', '{}'],
    [proof, 'pro', '{"prompt":"tampered"}'],
    [
      {
        ...proof,
        'x-widget-principal': await widgetPrincipal('user', 'victim'),
      },
      'pro',
      '{}',
    ],
    [{ ...proof, 'x-widget-timestamp': '1000000000' }, 'pro', '{}'],
  ]) {
    await assert.rejects(verifyWidgetPrincipal(headers, tier, body), {
      status: 403,
    });
  }
  process.env.WIDGET_QUOTA_SIGNING_KEY =
    'another-synthetic-secret-at-least-32-bytes';
  await assert.rejects(verifyWidgetPrincipal(proof, 'pro', '{}'), {
    status: 403,
  });
});
test('model reservations cover maximum context plus capped output at standard list rates', () => {
  assert.deepEqual(WIDGET_MODEL_POLICY.basic, {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 4096,
    microUsd: 200000 * 1 + 4096 * 5,
  });
  assert.deepEqual(WIDGET_MODEL_POLICY.pro, {
    model: 'claude-sonnet-4-6',
    maxTokens: 8192,
    microUsd: 1000000 * 3 + 8192 * 15,
  });
});
