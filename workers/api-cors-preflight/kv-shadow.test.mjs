// Tests for the KV shadow measurement added to the api-cors-preflight Worker (U-K2, #5338).
//
// The load-bearing assertion is the FIRST one: the CORS response must be byte-identical whether
// the shadow is on or off. This Worker is the CORS source of truth (a 2026-05-27 outage lived
// here); the shadow is only allowed in because it cannot change what the browser sees.

import { strict as assert } from 'node:assert';
import test from 'node:test';

import worker from './src/index.js';
import {
  __resetKvShadowForTests,
  bootstrapTierFromPublicRequest,
  classifyKvEnvelope,
  maybeShadowKvRead,
  TIER_MAX_AGE_MS,
} from './src/kv-shadow.js';

const BOOT_URL = 'https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1';
const freshEnvelope = (tier = 'fast', ageMs = 0) =>
  JSON.stringify({ tier, generatedAt: Date.now() - ageMs, payload: { data: {}, missing: [] } });

// Route global fetch: Axiom POSTs are captured; everything else is a canned "origin" response.
function installFetch(onAxiom, { axiomStatus = 200, axiomError = null } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : input?.url ?? '';
    if (u.includes('api.axiom.co')) {
      onAxiom?.(JSON.parse(init.body), init);
      if (axiomError) throw axiomError;
      return new Response('{}', { status: axiomStatus });
    }
    return new Response('{"data":{}}', { status: 200, headers: { 'X-Origin': 'vercel' } });
  };
  return () => { globalThis.fetch = real; };
}

function makeEnv({ shadow = '1', kvValue = null, kvThrows = false, token = 'axiom-tok' } = {}) {
  return {
    BOOTSTRAP_KV_SHADOW: shadow,
    AXIOM_API_TOKEN: token,
    BOOTSTRAP_KV: { get: async () => { if (kvThrows) throw new Error('kv down'); return kvValue; } },
  };
}
function makeCtx() {
  const waits = [];
  return { ctx: { waitUntil: (p) => waits.push(p) }, waits };
}
const bootReq = () => new Request(BOOT_URL, { method: 'GET', headers: { Origin: 'https://worldmonitor.app' } });

test('CORS response is byte-identical whether the KV shadow is on or off', async () => {
  __resetKvShadowForTests();
  const restore = installFetch(() => {});
  try {
    const c1 = makeCtx();
    const off = await worker.fetch(bootReq(), makeEnv({ shadow: '0' }), c1.ctx);

    let probes = 0;
    const onEnv = makeEnv({ shadow: '1', kvValue: freshEnvelope() });
    const readKv = onEnv.BOOTSTRAP_KV.get;
    onEnv.BOOTSTRAP_KV.get = async (...args) => { probes += 1; return readKv(...args); };
    const c2 = makeCtx();
    const on = await worker.fetch(bootReq(), onEnv, c2.ctx);
    assert.equal(c2.waits.length, 1, 'shadow on schedules exactly one probe');
    await Promise.all(c2.waits);

    assert.equal(off.status, on.status);
    assert.deepEqual([...off.headers].sort(), [...on.headers].sort(), 'headers identical');
    assert.equal(await off.text(), await on.text(), 'body identical');
    assert.equal(c1.waits.length, 0, 'shadow off => no waitUntil work');
    assert.equal(probes, 1, 'the scheduled shadow work reads KV exactly once');
  } finally { restore(); }
});

test('shadow off emits nothing', async () => {
  let emitted = 0;
  const restore = installFetch(() => { emitted += 1; });
  try {
    const { ctx, waits } = makeCtx();
    await worker.fetch(bootReq(), makeEnv({ shadow: '0' }), ctx);
    await Promise.all(waits);
    assert.equal(emitted, 0);
  } finally { restore(); }
});

test('a non-bootstrap request never probes KV', async () => {
  let probed = false;
  const env = makeEnv({ kvValue: freshEnvelope() });
  env.BOOTSTRAP_KV.get = async () => { probed = true; return null; };
  const { ctx, waits } = makeCtx();
  maybeShadowKvRead(new Request('https://api.worldmonitor.app/api/health'), new URL('https://api.worldmonitor.app/api/health'), env, ctx);
  await Promise.all(waits);
  assert.equal(probed, false);
});

test('emits an allowlisted event with outcome kv on a fresh value', async () => {
  let event;
  let requestInit;
  const restore = installFetch((body, init) => { event = body[0]; requestInit = init; });
  try {
    const env = makeEnv({ kvValue: freshEnvelope('fast') });
    const { ctx, waits } = makeCtx();
    const req = { method: 'GET', cf: { colo: 'SIN', country: 'SG' } };
    maybeShadowKvRead(req, new URL(BOOT_URL), env, ctx);
    await Promise.all(waits);

    assert.equal(event.event_type, 'bootstrap_kv_shadow');
    assert.equal(event.bootstrap_tier, 'fast');
    assert.equal(event.kv_outcome, 'kv');
    assert.equal(event.kv_reason, null);
    assert.equal(typeof event.kv_duration_ms, 'number');
    assert.equal(event.cf_colo, 'SIN');
    assert.equal(event.cf_country, 'SG');
    assert.equal(requestInit.headers['User-Agent'], 'WorldMonitor Bootstrap KV Shadow/1.0');
    // Privacy: EXACTLY the allowlist (+ _time). No ip/user_agent/customer_id/etc. can appear.
    assert.deepEqual(
      Object.keys(event).sort(),
      ['_time', 'bootstrap_tier', 'cf_colo', 'cf_country', 'event_type', 'execution_cold', 'kv_duration_ms', 'kv_outcome', 'kv_reason'].sort(),
    );
  } finally { restore(); }
});

test('failure modes map to the right reason and never throw', async () => {
  for (const [setup, expected] of [
    [{ kvValue: null }, { outcome: 'fallback', reason: 'miss' }],
    [{ kvValue: '{not json' }, { outcome: 'fallback', reason: 'invalid' }],
    [{ kvValue: freshEnvelope('fast', TIER_MAX_AGE_MS.fast + 60_000) }, { outcome: 'fallback', reason: 'stale' }],
    [{ kvValue: JSON.stringify({ tier: 'slow', generatedAt: Date.now(), payload: {} }) }, { outcome: 'fallback', reason: 'invalid' }], // wrong tier
    [{ kvValue: JSON.stringify({ tier: 'fast', generatedAt: Date.now(), payload: { missing: [] } }) }, { outcome: 'fallback', reason: 'invalid' }], // missing data
    [{ kvValue: JSON.stringify({ tier: 'fast', generatedAt: Date.now() + 6 * 60_000, payload: { data: {}, missing: [] } }) }, { outcome: 'fallback', reason: 'invalid' }], // future skew
    [{ kvValue: JSON.stringify({ tier: 'fast', generatedAt: Date.now() + 0.5, payload: { data: {}, missing: [] } }) }, { outcome: 'fallback', reason: 'invalid' }], // non-integer timestamp
    [{ kvThrows: true }, { outcome: 'fallback', reason: 'error' }],
  ]) {
    let event;
    const restore = installFetch((body) => { event = body[0]; });
    try {
      const { ctx, waits } = makeCtx();
      maybeShadowKvRead({ method: 'GET', cf: { colo: 'HKG' } }, new URL(BOOT_URL), makeEnv(setup), ctx);
      await Promise.all(waits);
      assert.equal(event.kv_outcome, expected.outcome, JSON.stringify(setup));
      assert.equal(event.kv_reason, expected.reason, JSON.stringify(setup));
    } finally { restore(); }
  }
});

test('execution_cold is a boolean and a consecutive probe is warm', async () => {
  __resetKvShadowForTests();
  const events = [];
  const restore = installFetch((body) => { events.push(body[0]); });
  try {
    for (let i = 0; i < 2; i++) {
      const { ctx, waits } = makeCtx();
      maybeShadowKvRead({ method: 'GET', cf: {} }, new URL(BOOT_URL), makeEnv({ kvValue: freshEnvelope() }), ctx);
      await Promise.all(waits);
    }
    assert.equal(events[0].execution_cold, true, 'the first probe in a fresh isolate is cold');
    assert.equal(events[1].execution_cold, false, 'the second consecutive probe in an isolate is warm');
  } finally { restore(); }
});

test('bootstrapTierFromPublicRequest mirrors the public-tier contract', () => {
  const tier = (u, method = 'GET') => bootstrapTierFromPublicRequest({ method }, new URL(u));
  assert.equal(tier(BOOT_URL), 'fast');
  assert.equal(tier('https://api.worldmonitor.app/api/bootstrap?tier=slow&public=1'), 'slow');
  assert.equal(tier(BOOT_URL, 'POST'), null, 'non-GET');
  assert.equal(tier('https://api.worldmonitor.app/api/bootstrap?tier=fast'), null, 'no public=1');
  assert.equal(tier('https://api.worldmonitor.app/api/bootstrap?tier=bogus&public=1'), null, 'unknown tier');
  assert.equal(tier('https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1&x=1'), null, 'extra param');
  assert.equal(tier('https://api.worldmonitor.app/api/other?tier=fast&public=1'), null, 'wrong path');
});

test('Axiom delivery failures produce bounded operator-visible warnings', async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (message) => warnings.push(JSON.parse(message));
  const restore = installFetch(() => {}, { axiomStatus: 503 });
  try {
    __resetKvShadowForTests();
    for (let i = 0; i < 2; i++) {
      const { ctx, waits } = makeCtx();
      maybeShadowKvRead({ method: 'GET', cf: {} }, new URL(BOOT_URL), makeEnv({ token: '' }), ctx);
      await Promise.all(waits);
    }
    assert.equal(
      warnings.filter((event) => event.failure_class === 'missing_token').length,
      1,
      'each failure class is logged at most once per isolate',
    );

    __resetKvShadowForTests();
    const { ctx, waits } = makeCtx();
    maybeShadowKvRead({ method: 'GET', cf: {} }, new URL(BOOT_URL), makeEnv(), ctx);
    await Promise.all(waits);
    assert.ok(warnings.some((event) => event.failure_class === 'http_error'));
  } finally {
    restore();
    console.warn = realWarn;
  }
});

test('classifyKvEnvelope decides serve-vs-fallback like the serving path', () => {
  const now = Date.now();
  assert.deepEqual(classifyKvEnvelope('fast', null, now), { outcome: 'fallback', reason: 'miss' });
  assert.deepEqual(classifyKvEnvelope('fast', freshEnvelope('fast'), now), { outcome: 'kv', reason: null });
  assert.equal(classifyKvEnvelope('fast', freshEnvelope('fast', TIER_MAX_AGE_MS.fast + 1000), now).reason, 'stale');
  assert.equal(classifyKvEnvelope('fast', 'garbage{', now).reason, 'invalid');
  assert.equal(classifyKvEnvelope('fast', JSON.stringify({ tier: 'fast', generatedAt: now, payload: [] }), now).reason, 'invalid');
  assert.equal(classifyKvEnvelope('fast', JSON.stringify({ tier: 'fast', generatedAt: now + 6 * 60_000, payload: { data: {}, missing: [] } }), now).reason, 'invalid');
});
