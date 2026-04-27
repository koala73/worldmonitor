// Regression guards for Gap #2: the SWF seeder MUST read the re-export
// share map from Redis (populated by the Comtrade seeder that runs
// immediately before it in the resilience-recovery bundle), NOT from
// the static YAML that was deleted in this PR.
//
// These four tests defend against the exact failure mode that surfaced
// in the 2026-04-24 cohort audit: SWF scores didn't move after the
// Comtrade work shipped because the SWF seeder was still reading a
// (now-absent) YAML. See plan 2026-04-24-003 §Phase 3 tests 7-10.

import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it } from 'node:test';

import { loadReexportShareFromRedis } from '../scripts/seed-sovereign-wealth.mjs';

const REEXPORT_SHARE_KEY = 'resilience:recovery:reexport-share:v1';
const REEXPORT_SHARE_META_KEY = 'seed-meta:resilience:recovery:reexport-share';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  BUNDLE_RUN_STARTED_AT_MS: process.env.BUNDLE_RUN_STARTED_AT_MS,
};

let keyStore: Record<string, unknown>;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  keyStore = {};

  // readSeedSnapshot issues `GET /get/<encodeURIComponent(key)>`.
  // Stub: look up keyStore, return `{ result: JSON.stringify(value) }`
  // or `{ result: null }` for absent keys.
  globalThis.fetch = async (url) => {
    const s = String(url);
    const match = s.match(/\/get\/(.+)$/);
    if (!match) {
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    const key = decodeURIComponent(match[1]);
    const value = keyStore[key];
    const body = value !== undefined
      ? JSON.stringify({ result: JSON.stringify(value) })
      : JSON.stringify({ result: null });
    return new Response(body, { status: 200 });
  };
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const k of Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>) {
    const v = ORIGINAL_ENV[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('loadReexportShareFromRedis — Gap #2 regression guards', () => {
  it('reads the Redis key and returns a Map of ISO2 → share when bundle-fresh', async () => {
    const bundleStart = 1_700_000_000_000;
    process.env.BUNDLE_RUN_STARTED_AT_MS = String(bundleStart);
    keyStore[REEXPORT_SHARE_KEY] = {
      manifestVersion: 2,
      countries: {
        AE: { reexportShareOfImports: 0.4, year: 2023, sources: ['https://comtrade.example/AE'] },
        PA: { reexportShareOfImports: 0.07, year: 2024, sources: ['https://comtrade.example/PA'] },
      },
    };
    keyStore[REEXPORT_SHARE_META_KEY] = {
      fetchedAt: bundleStart + 1000, // 1s AFTER bundle start — fresh
    };

    const map = await loadReexportShareFromRedis();
    assert.equal(map.size, 2);
    assert.equal(map.get('AE')?.reexportShareOfImports, 0.4);
    assert.equal(map.get('PA')?.reexportShareOfImports, 0.07);
    assert.equal(map.get('AE')?.year, 2023);
    assert.deepEqual(map.get('AE')?.sources, ['https://comtrade.example/AE']);
  });

  it('absent canonical key → empty map (status-quo gross-imports fallback)', async () => {
    process.env.BUNDLE_RUN_STARTED_AT_MS = String(1_700_000_000_000);
    // keyStore is empty — readSeedSnapshot returns null.
    const map = await loadReexportShareFromRedis();
    assert.equal(map.size, 0);
  });

  it('malformed entry (share is string) → skip that country, others unaffected', async () => {
    const bundleStart = 1_700_000_000_000;
    process.env.BUNDLE_RUN_STARTED_AT_MS = String(bundleStart);
    keyStore[REEXPORT_SHARE_KEY] = {
      manifestVersion: 2,
      countries: {
        AE: { reexportShareOfImports: 0.4, year: 2023 },
        XX: { reexportShareOfImports: 'not-a-number' },          // type-wrong
        YY: { reexportShareOfImports: 1.5 },                     // > 0.95 cap
        ZZ: { reexportShareOfImports: -0.1 },                    // negative
        AA: { reexportShareOfImports: NaN },                      // NaN
      },
    };
    keyStore[REEXPORT_SHARE_META_KEY] = { fetchedAt: bundleStart + 1000 };

    const map = await loadReexportShareFromRedis();
    assert.equal(map.size, 1);
    assert.equal(map.get('AE')?.reexportShareOfImports, 0.4);
    assert.equal(map.has('XX'), false);
    assert.equal(map.has('YY'), false);
    assert.equal(map.has('ZZ'), false);
    assert.equal(map.has('AA'), false);
  });

  it('stale seed-meta (fetchedAt < bundle start) → empty map (hard fail-safe)', async () => {
    const bundleStart = 1_700_000_000_000;
    process.env.BUNDLE_RUN_STARTED_AT_MS = String(bundleStart);
    keyStore[REEXPORT_SHARE_KEY] = {
      manifestVersion: 2,
      countries: {
        AE: { reexportShareOfImports: 0.4, year: 2023 },
      },
    };
    // fetchedAt is 1 hour BEFORE bundle start — previous bundle tick.
    // The SWF seeder MUST NOT apply last-month's share to this month's
    // data. Hard fallback: return empty, everyone uses gross imports.
    keyStore[REEXPORT_SHARE_META_KEY] = { fetchedAt: bundleStart - 3_600_000 };

    const map = await loadReexportShareFromRedis();
    assert.equal(map.size, 0,
      'stale seed-meta must produce empty map, NOT pass stale shares through');
  });

  it('missing seed-meta key → empty map (outage fail-safe)', async () => {
    const bundleStart = 1_700_000_000_000;
    process.env.BUNDLE_RUN_STARTED_AT_MS = String(bundleStart);
    keyStore[REEXPORT_SHARE_KEY] = {
      manifestVersion: 2,
      countries: { AE: { reexportShareOfImports: 0.4, year: 2023 } },
    };
    // Meta is absent — seeder produced a data envelope but seed-meta
    // write failed or races. Safer to treat as "did not run this
    // bundle" than to trust the data-key alone.
    const map = await loadReexportShareFromRedis();
    assert.equal(map.size, 0);
  });

  it('standalone mode (BUNDLE_RUN_STARTED_AT_MS unset) skips the freshness gate', async () => {
    // Regression guard for the standalone-regression bug: when a seeder
    // runs manually (operator invocation, not bundle-runner), the env
    // var is absent. Earlier designs fell back to `Date.now()` which
    // rejected any previously-seeded peer envelope as "stale" — even
    // when the operator ran the Reexport seeder milliseconds beforehand.
    // The fix: getBundleRunStartedAtMs() returns null outside a bundle;
    // the consumer skips the freshness gate but still requires meta
    // existence (peer outage still fails safely).
    delete process.env.BUNDLE_RUN_STARTED_AT_MS;
    keyStore[REEXPORT_SHARE_KEY] = {
      manifestVersion: 2,
      countries: { AE: { reexportShareOfImports: 0.35, year: 2023 } },
    };
    // Meta written 10 MINUTES ago — rejected under the old `Date.now()`
    // fallback, accepted under the null-return + skip-gate fix.
    keyStore[REEXPORT_SHARE_META_KEY] = { fetchedAt: Date.now() - 600_000 };

    const map = await loadReexportShareFromRedis();
    assert.equal(map.size, 1,
      'standalone: operator-seeded peer data must be accepted even if written before this process started');
    assert.equal(map.get('AE')?.reexportShareOfImports, 0.35);
  });

  it('standalone mode still rejects missing meta (peer outage still fails safely)', async () => {
    // Even in standalone mode, meta absence means "peer never ran" —
    // must fall back to gross imports, don't apply potentially stale
    // shares from a data key that has no freshness signal.
    delete process.env.BUNDLE_RUN_STARTED_AT_MS;
    keyStore[REEXPORT_SHARE_KEY] = {
      manifestVersion: 2,
      countries: { AE: { reexportShareOfImports: 0.35, year: 2023 } },
    };
    // No meta key written — peer outage.
    const map = await loadReexportShareFromRedis();
    assert.equal(map.size, 0,
      'standalone: absent meta must still fall back (peer-outage fail-safe survives gate bypass)');
  });

  it('fetchedAtMs === bundleStartMs passes (inclusive freshness boundary)', async () => {
    // The freshness check uses strict-less-than: `fetchedAt < bundleStart`.
    // Exact equality is treated as FRESH. This pins the inclusive-boundary
    // semantic so a future refactor to `<=` fails this test loudly
    // instead of silently rejecting a peer that wrote at the very first
    // millisecond of the bundle run (theoretically possible on a fast
    // host where t0 and the peer's fetchedAt align on the same ms).
    const bundleStart = 1_700_000_000_000;
    process.env.BUNDLE_RUN_STARTED_AT_MS = String(bundleStart);
    keyStore[REEXPORT_SHARE_KEY] = {
      manifestVersion: 2,
      countries: { AE: { reexportShareOfImports: 0.4, year: 2023 } },
    };
    keyStore[REEXPORT_SHARE_META_KEY] = { fetchedAt: bundleStart }; // EXACT equality
    const map = await loadReexportShareFromRedis();
    assert.equal(map.size, 1,
      'equality at the freshness boundary must be treated as FRESH');
    assert.equal(map.get('AE')?.reexportShareOfImports, 0.4);
  });
});
