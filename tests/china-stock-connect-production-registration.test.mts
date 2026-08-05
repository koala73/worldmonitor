import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { BOOTSTRAP_CACHE_KEYS } from '../shared/bootstrap-tier-keys.js';
import { __testing__ as healthTesting } from '../api/health.js';
import { CHINA_COVERAGE_ENTRIES } from '../scripts/china-coverage-manifest.mjs';
import {
  CHINA_STOCK_CONNECT_KEY,
  STOCK_CONNECT_SOURCE_CONTRACTS,
} from '../scripts/china-stock-connect/adapters.mjs';
import {
  CHINA_STOCK_CONNECT_MAX_CONTENT_AGE_MIN,
  CHINA_STOCK_CONNECT_MAX_STALE_MIN,
  CHINA_STOCK_CONNECT_TTL_SECONDS,
} from '../scripts/seed-china-stock-connect.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('China Stock Connect production registration (#6155)', () => {
  it('schedules the seeder inside the market-backup bundle with edge auth declared', () => {
    const bundle = read('scripts/seed-bundle-market-backup.mjs');
    const member = /\{[^\n]*'China-Stock-Connect'[^\n]*\}/u.exec(bundle)?.[0] ?? '';
    assert.match(member, /script:\s*'seed-china-stock-connect\.mjs'/u);
    // A seeder fetches upstream and writes Redis; the web tier serves from
    // Redis. This member never routes an exchange fetch through the edge
    // function, so it must not declare that function's shared secret.
    assert.doesNotMatch(member, /RELAY_SHARED_SECRET/u);
    assert.doesNotMatch(
      read('scripts/china-stock-connect/adapters.mjs'),
      /edgeEgress|fetchViaEdgeEgress|china-exchange-egress/u,
    );
    assert.match(
      bundle,
      /'China-Stock-Connect'[^}]*canonicalKey:\s*'market:china:stock-connect:v1'/,
    );
    // The bundle-wide requiredEnv is unchanged: RELAY_SHARED_SECRET and
    // PROXY_URL were already mandatory for other members, and SZSE_PROXY_URL
    // stays undeclared because the adapter falls back to PROXY_URL.
    const railwayServices = JSON.parse(read('scripts/railway-services.json')) as Array<{
      service: string;
      requiredEnv?: (string | string[])[];
      watchPatterns?: string[];
    }>;
    const marketBackup = railwayServices.find(
      (entry) => entry.service === 'seed-bundle-market-backup',
    );
    assert.deepEqual(marketBackup?.requiredEnv, ['PROXY_URL', 'RELAY_SHARED_SECRET']);
    for (const path of [
      'scripts/_china-exchange-transport.mjs',
      'scripts/china-stock-connect/adapters.mjs',
      'scripts/seed-china-stock-connect.mjs',
    ]) {
      assert.ok(
        marketBackup?.watchPatterns?.includes(path),
        `${path} must be watched or Railway will not redeploy on a change to it`,
      );
    }
  });

  it('resolves the SZSE proxy through the shared fallback the registry declares', () => {
    assert.match(
      read('scripts/china-stock-connect/adapters.mjs'),
      /proxyUrl = process\.env\.SZSE_PROXY_URL \|\| process\.env\.PROXY_URL \|\| ''/,
    );
    assert.match(
      read('scripts/china-stock-connect/adapters.mjs'),
      /sseProxyUrl = process\.env\.SSE_PROXY_URL \|\| proxyUrl/,
    );
  });

  it('registers health, seed-health and the coverage manifest on one freshness budget', () => {
    assert.match(
      read('api/health.js'),
      /chinaStockConnect:\s*\{ key: 'seed-meta:market:china-stock-connect',\s*maxStaleMin:\s*180/,
    );
    assert.match(
      read('api/seed-health.js'),
      /'market:china-stock-connect':\s*\{[^}]*intervalMin:\s*90/,
      'seed-health classifies at intervalMin * 2, so 90 must mirror /api/health\'s 180',
    );
    assert.equal(CHINA_STOCK_CONNECT_MAX_STALE_MIN, 180);

    const entry = CHINA_COVERAGE_ENTRIES.find(
      (candidate: { id: string }) => candidate.id === 'market.china-stock-connect',
    );
    assert.ok(entry, 'the China coverage manifest must carry the new source');
    assert.equal(entry.launchStatus, 'launched');
    assert.equal(entry.ownerIssue, 6155);
    assert.equal(entry.content.key, CHINA_STOCK_CONNECT_KEY);
    assert.equal(
      entry.content.maxAgeMin,
      CHINA_STOCK_CONNECT_MAX_CONTENT_AGE_MIN,
      'coverage and the seeder must agree on how long a silent exchange is acceptable',
    );
    // Content age is measured off the published trade dates, never fetchedAt --
    // a forced re-run must not be able to refresh a frozen upstream.
    assert.deepEqual(entry.content.probe.timestampPaths, [
      ['northbound', 'tradeDate'],
      ['margin', 'tradeDate'],
    ]);
    assert.deepEqual(entry.content.probe.validStatusValues, ['healthy']);
  });

  it('treats an empty snapshot as a failure rather than a quiet market', () => {
    const seed = read('scripts/seed-china-stock-connect.mjs');
    assert.match(seed, /zeroIsValid:\s*false/);
    assert.equal(
      healthTesting.ZERO_RECORD_DATA_OK_KEYS.has('chinaStockConnect'),
      false,
      'zero records here means every source failed, which must alarm',
    );
  });

  it('keeps the canonical TTL well clear of the bundle cadence', () => {
    const bundle = read('scripts/seed-bundle-market-backup.mjs');
    const member = /\{[^\n]*'China-Stock-Connect'[^\n]*\}/u.exec(bundle)?.[0] ?? '';
    const intervalMinutes = Number(/intervalMs:\s*(\d+)\s*\*\s*MIN/u.exec(member)?.[1]);
    assert.ok(Number.isFinite(intervalMinutes));
    assert.ok(
      CHINA_STOCK_CONNECT_TTL_SECONDS >= 3 * intervalMinutes * 60,
      'a canonical key must outlive at least three scheduled runs',
    );
  });

  it('stays out of the bootstrap tier while it has no dashboard consumer', () => {
    // #6155 is the data layer only. Registering a bootstrap key with no
    // getHydratedData() consumer trips the tier-freeloader guard, so the key is
    // deliberately standalone-monitored instead.
    assert.equal(
      Object.values(BOOTSTRAP_CACHE_KEYS).includes(CHINA_STOCK_CONNECT_KEY),
      false,
    );
    assert.match(read('api/health.js'), /chinaStockConnect:\s*'market:china:stock-connect:v1'/);
  });

  it('records terms for every new endpoint, as the existing exchange entries do', () => {
    const documented = read('docs/china-data-coverage.mdx');
    const documentedZh = read('docs/zh/china-data-coverage.mdx');
    for (const contract of Object.values(STOCK_CONNECT_SOURCE_CONTRACTS)) {
      assert.match(contract.termsUrl, /^https:\/\/(?:www\.sse\.com\.cn|www\.szse\.cn)\//u);
    }
    for (const page of [documented, documentedZh]) {
      assert.ok(page.includes('market.china-stock-connect'));
      assert.ok(page.includes('https://www.sse.com.cn/home/legal/'));
      assert.ok(page.includes('https://www.szse.cn/application/laws/'));
      // The one claim a reader must not take away from this source.
      assert.ok(page.includes('2024-08-16'));
    }
  });
});
