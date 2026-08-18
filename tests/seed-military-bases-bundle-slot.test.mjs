// #6806 — `seed-bundle-static-ref`'s budget could not satisfy its own section
// list, and `Military-Bases` was the section that made the starvation
// structural: it reserved 550s of worst case (540s timeout + 10s kill grace)
// against a 570s bundle budget, so with the runner's 15s admission headroom it
// needed 565s of 570s and was admissible only while `elapsed <= 5s`. The five
// freshness reads ahead of it routinely burn more than that.
//
// The reservation was not the seeder's real work. `main()` published via
// `atomicSwitch` and then slept a hardcoded GRACE_PERIOD_MS before deleting the
// superseded version's keys — 300s of the 540s reservation spent idle, after
// the data was already live.
//
// Two properties are pinned here:
//   1. the post-publish wait cannot grow back into a whole-budget reservation;
//   2. a missing `seed-meta:military:bases` self-heals cheaply. That key is the
//      section's ONLY freshness signal (it declares no `canonicalKey`), so when
//      it is absent the runner treats the section as never-seeded and marks it
//      due on every daily tick instead of every 30 days — a permanently-due
//      whole-budget section is what actually starves the bundle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRACE_PERIOD_MS,
  atomicSwitch,
  backfillSeedMetaFromActiveVersion,
  maybeRepairMissingSeedMeta,
  parseArgs,
} from '../scripts/seed-military-bases.mjs';

const URL_BASE = 'https://redis.test';
const TOKEN = 'test-token-0000';
const VERSION = '1786244633231';
const RECORDS = 125_380;

/**
 * Stub Upstash REST. `handler(path, body)` returns the parsed JSON body the
 * seeder should see; every call is recorded so a test can assert on call COUNT,
 * which is what separates a cheap repair from a full 251-window revalidation.
 */
function stubRedis(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const path = String(url).slice(URL_BASE.length);
    const body = JSON.parse(options.body);
    calls.push({ path, body });
    return {
      ok: true,
      json: async () => handler(path, body, calls.length),
      text: async () => '',
    };
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

test('the post-publish grace cannot grow back into a whole-budget reservation', () => {
  // The bundle slot must be dominated by real work, not by an idle wait that
  // runs AFTER `atomicSwitch` has already made the data live. At 300_000 this
  // was 55% of the section's 540s reservation and the direct cause of #6806.
  assert.ok(
    GRACE_PERIOD_MS <= 60_000,
    `GRACE_PERIOD_MS is ${GRACE_PERIOD_MS}ms — a post-publish sleep this long is charged to the `
    + 'bundle slot even though the data is already published, which is what made Military-Bases '
    + 'a whole-budget section in #6806.',
  );
  assert.ok(GRACE_PERIOD_MS > 0, 'some grace must remain so in-flight readers are not cut off');
});

test('parseArgs recognizes --force forms', () => {
  // CLI contract only — the main-gate bypass is covered by
  // maybeRepairMissingSeedMeta({ force: true }) below.
  const argv = process.argv;
  try {
    process.argv = ['node', 'seed-military-bases.mjs'];
    assert.equal(parseArgs().force, false, 'reseed must not be forced by default');

    process.argv = ['node', 'seed-military-bases.mjs', '--force'];
    assert.equal(parseArgs().force, true);

    process.argv = ['node', 'seed-military-bases.mjs', '--env', 'preview', '--force'];
    const parsed = parseArgs();
    assert.equal(parsed.force, true, '--force must survive alongside other flags');
    assert.equal(parsed.env, 'preview');

    // `--env=`/`--sha=` accept the `=` form, so an operator who reaches for
    // `--force=1` out of habit must not silently get the repair path instead.
    for (const arg of ['--force=true', '--force=1', '--force=yes']) {
      process.argv = ['node', 'seed-military-bases.mjs', arg];
      assert.equal(parseArgs().force, true, `${arg} must force a reseed`);
    }
    for (const arg of ['--force=false', '--force=0', '--force=no']) {
      process.argv = ['node', 'seed-military-bases.mjs', arg];
      assert.equal(parseArgs().force, false, `${arg} must not force a reseed`);
    }
  } finally {
    process.argv = argv;
  }
});

test('atomicSwitch records the seeding duration so the next tick can be sized from a measurement', async () => {
  const stub = stubRedis(() => ({ result: [1, VERSION, ''] }));
  try {
    await atomicSwitch(URL_BASE, TOKEN, '', VERSION, RECORDS, Number(VERSION), 214_000);
  } finally {
    stub.restore();
  }

  const evalCall = stub.calls.find((c) => c.body[0] === 'EVAL');
  assert.ok(evalCall, 'atomicSwitch must publish through the EVAL script');
  const keyCount = Number(evalCall.body[2]);
  const payload = JSON.parse(evalCall.body[4 + keyCount]);
  assert.equal(payload.recordCount, RECORDS);
  assert.equal(
    payload.durationMs,
    214_000,
    'seed-meta must carry the measured seeding duration — Railway cron logs are not readable '
    + 'after the fact, so the published record is the only way to right-size this section\'s timeout',
  );
});

test('a missing seed-meta is repaired without a full revalidation of every record', async () => {
  // The repair path exists because the section is permanently due while
  // seed-meta is absent. If repairing costs a 251-window scan it cannot run
  // inside the shrunken slot, and the permanently-due loop survives its own fix.
  const stub = stubRedis((path, body) => {
    if (path === '/pipeline') {
      return body.map(([cmd]) => {
        if (cmd === 'GET') return { result: VERSION };
        if (cmd === 'ZCARD' || cmd === 'HLEN') return { result: RECORDS };
        if (cmd === 'ZRANGE') return { result: [] };
        return { result: null };
      });
    }
    return { result: [1, VERSION] };
  });

  let repaired;
  try {
    repaired = await backfillSeedMetaFromActiveVersion(URL_BASE, TOKEN, '', { deep: false });
  } finally {
    stub.restore();
  }

  assert.equal(repaired.version, VERSION);
  assert.equal(repaired.recordCount, RECORDS);

  const payload = seedMetaWritePayload(stub.calls);
  assert.equal(payload.sourceVersion, VERSION);
  assert.equal(payload.recordCount, RECORDS);
  assert.equal(payload.fetchedAt, Number(VERSION));

  const zrangeCalls = stub.calls.filter(
    (c) => c.path === '/pipeline' && c.body.some(([cmd]) => cmd === 'ZRANGE'),
  );
  assert.equal(
    zrangeCalls.length,
    0,
    'a shallow repair must confirm ZCARD/HLEN agreement only — walking all '
    + `${RECORDS} members costs ~250 round trips and would not fit the section's slot`,
  );
  assert.ok(
    stub.calls.length <= 4,
    `shallow repair issued ${stub.calls.length} Redis calls; it must stay a handful`,
  );
});

function seedMetaWritePayload(calls) {
  const evalCall = calls.find((c) => Array.isArray(c.body) && c.body[0] === 'EVAL');
  assert.ok(evalCall, 'repair must write seed-meta through EVAL');
  return JSON.parse(evalCall.body.at(-1));
}

function militaryRedisHandler({
  seedMeta = null,
  active = VERSION,
  geoCount = RECORDS,
  metaCount = RECORDS,
  evalResult = [1, VERSION],
} = {}) {
  return (path, body) => {
    if (path === '/') {
      const [cmd, key] = body;
      if (cmd === 'GET' && String(key).endsWith('seed-meta:military:bases')) {
        return { result: seedMeta };
      }
      if (cmd === 'GET' && String(key).endsWith('military:bases:active')) {
        return { result: active };
      }
      if (cmd === 'EVAL') return { result: evalResult };
      return { result: null };
    }
    if (path === '/pipeline') {
      return body.map(([cmd]) => {
        if (cmd === 'GET') return { result: active };
        if (cmd === 'ZCARD') return { result: geoCount };
        if (cmd === 'HLEN') return { result: metaCount };
        return { result: null };
      });
    }
    return { result: null };
  };
}

test('missing seed-meta with a live active version repairs cheaply and stops', async () => {
  const stub = stubRedis(militaryRedisHandler());
  let result;
  try {
    result = await maybeRepairMissingSeedMeta(URL_BASE, TOKEN, '', { force: false });
  } finally {
    stub.restore();
  }

  assert.equal(result.action, 'repaired');
  assert.equal(result.version, VERSION);
  assert.equal(result.recordCount, RECORDS);

  const geoAdds = stub.calls.filter(
    (c) => Array.isArray(c.body) && (c.body[0] === 'GEOADD' || c.body.some?.((row) => row?.[0] === 'GEOADD')),
  );
  assert.equal(geoAdds.length, 0, 'repair must not enter the GEOADD reseed path');

  const payload = seedMetaWritePayload(stub.calls);
  assert.equal(payload.sourceVersion, VERSION);
  assert.equal(payload.recordCount, RECORDS);
  assert.equal(payload.fetchedAt, Number(VERSION));
});

test('--force skips the missing-marker repair so a manual reseed can proceed', async () => {
  const stub = stubRedis(() => {
    throw new Error('fetch must not run when force is set');
  });
  let result;
  try {
    result = await maybeRepairMissingSeedMeta(URL_BASE, TOKEN, '', { force: true });
  } finally {
    stub.restore();
  }
  assert.equal(result.action, 'skipped-force');
  assert.equal(stub.calls.length, 0);
});

test('present seed-meta skips repair', async () => {
  const stub = stubRedis(militaryRedisHandler({
    seedMeta: JSON.stringify({ fetchedAt: Number(VERSION), recordCount: RECORDS, sourceVersion: VERSION }),
  }));
  let result;
  try {
    result = await maybeRepairMissingSeedMeta(URL_BASE, TOKEN, '', { force: false });
  } finally {
    stub.restore();
  }
  assert.equal(result.action, 'skipped-present');
  assert.equal(
    stub.calls.filter((c) => Array.isArray(c.body) && c.body[0] === 'EVAL').length,
    0,
    'must not rewrite seed-meta when the marker is already present',
  );
});

test('missing seed-meta and no active version falls through to reseed', async () => {
  const stub = stubRedis(militaryRedisHandler({ active: null }));
  let result;
  try {
    result = await maybeRepairMissingSeedMeta(URL_BASE, TOKEN, '', { force: false });
  } finally {
    stub.restore();
  }
  assert.equal(result.action, 'fallthrough-no-active');
  assert.equal(
    stub.calls.filter((c) => Array.isArray(c.body) && c.body[0] === 'EVAL').length,
    0,
  );
});

test('a broken active corpus falls through to reseed instead of crashing the section', async () => {
  const stub = stubRedis(militaryRedisHandler({ geoCount: RECORDS, metaCount: 1 }));
  let result;
  try {
    result = await maybeRepairMissingSeedMeta(URL_BASE, TOKEN, '', { force: false });
  } finally {
    stub.restore();
  }
  assert.equal(result.action, 'fallthrough-invalid-active');
  assert.equal(
    stub.calls.filter((c) => Array.isArray(c.body) && c.body[0] === 'EVAL').length,
    0,
    'must not stamp seed-meta from a count-mismatched corpus',
  );
});

test('CAS conflict during repair is rethrown', async () => {
  const stub = stubRedis(militaryRedisHandler({ evalResult: [0, '999'] }));
  try {
    await assert.rejects(
      () => maybeRepairMissingSeedMeta(URL_BASE, TOKEN, '', { force: false }),
      /Active version changed during validation/,
    );
  } finally {
    stub.restore();
  }
});
