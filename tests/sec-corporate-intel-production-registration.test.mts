// Production registration for the corporate-intelligence seeders (#5695):
// every operator surface that must know about intelligence:sec-cik-map:v1 and
// intelligence:sec-8k-stream:v1 stays in agreement. Modeled on
// tests/china-corporate-disclosure-production-registration.test.mts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  MIN_STREAM_EVENTS,
  SEC_8K_STREAM_MAX_STALE_MIN,
  SEC_8K_STREAM_KEY,
} from '../scripts/seed-sec-8k-stream.mjs';
import {
  SEC_CIK_MAP_KEY,
  SEC_CIK_MAP_MAX_STALE_MIN,
  MIN_CIK_ENTRIES,
} from '../scripts/seed-sec-cik-map.mjs';
import {
  SEC_8K_STREAM_KEY as SERVER_8K_KEY,
  SEC_CIK_MAP_KEY as SERVER_CIK_KEY,
  SEC_CIK_MAP_MAX_STALE_MIN as SERVER_CIK_MAX_STALE_MIN,
} from '../server/_shared/sec-edgar';
import { __testing__ as healthTesting } from '../api/health.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('SEC corporate-intelligence production registration (#5695)', () => {
  it('shares canonical key names between seeders and server helpers', () => {
    assert.equal(SEC_CIK_MAP_KEY, 'intelligence:sec-cik-map:v1');
    assert.equal(SEC_8K_STREAM_KEY, 'intelligence:sec-8k-stream:v1');
    assert.equal(SERVER_CIK_KEY, SEC_CIK_MAP_KEY);
    assert.equal(SERVER_8K_KEY, SEC_8K_STREAM_KEY);
  });

  it('schedules both seeders in the market-backup bundle', () => {
    const bundle = read('scripts/seed-bundle-market-backup.mjs');
    assert.match(bundle, /script: 'seed-sec-cik-map\.mjs'[^}]*seedMetaKey: 'intelligence:sec-cik-map'[^}]*canonicalKey: 'intelligence:sec-cik-map:v1'/);
    assert.match(bundle, /script: 'seed-sec-8k-stream\.mjs'[^}]*seedMetaKey: 'intelligence:sec-8k-stream'[^}]*canonicalKey: 'intelligence:sec-8k-stream:v1'/);
  });

  it('registers both keys with /api/health and keeps freshness budgets aligned', () => {
    assert.equal(healthTesting.STANDALONE_KEYS.secCikMap, SEC_CIK_MAP_KEY);
    assert.equal(healthTesting.STANDALONE_KEYS.sec8kStream, SEC_8K_STREAM_KEY);

    const health = read('api/health.js');
    assert.match(
      health,
      /secCikMap:\s*\{ key: 'seed-meta:intelligence:sec-cik-map',\s*maxStaleMin: 2880, minRecordCount: 5000 \}/,
    );
    assert.match(
      health,
      /sec8kStream:\s*\{ key: 'seed-meta:intelligence:sec-8k-stream',\s*maxStaleMin: 120, minRecordCount: 50 \}/,
    );
    assert.equal(SEC_CIK_MAP_MAX_STALE_MIN, 2880, 'seeder and /api/health must publish the same CIK-map budget');
    assert.equal(SERVER_CIK_MAX_STALE_MIN, SEC_CIK_MAP_MAX_STALE_MIN, 'request-time CIK freshness must match seed health');
    assert.equal(SEC_8K_STREAM_MAX_STALE_MIN, 120, 'seeder and /api/health must publish the same 8-K budget');
    assert.equal(MIN_CIK_ENTRIES, 5000, 'health minRecordCount mirrors the seeder validation floor');
  });

  it('treats a drained 8-K window as decay, not as a quiet market', () => {
    // A market-wide 7-day window that empties means the Atom parse decayed —
    // one feed page alone yields ~75 material events — so neither key may be
    // exempt from the zero-record alarm. Floor is 50 (below healthy yield,
    // above a hollow partial-parse stream).
    assert.equal(healthTesting.ZERO_RECORD_DATA_OK_KEYS.has('sec8kStream'), false);
    assert.equal(healthTesting.ZERO_RECORD_DATA_OK_KEYS.has('secCikMap'), false);
    assert.equal(healthTesting.EMPTY_DATA_OK_KEYS.has('secCikMap'), false);
    assert.equal(MIN_STREAM_EVENTS, 50, 'health minRecordCount mirrors the seeder floor');
  });

  it('keeps the seed-health sibling classifier in agreement (intervalMin = maxStaleMin / 2)', () => {
    const seedHealth = read('api/seed-health.js');
    assert.match(
      seedHealth,
      /'intelligence:sec-cik-map':\s*\{ key: 'seed-meta:intelligence:sec-cik-map', intervalMin: 1440, minRecordCount: 5000 \}/,
    );
    assert.match(
      seedHealth,
      /'intelligence:sec-8k-stream':\s*\{ key: 'seed-meta:intelligence:sec-8k-stream', intervalMin: 60, minRecordCount: 50 \}/,
    );
  });

  it('registers fail-closed 30/min rate policies for the three provider-proxy GETs', () => {
    const rateLimit = read('server/_shared/rate-limit.ts');
    for (const route of [
      '/api/intelligence/v1/get-company-enrichment',
      '/api/intelligence/v1/list-company-signals',
      '/api/intelligence/v1/search-sec-filings',
    ]) {
      const escaped = route.replace(/\//g, '\\/');
      assert.match(
        rateLimit,
        new RegExp(`'${escaped}':\\s*\\{\\s*limit:\\s*30,\\s*window:\\s*'60 s'\\s*\\}`),
        `${route} must have a 30/min ENDPOINT_RATE_POLICIES entry`,
      );
      // Fail-closed required-policy map (list-material-events is Redis-only and omitted).
      assert.match(
        rateLimit,
        new RegExp(`'${escaped}':\\s*\\{\\s*reason:`),
        `${route} must be in FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED`,
      );
    }
  });

  it('documents both members in the consolidation runbook', () => {
    const runbook = read('docs/railway-seed-consolidation-runbook.md');
    assert.match(runbook, /SEC CIK Map \(daily\)/);
    assert.match(runbook, /SEC 8-K Stream \(30min\)/);
  });

  it('keeps seeders inside scripts/ (nixpacks bundle constraint)', () => {
    for (const script of ['scripts/seed-sec-cik-map.mjs', 'scripts/seed-sec-8k-stream.mjs']) {
      const source = read(script);
      assert.doesNotMatch(source, /from '\.\.\/(server|src|shared|api)\//, `${script} must not import outside scripts/`);
    }
  });
});
