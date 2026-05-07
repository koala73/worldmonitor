// Sprint 1 — Content-age contract tests (2026-05-04 health-readiness plan).
//
// Verifies the runSeed API surface for the new contentMeta / maxContentAgeMin
// opts:
//   - Both opt in TOGETHER (declaring one without the other is a contract
//     violation that hard-fails at config time, not at write time).
//   - maxContentAgeMin must be a positive integer (rejects 0, negatives,
//     non-integer, undefined, null, strings).
//   - contentMeta(rawData) runs BEFORE publishTransform(rawData) so seeders
//     can use pre-publish helper fields (e.g. _publishedAtIsSynthetic) for
//     timestamp computation, then strip those helpers from the public payload.
//   - contentMeta returning null OR throwing both result in newestItemAt:null
//     in the envelope/seed-meta — health classifies as STALE_CONTENT.
//   - Future-dated items beyond clock-skew tolerance are excluded by the
//     SEEDER's own contentMeta (runSeed itself trusts whatever contentMeta
//     returns — caller responsibility, but plan recommends a 1h tolerance).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runSeed } from '../scripts/_seed-utils.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_EXIT = process.exit;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
};

let recordedCalls;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  recordedCalls = [];

  globalThis.fetch = async (url, opts = {}) => {
    const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return opts.body; } })() : null;
    recordedCalls.push({ url: String(url), method: opts?.method || 'GET', body });
    if (Array.isArray(body) && Array.isArray(body[0])) {
      return new Response(JSON.stringify(body.map(() => ({ result: 0 }))), { status: 200 });
    }
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };

  // runSeed exits via process.exit(0|1|143). Convert to a throw so tests can
  // inspect recorded calls and exit codes after the seed "finishes".
  process.exit = (code) => {
    const e = new Error(`__test_exit__:${code}`);
    e.exitCode = code;
    throw e;
  };
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.exit = ORIGINAL_EXIT;
  if (ORIGINAL_ENV.UPSTASH_REDIS_REST_URL == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.UPSTASH_REDIS_REST_URL;
  if (ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN;
});

async function runWithExitTrap(fn) {
  const result = { exitCode: null, error: null };
  try {
    await fn();
  } catch (err) {
    if (String(err.message).startsWith('__test_exit__:')) {
      result.exitCode = err.exitCode;
    } else {
      result.error = err;
    }
  }
  return result;
}

function lastMetaSetBody(resourceSuffix) {
  const setCalls = recordedCalls.filter(c =>
    Array.isArray(c.body)
    && c.body[0] === 'SET'
    && typeof c.body[1] === 'string'
    && c.body[1] === `seed-meta:test:${resourceSuffix}`,
  );
  if (setCalls.length === 0) return null;
  const last = setCalls[setCalls.length - 1];
  try { return JSON.parse(last.body[2]); } catch { return null; }
}

function lastCanonicalSetBody(canonicalKey) {
  const setCalls = recordedCalls.filter(c =>
    Array.isArray(c.body)
    && c.body[0] === 'SET'
    && typeof c.body[1] === 'string'
    && c.body[1] === canonicalKey,
  );
  if (setCalls.length === 0) return null;
  const last = setCalls[setCalls.length - 1];
  try { return JSON.parse(last.body[2]); } catch { return null; }
}

// ── Contract enforcement ─────────────────────────────────────────────────

test('contract: contentMeta declared without maxContentAgeMin → hard fail at config time', async () => {
  const result = await runWithExitTrap(() =>
    runSeed('test', 'half-config-1', 'test:half-config-1:v1', async () => ({ items: [{ id: 1 }] }), {
      validateFn: (d) => d?.items?.length >= 1,
      ttlSeconds: 3600,
      contentMeta: () => ({ newestItemAt: 1, oldestItemAt: 1 }),
      // maxContentAgeMin missing on purpose
    }),
  );
  assert.equal(result.exitCode, 1, 'must exit 1 (CONTRACT VIOLATION) when contentMeta declared without maxContentAgeMin');
});

test('contract: maxContentAgeMin declared without contentMeta → hard fail at config time', async () => {
  const result = await runWithExitTrap(() =>
    runSeed('test', 'half-config-2', 'test:half-config-2:v1', async () => ({ items: [{ id: 1 }] }), {
      validateFn: (d) => d?.items?.length >= 1,
      ttlSeconds: 3600,
      maxContentAgeMin: 1440,
      // contentMeta missing on purpose
    }),
  );
  assert.equal(result.exitCode, 1, 'must exit 1 (CONTRACT VIOLATION) when maxContentAgeMin declared without contentMeta');
});

test('contract: maxContentAgeMin must be a positive integer', async () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, '1440', null]) {
    const result = await runWithExitTrap(() =>
      runSeed('test', `bad-budget-${String(bad)}`, `test:bad-budget:v1`, async () => ({ items: [{ id: 1 }] }), {
        validateFn: (d) => d?.items?.length >= 1,
        ttlSeconds: 3600,
        contentMeta: () => ({ newestItemAt: 1, oldestItemAt: 1 }),
        maxContentAgeMin: bad,
      }),
    );
    assert.equal(
      result.exitCode, 1,
      `maxContentAgeMin=${JSON.stringify(bad)} must be rejected — silently accepting invalid values defeats the alarm`,
    );
  }
});

test('contract: contentMeta must be a function', async () => {
  const result = await runWithExitTrap(() =>
    runSeed('test', 'bad-content-meta', 'test:bad-content-meta:v1', async () => ({ items: [{ id: 1 }] }), {
      validateFn: (d) => d?.items?.length >= 1,
      ttlSeconds: 3600,
      contentMeta: { not: 'a function' },
      maxContentAgeMin: 1440,
    }),
  );
  assert.equal(result.exitCode, 1, 'must reject non-function contentMeta');
});

// ── Behavior: contentMeta runs BEFORE publishTransform ───────────────────

test('order: contentMeta receives rawData (before publishTransform strips fields)', async () => {
  // contentMeta reads `_helperFlag` which publishTransform strips.
  // If runSeed called publishTransform FIRST, contentMeta would see a payload
  // without `_helperFlag` and fail to extract a timestamp.
  let contentMetaSawHelpers = false;
  let publishTransformSawHelpers = null;

  await runWithExitTrap(() =>
    runSeed('test', 'order-check', 'test:order-check:v1', async () => ({
      items: [{ id: 1, _helperFlag: true, ts: 1700000000000 }],
    }), {
      validateFn: (d) => d?.items?.length >= 1,
      ttlSeconds: 3600,
      declareRecords: (d) => d.items.length,
      sourceVersion: 'order-check-v1',
      schemaVersion: 1,
      maxStaleMin: 1440,
      contentMeta: (data) => {
        contentMetaSawHelpers = data.items.every((i) => i._helperFlag === true);
        const ts = data.items[0].ts;
        return { newestItemAt: ts, oldestItemAt: ts };
      },
      publishTransform: (data) => {
        // Note presence (not value) — by this point contentMeta has already run
        publishTransformSawHelpers = data.items.every((i) => '_helperFlag' in i);
        return {
          ...data,
          items: data.items.map(({ _helperFlag, ...rest }) => rest),
        };
      },
      maxContentAgeMin: 1440,
    }),
  );

  assert.equal(contentMetaSawHelpers, true, 'contentMeta must see _helperFlag (runs on raw fetcher data, BEFORE publishTransform)');
  assert.equal(publishTransformSawHelpers, true, 'publishTransform also sees the raw shape (it runs second; it is what STRIPS the helpers)');
});

test('order: published canonical payload is helper-free when publishTransform strips', async () => {
  await runWithExitTrap(() =>
    runSeed('test', 'strip-check', 'test:strip-check:v1', async () => ({
      items: [{ id: 1, _helperFlag: true, ts: 1700000000000 }],
    }), {
      validateFn: (d) => d?.items?.length >= 1,
      ttlSeconds: 3600,
      declareRecords: (d) => d.items.length,
      sourceVersion: 'strip-check-v1',
      schemaVersion: 1,
      maxStaleMin: 1440,
      contentMeta: (data) => ({ newestItemAt: data.items[0].ts, oldestItemAt: data.items[0].ts }),
      publishTransform: (data) => ({
        ...data,
        items: data.items.map(({ _helperFlag, ...rest }) => rest),
      }),
      maxContentAgeMin: 1440,
    }),
  );

  const canonical = lastCanonicalSetBody('test:strip-check:v1');
  assert.ok(canonical, 'canonical key must be written');
  // Envelope: {_seed, data: {items: [...]}}
  const items = canonical.data?.items ?? [];
  assert.equal(items.length, 1);
  assert.ok(!('_helperFlag' in items[0]), 'published item must NOT carry _helperFlag — publishTransform strip respected');
});

// ── Behavior: contentMeta returning null / throwing ──────────────────────

test('content-meta returning null → newestItemAt: null in envelope + seed-meta', async () => {
  await runWithExitTrap(() =>
    runSeed('test', 'all-undated', 'test:all-undated:v1', async () => ({ items: [{ id: 1 }, { id: 2 }] }), {
      validateFn: (d) => d?.items?.length >= 1,
      ttlSeconds: 3600,
      declareRecords: (d) => d.items.length,
      sourceVersion: 'all-undated-v1',
      schemaVersion: 1,
      maxStaleMin: 1440,
      contentMeta: () => null,    // simulate "no usable item timestamps"
      maxContentAgeMin: 1440,
    }),
  );

  const meta = lastMetaSetBody('all-undated');
  assert.ok(meta, 'seed-meta must be written');
  assert.equal(meta.maxContentAgeMin, 1440, 'opt-in signal must be present');
  assert.equal(meta.newestItemAt, null, 'newestItemAt MUST be explicit null (not absent) so health classifier reads as STALE_CONTENT');
  assert.equal(meta.oldestItemAt, null, 'oldestItemAt also explicit null');

  const canonical = lastCanonicalSetBody('test:all-undated:v1');
  assert.ok(canonical, 'canonical written');
  assert.equal(canonical._seed.newestItemAt, null, 'envelope.newestItemAt also null');
  assert.equal(canonical._seed.maxContentAgeMin, 1440, 'envelope carries opt-in signal');
});

test('content-meta throwing → treated as null, runSeed continues, newestItemAt: null', async () => {
  await runWithExitTrap(() =>
    runSeed('test', 'meta-throws', 'test:meta-throws:v1', async () => ({ items: [{ id: 1 }] }), {
      validateFn: (d) => d?.items?.length >= 1,
      ttlSeconds: 3600,
      declareRecords: (d) => d.items.length,
      sourceVersion: 'meta-throws-v1',
      schemaVersion: 1,
      maxStaleMin: 1440,
      contentMeta: () => {
        throw new Error('contentMeta blew up');
      },
      maxContentAgeMin: 1440,
    }),
  );

  // Despite the throw, seed-meta is still written (publish proceeds with newestItemAt:null)
  const meta = lastMetaSetBody('meta-throws');
  assert.ok(meta, 'seed-meta still written when contentMeta throws (non-fatal)');
  assert.equal(meta.newestItemAt, null, 'newestItemAt: null when contentMeta throws — same outcome as returning null');
  assert.equal(meta.maxContentAgeMin, 1440);
});

test('content-meta with valid timestamps → newestItemAt/oldestItemAt populated', async () => {
  const NEWEST = 1700000000000;
  const OLDEST = 1690000000000;
  await runWithExitTrap(() =>
    runSeed('test', 'valid-timestamps', 'test:valid-timestamps:v1', async () => ({ items: [{ ts: NEWEST }, { ts: OLDEST }] }), {
      validateFn: (d) => d?.items?.length >= 1,
      ttlSeconds: 3600,
      declareRecords: (d) => d.items.length,
      sourceVersion: 'valid-ts-v1',
      schemaVersion: 1,
      maxStaleMin: 1440,
      contentMeta: (d) => ({
        newestItemAt: Math.max(...d.items.map((i) => i.ts)),
        oldestItemAt: Math.min(...d.items.map((i) => i.ts)),
      }),
      maxContentAgeMin: 1440,
    }),
  );

  const meta = lastMetaSetBody('valid-timestamps');
  assert.equal(meta.newestItemAt, NEWEST);
  assert.equal(meta.oldestItemAt, OLDEST);
  assert.equal(meta.maxContentAgeMin, 1440);
});

// ── Greptile PR #3596 P1 regression: non-contract-mode seeders ──────────
//
// Pre-fix the seed-meta mirror gated on `envelopeMeta` (which is null for
// non-contract-mode seeders), silently dropping the content-age trio for
// every seeder that hadn't migrated to contract mode yet — defeating the
// `contentMeta` opt-in for the majority of the cohort. Post-fix the seed-
// meta mirror reads from the local content-age values (populated whenever
// the seeder opted in, regardless of contractMode).

test('non-contract seeder with contentMeta still mirrors content-age into seed-meta (Greptile PR #3596 P1)', async () => {
  const NEWEST = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const OLDEST = Date.now() - 30 * 24 * 60 * 60 * 1000;

  await runWithExitTrap(() =>
    runSeed('test', 'non-contract-with-content-age',
      'test:non-contract-with-content-age:v1',
      async () => ({ items: [{ id: 1, ts: NEWEST }] }),
      {
        validateFn: (d) => d?.items?.length >= 1,
        ttlSeconds: 3600,
        // NOTE: no `declareRecords` / no `recordCount` → not in contract mode.
        sourceVersion: 'non-contract-v1',
        schemaVersion: 1,
        maxStaleMin: 1440,
        contentMeta: () => ({ newestItemAt: NEWEST, oldestItemAt: OLDEST }),
        maxContentAgeMin: 4320, // 3 days
      },
    ),
  );

  const meta = lastMetaSetBody('non-contract-with-content-age');
  assert.ok(meta, 'seed-meta written even for non-contract seeder');
  assert.equal(meta.newestItemAt, NEWEST,
    'newestItemAt MUST appear in seed-meta even when envelopeMeta is null (non-contract mode)');
  assert.equal(meta.oldestItemAt, OLDEST,
    'oldestItemAt MUST appear in seed-meta');
  assert.equal(meta.maxContentAgeMin, 4320,
    'maxContentAgeMin MUST appear — health classifier reads this as the opt-in signal');
});

test('non-contract seeder + contentMeta returning null → seed-meta carries newestItemAt:null + maxContentAgeMin', async () => {
  // Even when the seeder declares the trio but content extraction returns
  // null, the maxContentAgeMin opt-in signal must reach seed-meta so the
  // health classifier surfaces STALE_CONTENT (not silently skip the check).
  await runWithExitTrap(() =>
    runSeed('test', 'non-contract-content-null',
      'test:non-contract-content-null:v1',
      async () => ({ items: [{ id: 1 }] }),
      {
        validateFn: (d) => d?.items?.length >= 1,
        ttlSeconds: 3600,
        sourceVersion: 'non-contract-v1',
        schemaVersion: 1,
        maxStaleMin: 1440,
        contentMeta: () => null,
        maxContentAgeMin: 4320,
      },
    ),
  );

  const meta = lastMetaSetBody('non-contract-content-null');
  assert.ok(meta, 'seed-meta written');
  assert.equal(meta.newestItemAt, null);
  assert.equal(meta.oldestItemAt, null);
  assert.equal(meta.maxContentAgeMin, 4320,
    'opt-in signal must reach seed-meta even when contentMeta returns null');
});

// ── Anti-regression: legacy seeders unchanged ────────────────────────────

test('legacy: seeder without contentMeta writes seed-meta in legacy shape (no content-age fields)', async () => {
  await runWithExitTrap(() =>
    runSeed('test', 'legacy-shape', 'test:legacy-shape:v1', async () => ({ items: [{ id: 1 }] }), {
      validateFn: (d) => d?.items?.length >= 1,
      ttlSeconds: 3600,
      declareRecords: (d) => d.items.length,
      sourceVersion: 'legacy-v1',
      schemaVersion: 1,
      maxStaleMin: 1440,
    }),
  );

  const meta = lastMetaSetBody('legacy-shape');
  assert.ok(meta, 'seed-meta written');
  assert.equal(meta.recordCount, 1);
  assert.ok(!('newestItemAt' in meta), 'newestItemAt absent — legacy shape preserved');
  assert.ok(!('oldestItemAt' in meta), 'oldestItemAt absent');
  assert.ok(!('maxContentAgeMin' in meta), 'maxContentAgeMin absent — opt-in signal NOT set for legacy seeders');
});
