// #6845 — a run killed before `atomicSwitch` wrote `military:bases:{geo,meta}:<version>`
// with no TTL, and nothing ever swept it: `cleanupOldVersion` only names the keys
// of the version that is *currently active*, so a version that never published
// (or was superseded by a run killed inside the grace window) leaked up to a
// 125,380-member zset plus a 125,380-field hash, permanently.
//
// The fix has three halves, each pinned here:
//   1. seeding arms a self-healing TTL on every batch — alive runs keep
//      refreshing it, dead runs stop;
//   2. `atomicSwitch` PERSISTs the version's keys inside the same EVAL that
//      publishes, so a live version can never expire and an unpublished one
//      always can;
//   3. the superseded version's keys get a short TTL right after the switch
//      (never before — until the switch lands they ARE the live data), and a
//      start-of-run sweep re-arms TTLs on keys leaked by pre-TTL runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRACE_PERIOD_MS,
  VERSION_KEY_TTL_SECONDS,
  SUPERSEDED_KEY_TTL_SECONDS,
  atomicSwitch,
  armSupersededCleanup,
  seedGeo,
  seedMeta,
  sweepLeakedVersionKeys,
} from '../scripts/seed-military-bases.mjs';

const URL_BASE = 'https://redis.test';
const TOKEN = 'test-token-0000';
const VERSION = '1786244633231';
const RECORDS = 125_380;

function stubRedis(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const path = String(url).slice(URL_BASE.length);
    const body = JSON.parse(options.body);
    calls.push({ path, body });
    return {
      ok: true,
      json: async () => handler(path, body),
      text: async () => '',
    };
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

const pipelineOk = (path, body) =>
  path === '/pipeline'
    ? body.map(() => ({ result: 1 }))
    : { result: null };

test('the TTL constants bracket the windows they exist to protect', () => {
  assert.ok(
    VERSION_KEY_TTL_SECONDS >= 10 * 60,
    `VERSION_KEY_TTL_SECONDS is ${VERSION_KEY_TTL_SECONDS}s — it must comfortably outlive the `
      + 'section slot (540s timeout + 10s kill grace + R2-cold download) or a slow-but-alive '
      + 'run expires its own data mid-seed',
  );
  assert.ok(
    SUPERSEDED_KEY_TTL_SECONDS >= 2 * (GRACE_PERIOD_MS / 1000),
    `SUPERSEDED_KEY_TTL_SECONDS is ${SUPERSEDED_KEY_TTL_SECONDS}s — it must exceed the `
      + `${GRACE_PERIOD_MS / 1000}s reader grace it exists to protect, with margin for the `
      + 'EXPIRE-to-reap delay',
  );
});

test('seedGeo arms and refreshes the self-healing TTL on every batch', async () => {
  const entries = Array.from({ length: 1001 }, (_, i) => ({
    id: `base-${i}`,
    lat: 1 + i / 1e6,
    lon: 2 + i / 1e6,
  }));
  const stub = stubRedis(pipelineOk);
  try {
    const seeded = await seedGeo(URL_BASE, TOKEN, 'military:bases:geo:V', entries);
    assert.equal(seeded, 1001);
  } finally {
    stub.restore();
  }

  const batches = stub.calls.filter(c => c.path === '/pipeline');
  assert.equal(batches.length, 3, '1001 entries at BATCH_SIZE 500 must pipeline 3 times');
  for (const [i, batch] of batches.entries()) {
    const expire = batch.body.at(-1);
    assert.equal(
      expire[0], 'EXPIRE',
      `batch ${i + 1} must close by arming the TTL — piggybacked here so it arms from the `
        + 'first GEOADD (EXPIRE on a missing key is a no-op) and refreshes while alive',
    );
    assert.equal(expire[1], 'military:bases:geo:V');
    assert.equal(expire[2], String(VERSION_KEY_TTL_SECONDS));
  }
});

test('seedMeta arms and refreshes the self-healing TTL on every batch', async () => {
  const entries = Array.from({ length: 501 }, (_, i) => ({
    id: `base-${i}`,
    name: `Base ${i}`,
  }));
  const stub = stubRedis(pipelineOk);
  try {
    const seeded = await seedMeta(URL_BASE, TOKEN, 'military:bases:meta:V', entries);
    assert.equal(seeded, 501);
  } finally {
    stub.restore();
  }

  const batches = stub.calls.filter(c => c.path === '/pipeline');
  assert.equal(batches.length, 2);
  for (const [i, batch] of batches.entries()) {
    assert.equal(batch.body.at(-1)[0], 'EXPIRE', `batch ${i + 1} must close by arming the TTL`);
    assert.equal(batch.body.at(-1)[1], 'military:bases:meta:V');
  }
});

test('atomicSwitch PERSISTs the version keys inside the publish EVAL', async () => {
  const stub = stubRedis(() => ({ result: VERSION }));
  try {
    await atomicSwitch(URL_BASE, TOKEN, '', VERSION, RECORDS, Number(VERSION), 214_000);
  } finally {
    stub.restore();
  }

  const evalCall = stub.calls.find(c => Array.isArray(c.body) && c.body[0] === 'EVAL');
  assert.ok(evalCall, 'atomicSwitch must publish through the EVAL script');
  const [op, script, numkeys, activeKey, seedMetaKey, geoKey, metaKey, published, payload] = evalCall.body;
  assert.equal(op, 'EVAL');
  assert.match(script, /redis\.call\('PERSIST', KEYS\[3\]/, 'the GEO key must be persisted');
  assert.match(script, /redis\.call\('PERSIST', KEYS\[4\]/, 'the META key must be persisted');
  assert.equal(numkeys, '4');
  assert.equal(activeKey, 'military:bases:active');
  assert.equal(seedMetaKey, 'seed-meta:military:bases');
  assert.equal(geoKey, `military:bases:geo:${VERSION}`);
  assert.equal(metaKey, `military:bases:meta:${VERSION}`);
  assert.equal(published, VERSION);
  assert.equal(JSON.parse(payload).recordCount, RECORDS);
});

test('armSupersededCleanup EXPIREs both old keys for the superseded window', async () => {
  const stub = stubRedis(pipelineOk);
  const oldInfo = {
    oldVersion: '1786000000000',
    oldGeoKey: 'military:bases:geo:1786000000000',
    oldMetaKey: 'military:bases:meta:1786000000000',
  };
  try {
    await armSupersededCleanup(URL_BASE, TOKEN, oldInfo);
  } finally {
    stub.restore();
  }

  const expires = stub.calls
    .flatMap(c => (c.path === '/pipeline' ? c.body : []))
    .filter(row => row[0] === 'EXPIRE');
  assert.deepEqual(
    expires,
    [
      ['EXPIRE', oldInfo.oldGeoKey, String(SUPERSEDED_KEY_TTL_SECONDS)],
      ['EXPIRE', oldInfo.oldMetaKey, String(SUPERSEDED_KEY_TTL_SECONDS)],
    ],
  );
});

test('the sweep re-arms TTLs only on no-TTL, non-active version keys', async () => {
  const active = '1786244633231';
  const leaked = { geo: 'military:bases:geo:1786000000000', meta: 'military:bases:meta:1786000000000' };
  const ttlArmed = { geo: 'military:bases:geo:1786100000000', meta: 'military:bases:meta:1786100000000' };
  const activeKeys = { geo: `military:bases:geo:${active}`, meta: `military:bases:meta:${active}` };

  const scanPages = {
    geo: ['0', [leaked.geo, ttlArmed.geo, activeKeys.geo]],
    meta: ['0', [leaked.meta, ttlArmed.meta, activeKeys.meta]],
  };
  const ttlProbed = [];
  const stub = stubRedis((path, body) => {
    const [cmd, key] = body;
    if (path === '/' && cmd === 'GET' && String(key).endsWith('military:bases:active')) {
      return { result: active };
    }
    if (path === '/' && cmd === 'SCAN') {
      const pattern = body[3];
      return { result: scanPages[pattern.includes(':geo:') ? 'geo' : 'meta'] };
    }
    if (path === '/' && cmd === 'TTL') {
      ttlProbed.push(String(key));
      return { result: String(key) === leaked.geo || String(key) === leaked.meta ? -1 : 480 };
    }
    return pipelineOk(path, body);
  });
  try {
    await sweepLeakedVersionKeys(URL_BASE, TOKEN, '');
  } finally {
    stub.restore();
  }

  // The active version's keys are excluded by name, before any TTL probe.
  assert.ok(!ttlProbed.includes(activeKeys.geo));
  assert.ok(!ttlProbed.includes(activeKeys.meta));

  const expires = stub.calls
    .flatMap(c => (c.path === '/pipeline' ? c.body : []))
    .filter(row => row[0] === 'EXPIRE');
  assert.deepEqual(
    expires.sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    [
      ['EXPIRE', leaked.geo, String(SUPERSEDED_KEY_TTL_SECONDS)],
      ['EXPIRE', leaked.meta, String(SUPERSEDED_KEY_TTL_SECONDS)],
    ],
    'only the no-TTL non-active keys are re-armed — TTL-armed keys belong to a live run, '
      + 'and the sweep must never DEL directly, only let Redis reap',
  );
});
