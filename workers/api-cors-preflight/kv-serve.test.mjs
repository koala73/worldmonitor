// Tests for KV serving added to the api-cors-preflight Worker (U-K4, #5338).
//
// The load-bearing invariant: serving is STRICTLY ADDITIVE. With the flag off (the kill-switch)
// behaviour is byte-identical to the origin pass-through, and every KV failure mode
// (miss/invalid/stale/error/timeout) falls through to origin — never a served 5xx. When serving is
// on, the body is the tier envelope's payload and the CORS headers match what the Worker stamps on
// the pass-through (it remains the CORS source of truth). Production is BOOTSTRAP_KV_SERVE="all".

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

import worker from './src/index.js';
import { BOOTSTRAP_TIER_ENVELOPE_SCHEMA_VERSION, TIER_MAX_AGE_MS } from './src/kv-shadow.js';
// Shared with the origin-handler and deployed-URL guards — see index.test.mjs.
import { assertPublicBootstrapCorsHeaders } from '../../tests/helpers/public-bootstrap-contract.mjs';

const FAST_URL = 'https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1';
const SLOW_URL = 'https://api.worldmonitor.app/api/bootstrap?tier=slow&public=1';

const payloadFor = (tier) => ({ data: { [`${tier}-key`]: { v: 1 } }, missing: [`${tier}-missing`] });
const envelopeFor = (tier, ageMs = 0) =>
  JSON.stringify({
    schemaVersion: BOOTSTRAP_TIER_ENVELOPE_SCHEMA_VERSION,
    tier,
    generatedAt: Date.now() - ageMs,
    payload: payloadFor(tier),
  });

// Route global fetch: Axiom POSTs captured; everything else is a canned "origin" response tagged
// X-Origin: vercel so a test can tell served-from-KV (source marker) from origin pass-through.
// originDelayMs (with mock timers) lets a test make origin lose a hedge race to a slower-but-valid KV.
function installFetch(onAxiom, onOrigin, { originDelayMs = 0 } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : input?.url ?? '';
    if (u.includes('api.axiom.co')) {
      onAxiom?.(JSON.parse(init.body), init);
      return new Response('{}', { status: 200 });
    }
    onOrigin?.(input, init);
    if (originDelayMs) await new Promise((r) => setTimeout(r, originDelayMs));
    return new Response('{"data":{"origin":1},"missing":[]}', { status: 200, headers: { 'X-Origin': 'vercel' } });
  };
  return () => { globalThis.fetch = real; };
}
// Resolve KV after `ms` on the mock clock (a slow-but-under-budget read that outruns the hedge window).
const slowGet = (ms) => (tier) => new Promise((r) => setTimeout(() => r(envelopeFor(tier)), ms));

function makeEnv({ serve = 'all', shadow = '0', kvValue = null, get, token = 'axiom-tok', binding = true } = {}) {
  const env = { BOOTSTRAP_KV_SERVE: serve, BOOTSTRAP_KV_SHADOW: shadow, AXIOM_API_TOKEN: token };
  if (binding) {
    env.BOOTSTRAP_KV = { get: get ?? (async () => kvValue) };
  }
  return env;
}
function makeCtx() {
  const waits = [];
  return { ctx: { waitUntil: (p) => waits.push(p) }, waits };
}
const req = (url, method = 'GET') => new Request(url, { method, headers: { Origin: 'https://worldmonitor.app' } });
const corsOf = (r) => Object.fromEntries([...r.headers].filter(([k]) => k.startsWith('access-control') || k === 'vary'));

test('serve=all: public-tier GET is served from KV, not origin, with the payload body', async () => {
  const restore = installFetch();
  try {
    const env = makeEnv({ serve: 'all', get: async (tier) => envelopeFor(tier) });
    const { ctx, waits } = makeCtx();
    const res = await worker.fetch(req(FAST_URL), env, ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), 'kv');
    assert.equal(res.headers.get('X-Origin'), null, 'must not reach origin');
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('Timing-Allow-Origin'), '*', 'KV-served public bootstrap exposes transfer timing');
    assert.deepEqual(JSON.parse(await res.text()), payloadFor('fast'), 'body is the envelope payload');
    await Promise.all(waits);
  } finally { restore(); }
});

test('served CORS headers are identical to the origin pass-through the Worker would stamp', async () => {
  const restore = installFetch();
  try {
    const passthru = await worker.fetch(req(FAST_URL), makeEnv({ serve: 'off', kvValue: envelopeFor('fast') }), makeCtx().ctx);
    const served = await worker.fetch(req(FAST_URL), makeEnv({ serve: 'all', kvValue: envelopeFor('fast') }), makeCtx().ctx);
    assert.equal(served.headers.get('X-WorldMonitor-Bootstrap-Source'), 'kv');
    assert.equal(passthru.headers.get('X-Origin'), 'vercel');
    assert.deepEqual(corsOf(served), corsOf(passthru), 'CORS/Vary identical served vs pass-through');
  } finally { restore(); }
});

// #7308: the served bytes must carry api/bootstrap.js's PUBLIC header shape
// (getPublicBootstrapHeaders: ACAO:*, no Allow-Credentials, no Vary: Origin),
// not the Worker's credentialed bag. The origin handler reaches that shape only
// for public auth kinds, and `?tier=<t>&public=1` is exactly one of them; the
// edge previously made no such distinction, so an unauthenticated seed payload
// went out with Allow-Credentials: true alongside Timing-Allow-Origin: *.
test('KV-served public bootstrap carries the same deprecation policy Link as origin', async () => {
  // maybeServeBootstrapFromKv returns serveFromKv() and never enters
  // passThroughToOrigin, which is where the origin path appends the policy
  // Link. Production BOOTSTRAP_KV_SERVE="all" would otherwise omit it on the
  // bytes clients actually receive.
  const restore = installFetch();
  try {
    const passthru = await worker.fetch(req(FAST_URL), makeEnv({ serve: 'off', kvValue: envelopeFor('fast') }), makeCtx().ctx);
    const served = await worker.fetch(req(FAST_URL), makeEnv({ serve: 'all', kvValue: envelopeFor('fast') }), makeCtx().ctx);
    assert.equal(served.headers.get('X-WorldMonitor-Bootstrap-Source'), 'kv');
    assert.match(served.headers.get('link') ?? '', /rel="deprecation"/);
    assert.match(served.headers.get('link') ?? '', /https:\/\/www\.worldmonitor\.app\/api-versioning\.md/);
    assert.equal(
      served.headers.get('link'),
      passthru.headers.get('link'),
      'KV and origin pass-through must advertise the same policy Link',
    );
  } finally { restore(); }
});

test('the KV-served public tier carries the origin public header shape (#7308)', async () => {
  const restore = installFetch();
  try {
    const res = await worker.fetch(req(FAST_URL), makeEnv({ serve: 'all', kvValue: envelopeFor('fast') }), makeCtx().ctx);
    assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), 'kv');
    assertPublicBootstrapCorsHeaders({ assert, resp: res, label: 'KV-served fast tier' });
    assert.equal(res.headers.get('Vary'), null, 'a caller-invariant payload must not be keyed by Origin');
  } finally { restore(); }
});

test('a disallowed Origin is still KV-served, but under the credentialed fallback bag', async () => {
  // The header denial and the routing decision are separate. A disallowed Origin
  // must not get ACAO:* — but it must still be answered from KV, or one bogus
  // header on every request becomes a free lever for forcing Vercel/Redis load
  // that the same caller could avoid entirely by omitting the header.
  const restore = installFetch();
  try {
    const evil = new Request(FAST_URL, { method: 'GET', headers: { Origin: 'https://evil.example' } });
    const res = await worker.fetch(evil, makeEnv({ serve: 'all', kvValue: envelopeFor('fast') }), makeCtx().ctx);
    assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), 'kv', 'still served from KV');
    assert.equal(res.headers.get('X-Origin'), null, 'origin was not enlisted');
    assert.equal(
      res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app',
      'the canonical fallback echo is what denies the browser read',
    );
    assert.equal(res.headers.get('Access-Control-Allow-Credentials'), 'true');
    assert.match(res.headers.get('link') ?? '', /rel="deprecation"/);
  } finally { restore(); }
});

test('the KV path never receives a status function it would spread into nothing', async () => {
  // serveFromKv spreads its corsHeaders argument directly, so a status-function
  // reaching it would produce a 200 with zero CORS headers — a silent fail-open
  // into an unreadable cross-origin response. Pinned for whoever widens the
  // predicate next: every KV-served response carries a real ACAO, allowed Origin
  // or not.
  const restore = installFetch();
  try {
    const env = makeEnv({ serve: 'all', get: async (tier) => envelopeFor(tier) });
    for (const [label, request] of [
      ['allowed Origin', req(FAST_URL)],
      ['no Origin', new Request(FAST_URL, { method: 'GET' })],
      ['disallowed Origin', new Request(FAST_URL, { method: 'GET', headers: { Origin: 'https://evil.example' } })],
      ['allowed Origin, slow tier', req(SLOW_URL)],
    ]) {
      const res = await worker.fetch(request, env, makeCtx().ctx);
      assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), 'kv', `${label}: served from KV`);
      assert.ok(res.headers.get('Access-Control-Allow-Origin'), `${label}: has an ACAO`);
    }
  } finally { restore(); }
});

test('the KV-served slow tier carries the same public shape as fast', async () => {
  const restore = installFetch();
  try {
    const res = await worker.fetch(req(SLOW_URL), makeEnv({ serve: 'all', get: async (tier) => envelopeFor(tier) }), makeCtx().ctx);
    assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), 'kv');
    assertPublicBootstrapCorsHeaders({ assert, resp: res, label: 'KV-served slow tier' });
    assert.equal(res.headers.get('Vary'), null);
  } finally { restore(); }
});

test('no-Origin callers (curl, server-side, RUM beacons) are served the public shape from KV', async () => {
  const restore = installFetch();
  try {
    const anon = new Request(FAST_URL, { method: 'GET' });
    const res = await worker.fetch(anon, makeEnv({ serve: 'all', kvValue: envelopeFor('fast') }), makeCtx().ctx);
    assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), 'kv');
    assertPublicBootstrapCorsHeaders({ assert, resp: res, label: 'no-Origin KV serve' });
    assert.equal(res.headers.get('Vary'), null);
  } finally { restore(); }
});

test('the KV-served tier stays browser-no-store — the POP-local KV read is the cache', async () => {
  // Pinned so it reads as a decision rather than an omission. Rationale:
  // src/kv-serve.js#serveFromKv.
  const restore = installFetch();
  try {
    const res = await worker.fetch(req(FAST_URL), makeEnv({ serve: 'all', kvValue: envelopeFor('fast') }), makeCtx().ctx);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('CDN-Cache-Control'), null);
  } finally { restore(); }
});

test('serve=off (kill-switch): public-tier GET falls through to origin unchanged', async () => {
  const restore = installFetch();
  try {
    const res = await worker.fetch(req(FAST_URL), makeEnv({ serve: 'off', kvValue: envelopeFor('fast') }), makeCtx().ctx);
    assert.equal(res.headers.get('X-Origin'), 'vercel', 'reached origin');
    assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), null);
    // The kill-switch changes which path answers, never the contract it answers with.
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
  } finally { restore(); }
});

test('serve=slow: slow tier served from KV, fast tier falls through to origin', async () => {
  const restore = installFetch();
  try {
    const env = makeEnv({ serve: 'slow', get: async (tier) => envelopeFor(tier) });
    const slow = await worker.fetch(req(SLOW_URL), env, makeCtx().ctx);
    assert.equal(slow.headers.get('X-WorldMonitor-Bootstrap-Source'), 'kv');
    assert.deepEqual(JSON.parse(await slow.text()), payloadFor('slow'));
    const fast = await worker.fetch(req(FAST_URL), env, makeCtx().ctx);
    assert.equal(fast.headers.get('X-Origin'), 'vercel', 'fast not served under serve=slow');
    assert.equal(fast.headers.get('X-WorldMonitor-Bootstrap-Source'), null);
  } finally { restore(); }
});

test('every KV failure mode falls through to origin (never a served 5xx)', async () => {
  const cases = [
    ['miss', async () => null],
    ['invalid', async () => '{not json'],
    ['wrong-tier', async () => JSON.stringify({ schemaVersion: BOOTSTRAP_TIER_ENVELOPE_SCHEMA_VERSION, tier: 'slow', generatedAt: Date.now(), payload: payloadFor('slow') })],
    ['legacy-unversioned', async () => JSON.stringify({ tier: 'fast', generatedAt: Date.now(), payload: payloadFor('fast') })],
    ['stale', async (tier) => envelopeFor(tier, TIER_MAX_AGE_MS.fast + 60_000)],
    ['read-error', async () => { throw new Error('kv down'); }],
  ];
  for (const [name, get] of cases) {
    const restore = installFetch();
    try {
      const res = await worker.fetch(req(FAST_URL), makeEnv({ serve: 'all', get }), makeCtx().ctx);
      assert.equal(res.status, 200, `${name}: still 200`);
      assert.equal(res.headers.get('X-Origin'), 'vercel', `${name}: reached origin`);
      assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), null, `${name}: not served from KV`);
      // Absolute, not a same-shape comparison: which path answered must not change the contract.
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', `${name}: public shape`);
      assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null, `${name}: no credentials`);
    } finally { restore(); }
  }
});

test('non-servable requests never serve from KV (predicate + method gating)', async () => {
  const restore = installFetch();
  try {
    const env = makeEnv({ serve: 'all', get: async (tier) => envelopeFor(tier) });
    for (const [url, method, why] of [
      [FAST_URL, 'POST', 'non-GET'],
      ['https://api.worldmonitor.app/api/bootstrap?tier=fast', 'GET', 'no public=1'],
      ['https://api.worldmonitor.app/api/bootstrap?tier=bogus&public=1', 'GET', 'unknown tier'],
      ['https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1&x=1', 'GET', 'extra param'],
      ['https://api.worldmonitor.app/api/health', 'GET', 'wrong path'],
    ]) {
      const res = await worker.fetch(req(url, method), env, makeCtx().ctx);
      assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), null, `${method} ${url} (${why})`);
      assert.equal(res.headers.get('Timing-Allow-Origin'), null, `${method} ${url} (${why}) does not gain KV TAO`);
    }
  } finally { restore(); }
});

test('missing KV binding falls through', async () => {
  const restore = installFetch();
  try {
    const res = await worker.fetch(req(FAST_URL), makeEnv({ serve: 'all', binding: false }), makeCtx().ctx);
    assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), null);
    assert.equal(res.headers.get('X-Origin'), 'vercel');
  } finally { restore(); }
});

test('emits an allowlisted bootstrap_kv_serve event for served and fallback', async () => {
  // served
  let event;
  let restore = installFetch((body) => { event = body[0]; });
  try {
    const { ctx, waits } = makeCtx();
    await worker.fetch(req(FAST_URL), makeEnv({ serve: 'all', get: async (tier) => envelopeFor(tier) }), ctx);
    await Promise.all(waits);
    assert.equal(event.event_type, 'bootstrap_kv_serve');
    assert.equal(event.bootstrap_tier, 'fast');
    assert.equal(event.kv_outcome, 'served');
    assert.equal(event.kv_reason, null);
    assert.equal(typeof event.kv_duration_ms, 'number');
    // Privacy: EXACTLY the allowlist (+ _time). No ip/user_agent/customer_id/header field can appear.
    assert.deepEqual(
      Object.keys(event).sort(),
      ['_time', 'bootstrap_tier', 'cf_colo', 'cf_country', 'event_type', 'kv_duration_ms', 'kv_outcome', 'kv_reason'].sort(),
    );
  } finally { restore(); }
  // fallback (miss)
  restore = installFetch((body) => { event = body[0]; });
  try {
    const { ctx, waits } = makeCtx();
    await worker.fetch(req(FAST_URL), makeEnv({ serve: 'all', get: async () => null }), ctx);
    await Promise.all(waits);
    assert.equal(event.kv_outcome, 'fallback');
    assert.equal(event.kv_reason, 'miss');
  } finally { restore(); }
});

test('a fast KV read is served without ever enlisting origin (no hedge)', async () => {
  let originCalls = 0;
  const restore = installFetch(undefined, () => { originCalls += 1; });
  try {
    const env = makeEnv({ serve: 'all', get: async (tier) => envelopeFor(tier) });
    const { ctx, waits } = makeCtx();
    const res = await worker.fetch(req(FAST_URL), env, ctx);
    assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), 'kv');
    assert.equal(originCalls, 0, 'KV won inside the hedge window; origin never fetched');
    await Promise.all(waits);
  } finally { restore(); }
});

test('a hung KV read hedges to origin after the delay and records reason=hedged', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let event;
  let originCalls = 0;
  const restore = installFetch((body) => { event = body[0]; }, () => { originCalls += 1; });
  try {
    const env = makeEnv({ serve: 'all', get: () => new Promise(() => {}) }); // never resolves
    const { ctx, waits } = makeCtx();
    const pending = worker.fetch(req(FAST_URL), env, ctx);
    t.mock.timers.tick(501); // fire the hedge; origin (immediate) wins the race vs the hung read
    const res = await pending;
    assert.equal(res.headers.get('X-Origin'), 'vercel', 'hedge falls back to origin');
    assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), null, 'not served from the hung KV');
    assert.equal(originCalls, 1, 'origin enlisted exactly once, at the hedge boundary');
    // The header shape must not depend on which side won the race (#7308).
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
    await Promise.all(waits);
    assert.equal(event.kv_outcome, 'fallback');
    assert.equal(event.kv_reason, 'hedged');
  } finally { restore(); }
});

test('a slow-but-valid KV read still wins the hedge race and is served (not abandoned)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let event;
  let originCalls = 0;
  // KV answers at 600ms (past the 500ms hedge, under the 1200ms budget); origin, once enlisted, is
  // slower (400ms). The point of the hedge: this read is SERVED, where a hard timeout would drop it.
  const restore = installFetch((body) => { event = body[0]; }, () => { originCalls += 1; }, { originDelayMs: 400 });
  try {
    const env = makeEnv({ serve: 'all', get: slowGet(600) });
    const { ctx, waits } = makeCtx();
    const pending = worker.fetch(req(FAST_URL), env, ctx);
    t.mock.timers.tick(500); // hedge fires -> origin enlisted (will resolve at 900ms)
    t.mock.timers.tick(100); // t=600 -> KV resolves first, wins the race
    const res = await pending;
    assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), 'kv', 'slow-but-valid KV is served');
    assert.deepEqual(JSON.parse(await res.text()), payloadFor('fast'));
    assert.equal(originCalls, 1, 'origin was enlisted by the hedge but lost the race');
    await Promise.all(waits);
    assert.equal(event.kv_outcome, 'served');
  } finally { restore(); }
});

test('a served tier skips the redundant shadow read during cutover', async () => {
  let reads = 0;
  const events = [];
  const restore = installFetch((body) => { events.push(body[0]); });
  try {
    const env = makeEnv({
      serve: 'all',
      shadow: '1',
      get: async (tier) => {
        reads += 1;
        return envelopeFor(tier);
      },
    });
    const { ctx, waits } = makeCtx();
    const res = await worker.fetch(req(FAST_URL), env, ctx);
    assert.equal(res.headers.get('X-WorldMonitor-Bootstrap-Source'), 'kv');
    await Promise.all(waits);
    assert.equal(reads, 1, 'serve telemetry replaces the same-tier shadow read');
    assert.deepEqual(events.map((event) => event.event_type), ['bootstrap_kv_serve']);
  } finally { restore(); }
});

test('wrangler.toml stage 2 serves both public tiers from KV', () => {
  const toml = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /^BOOTSTRAP_KV_SERVE = "all"$/m, 'fast-tier cutover (#7291) must stay deployed');
  assert.match(toml, /^BOOTSTRAP_KV_SHADOW = "1"$/m, 'keep the shadow baseline until stage 3');
});

test('serve=slow keeps the unserved fast tier on the shadow path', async () => {
  let reads = 0;
  const events = [];
  const restore = installFetch((body) => { events.push(body[0]); });
  try {
    const env = makeEnv({
      serve: 'slow',
      shadow: '1',
      get: async (tier) => {
        reads += 1;
        return envelopeFor(tier);
      },
    });
    const { ctx, waits } = makeCtx();
    const res = await worker.fetch(req(FAST_URL), env, ctx);
    assert.equal(res.headers.get('X-Origin'), 'vercel');
    await Promise.all(waits);
    assert.equal(reads, 1, 'fast remains shadowed until it is served');
    assert.deepEqual(events.map((event) => event.event_type), ['bootstrap_kv_shadow']);
  } finally { restore(); }
});
