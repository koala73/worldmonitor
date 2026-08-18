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
//   3. the publish EVAL arms the superseded version's keys and a per-key sweep
//      EVAL re-arms TTLs on keys leaked by pre-TTL runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRACE_PERIOD_MS,
  VERSION_KEY_TTL_SECONDS,
  SUPERSEDED_KEY_TTL_SECONDS,
  atomicSwitch,
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
    const [op, script, keyCount, activeKey, versionKey, candidateVersion, ttl] = batch.body.at(-1);
    assert.equal(op, 'EVAL', `batch ${i + 1} must close with an atomic staging-TTL guard`);
    assert.match(script, /local active = redis\.call\('GET', KEYS\[1\]\)/);
    assert.match(script, /active == ARGV\[1\]/);
    assert.match(script, /redis\.call\('EXPIRE', KEYS\[2\], ARGV\[2\]\)/);
    assert.equal(keyCount, '2');
    assert.equal(activeKey, 'military:bases:active');
    assert.equal(versionKey, 'military:bases:geo:V');
    assert.equal(candidateVersion, 'V');
    assert.equal(ttl, String(VERSION_KEY_TTL_SECONDS));
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
    const [op, script, keyCount, activeKey, versionKey, candidateVersion, ttl] = batch.body.at(-1);
    assert.equal(op, 'EVAL', `batch ${i + 1} must close with an atomic staging-TTL guard`);
    assert.match(script, /active == ARGV\[1\]/);
    assert.equal(keyCount, '2');
    assert.equal(activeKey, 'military:bases:active');
    assert.equal(versionKey, 'military:bases:meta:V');
    assert.equal(candidateVersion, 'V');
    assert.equal(ttl, String(VERSION_KEY_TTL_SECONDS));
  }
});

test('same-version overlap cannot re-arm active GEO or META keys after publish', async () => {
  const candidateVersion = '1786244633231';
  const cases = [
    {
      kind: 'geo',
      key: `preview:sha:military:bases:geo:${candidateVersion}`,
      entries: Array.from({ length: 501 }, (_, i) => ({
        id: `base-${i}`,
        lat: 1 + i / 1e6,
        lon: 2 + i / 1e6,
      })),
      seed: seedGeo,
    },
    {
      kind: 'meta',
      key: `preview:sha:military:bases:meta:${candidateVersion}`,
      entries: Array.from({ length: 501 }, (_, i) => ({ id: `base-${i}`, name: `Base ${i}` })),
      seed: seedMeta,
    },
  ];

  for (const { kind, key, entries, seed } of cases) {
    let active = '1786000000000';
    let ttl = null;
    let pipelineNumber = 0;
    const guardResults = [];
    const stub = stubRedis((path, body) => {
      assert.equal(path, '/pipeline');
      pipelineNumber++;
      const results = body.map(command => {
        if (command[0] === 'EXPIRE') {
          ttl = Number(command[2]);
          return { result: 1 };
        }
        if (command[0] !== 'EVAL') return { result: 1 };

        const [, , , activeKey, versionKey, version, requestedTtl] = command;
        assert.equal(activeKey, 'preview:sha:military:bases:active');
        assert.equal(versionKey, key);
        assert.equal(version, candidateVersion);
        if (active === version) {
          guardResults.push(0);
          return { result: 0 };
        }
        ttl = Number(requestedTtl);
        guardResults.push(1);
        return { result: 1 };
      });

      if (pipelineNumber === 1) {
        // The other same-millisecond run publishes between our batches. Its
        // EVAL PERSISTs this shared key before making the version active.
        ttl = null;
        active = candidateVersion;
      }
      return results;
    });
    try {
      await seed(URL_BASE, TOKEN, key, entries);
    } finally {
      stub.restore();
    }

    assert.deepEqual(guardResults, [1, 0], `${kind} must skip the TTL after the shared version is active`);
    assert.equal(ttl, null, `${kind} must remain persistent after the other run publishes it`);
    assert.equal(
      stub.calls.flatMap(({ body }) => body).some(command => command[0] === 'EXPIRE'),
      false,
      `${kind} must not use an unconditional staging EXPIRE`,
    );
  }
});

test('atomicSwitch persists the new pair and arms the exact displaced pair in one EVAL', async () => {
  const oldVersion = '1786000000000';
  const stub = stubRedis(() => ({ result: [1, VERSION, oldVersion] }));
  let superseded;
  try {
    superseded = await atomicSwitch(
      URL_BASE,
      TOKEN,
      '',
      VERSION,
      RECORDS,
      Number(VERSION),
      214_000,
      oldVersion,
    );
  } finally {
    stub.restore();
  }

  const evalCall = stub.calls.find(c => Array.isArray(c.body) && c.body[0] === 'EVAL');
  assert.ok(evalCall, 'atomicSwitch must publish through the EVAL script');
  const [
    op,
    script,
    numkeys,
    activeKey,
    seedMetaKey,
    geoKey,
    metaKey,
    oldGeoKey,
    oldMetaKey,
    published,
    payload,
    expectedActive,
    cleanupTtl,
  ] = evalCall.body;
  assert.equal(op, 'EVAL');
  assert.match(script, /local current = redis\.call\('GET', KEYS\[1\]\)/);
  assert.match(script, /\(current or ''\) ~= ARGV\[3\]/, 'publish must reject a stale active snapshot');
  assert.match(script, /redis\.call\('PERSIST', KEYS\[3\]/, 'the GEO key must be persisted');
  assert.match(script, /redis\.call\('PERSIST', KEYS\[4\]/, 'the META key must be persisted');
  assert.match(script, /redis\.call\('EXPIRE', KEYS\[5\], ARGV\[4\]\)/);
  assert.match(script, /redis\.call\('EXPIRE', KEYS\[6\], ARGV\[4\]\)/);
  assert.equal(numkeys, '6');
  assert.equal(activeKey, 'military:bases:active');
  assert.equal(seedMetaKey, 'seed-meta:military:bases');
  assert.equal(geoKey, `military:bases:geo:${VERSION}`);
  assert.equal(metaKey, `military:bases:meta:${VERSION}`);
  assert.equal(oldGeoKey, `military:bases:geo:${oldVersion}`);
  assert.equal(oldMetaKey, `military:bases:meta:${oldVersion}`);
  assert.equal(published, VERSION);
  assert.equal(JSON.parse(payload).recordCount, RECORDS);
  assert.equal(expectedActive, oldVersion);
  assert.equal(cleanupTtl, String(SUPERSEDED_KEY_TTL_SECONDS));
  assert.deepEqual(superseded, { oldVersion, oldGeoKey, oldMetaKey });
  assert.equal(stub.calls.length, 1, 'there must be no post-publish cleanup-arm request to lose on kill');
});

test('atomicSwitch fails closed on a malformed Redis script response', async () => {
  const stub = stubRedis(() => ({ result: VERSION }));
  try {
    await assert.rejects(
      atomicSwitch(URL_BASE, TOKEN, '', VERSION, RECORDS),
      /Atomic switch returned an unexpected response/,
    );
  } finally {
    stub.restore();
  }
});

test('atomicSwitch fails closed when Redis reports a different displaced version', async () => {
  const oldVersion = '1786000000000';
  const stub = stubRedis(() => ({ result: [1, VERSION, '1785999999999'] }));
  try {
    await assert.rejects(
      atomicSwitch(URL_BASE, TOKEN, '', VERSION, RECORDS, Date.now(), undefined, oldVersion),
      /Atomic switch returned unexpected displaced version/,
    );
  } finally {
    stub.restore();
  }
});

test('the sweep makes the active check, TTL check, and EXPIRE atomic per candidate', async () => {
  const active = '1786244633231';
  const leaked = { geo: 'military:bases:geo:1786000000000', meta: 'military:bases:meta:1786000000000' };
  const ttlArmed = { geo: 'military:bases:geo:1786100000000', meta: 'military:bases:meta:1786100000000' };
  const activeKeys = { geo: `military:bases:geo:${active}`, meta: `military:bases:meta:${active}` };

  const scanPages = {
    geo: ['0', [leaked.geo, ttlArmed.geo, activeKeys.geo]],
    meta: ['0', [leaked.meta, ttlArmed.meta, activeKeys.meta]],
  };
  const evaluated = [];
  const stub = stubRedis((path, body) => {
    const [cmd] = body;
    if (path === '/' && cmd === 'SCAN') {
      const pattern = body[3];
      return { result: scanPages[pattern.includes(':geo:') ? 'geo' : 'meta'] };
    }
    if (path === '/' && cmd === 'EVAL') {
      const [, script, keyCount, activeKey, candidateKey, candidateVersion, ttl] = body;
      evaluated.push(candidateKey);
      assert.equal(keyCount, '2');
      assert.equal(activeKey, 'military:bases:active');
      assert.equal(candidateVersion, candidateKey.split(':').at(-1));
      assert.equal(ttl, String(SUPERSEDED_KEY_TTL_SECONDS));
      assert.match(script, /local active = redis\.call\('GET', KEYS\[1\]\)/);
      assert.match(script, /local ttl = redis\.call\('TTL', KEYS\[2\]\)/);
      assert.match(script, /redis\.call\('EXPIRE', KEYS\[2\], ARGV\[2\]\)/);
      if (candidateVersion === active) return { result: [0, 'active', active] };
      if (candidateKey === ttlArmed.geo || candidateKey === ttlArmed.meta) {
        return { result: [0, 'ttl', '480'] };
      }
      return { result: [1, 'armed', active] };
    }
    return pipelineOk(path, body);
  });
  try {
    await sweepLeakedVersionKeys(URL_BASE, TOKEN, '');
  } finally {
    stub.restore();
  }

  assert.deepEqual(
    evaluated.sort(),
    [
      activeKeys.geo,
      activeKeys.meta,
      leaked.geo,
      leaked.meta,
      ttlArmed.geo,
      ttlArmed.meta,
    ].sort(),
  );
  assert.equal(
    stub.calls.some(({ body }) => ['GET', 'TTL', 'EXPIRE'].includes(body[0])),
    false,
    'the sweeper must not split the active/TTL decision across client requests',
  );
});

test('a concurrent publish makes the sweep skip the candidate that just became active', async () => {
  const candidateVersion = '1786000000000';
  const candidateKey = `military:bases:geo:${candidateVersion}`;
  let active = VERSION;
  const stub = stubRedis((path, body) => {
    if (path === '/' && body[0] === 'SCAN') return { result: ['0', [candidateKey]] };
    if (path === '/' && body[0] === 'EVAL') {
      active = candidateVersion;
      const candidate = body.at(-2);
      return { result: active === candidate ? [0, 'active', active] : [1, 'armed', active] };
    }
    return { result: null };
  });
  try {
    await sweepLeakedVersionKeys(URL_BASE, TOKEN, '');
  } finally {
    stub.restore();
  }

  const evalCall = stub.calls.find(({ body }) => body[0] === 'EVAL');
  assert.ok(evalCall);
  assert.equal(evalCall.body.at(-2), candidateVersion);
  assert.equal(
    stub.calls.some(({ body }) => body[0] === 'EXPIRE'),
    false,
    'the active candidate must not be expired by a stale client-side snapshot',
  );
});

test('overlapping publishers arm each exact displaced pair and reject stale completion', async () => {
  const first = '1786100000000';
  const second = '1786200000000';
  const stale = '1786050000000';
  let active = '1786000000000';
  const ttlByKey = new Map();
  for (const version of [first, second, stale]) {
    ttlByKey.set(`military:bases:geo:${version}`, VERSION_KEY_TTL_SECONDS);
    ttlByKey.set(`military:bases:meta:${version}`, VERSION_KEY_TTL_SECONDS);
  }

  const stub = stubRedis((path, body) => {
    if (path !== '/' || body[0] !== 'EVAL') return pipelineOk(path, body);
    const keyCount = Number(body[2]);
    const keys = body.slice(3, 3 + keyCount);
    const [published, , expected, cleanupTtl] = body.slice(3 + keyCount);
    if (active !== expected) return { result: [0, active] };

    ttlByKey.delete(keys[2]);
    ttlByKey.delete(keys[3]);
    if (active) {
      ttlByKey.set(keys[4], Number(cleanupTtl));
      ttlByKey.set(keys[5], Number(cleanupTtl));
    }
    const displaced = active;
    active = published;
    return { result: [1, published, displaced] };
  });

  try {
    const firstResult = await atomicSwitch(
      URL_BASE, TOKEN, '', first, RECORDS, Number(first), undefined, active,
    );
    const secondResult = await atomicSwitch(
      URL_BASE, TOKEN, '', second, RECORDS, Number(second), undefined, first,
    );
    assert.equal(firstResult.oldVersion, '1786000000000');
    assert.equal(secondResult.oldVersion, first);
    assert.equal(active, second);
    for (const version of ['1786000000000', first]) {
      assert.equal(ttlByKey.get(`military:bases:geo:${version}`), SUPERSEDED_KEY_TTL_SECONDS);
      assert.equal(ttlByKey.get(`military:bases:meta:${version}`), SUPERSEDED_KEY_TTL_SECONDS);
    }
    assert.equal(ttlByKey.has(`military:bases:geo:${second}`), false);
    assert.equal(ttlByKey.has(`military:bases:meta:${second}`), false);

    await assert.rejects(
      atomicSwitch(URL_BASE, TOKEN, '', stale, RECORDS, Number(stale), undefined, '1786000000000'),
      new RegExp(`Active version changed before publish \\(1786000000000 -> ${second}\\)`),
    );
    assert.equal(active, second, 'a stale publisher must not replace the newer active version');
    assert.equal(ttlByKey.get(`military:bases:geo:${stale}`), VERSION_KEY_TTL_SECONDS);
    assert.equal(ttlByKey.get(`military:bases:meta:${stale}`), VERSION_KEY_TTL_SECONDS);
  } finally {
    stub.restore();
  }
});
