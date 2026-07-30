/**
 * Behavioral coverage for the AIS relay closed-market equity TTL refresher.
 *
 * Run: node --test tests/closed-market-equity-maintenance.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  marketQuotesKey,
  maintainClosedMarketEquityKeys,
} = require('../scripts/shared/closed-market-equity-maintenance.cjs');

describe('closed-market equity key maintenance', () => {
  it('builds the stock quotes key with sorted symbols', () => {
    assert.equal(marketQuotesKey(['MSFT', 'AAPL', '^GSPC']), 'market:quotes:v1:AAPL,MSFT,^GSPC');
  });

  it('seed-market-quotes writes the health-watched stock meta before terminal exit', () => {
    const source = readFileSync(new URL('../scripts/seed-market-quotes.mjs', import.meta.url), 'utf8');

    assert.match(source, /runSeed\('market', 'stocks'/);
    assert.doesNotMatch(source, /runSeed\('market', 'quotes'/);
    assert.match(source, /writeFreshnessMetadata\('market', 'stocks'/);
    assert.doesNotMatch(source, /seed-meta:market:quotes/);
    const runSeedCall = source.match(/runSeed\('market', 'stocks', CANONICAL_KEY, fetchMarketQuotes, \{[\s\S]*?\}\)\.catch/);
    assert.ok(runSeedCall, 'expected seed-market-quotes to use a catch-terminated runSeed call');
    assert.match(runSeedCall[0], /afterPublish:\s*async \(data\) => \{[\s\S]*writeRequiredCompanionKeys\(data\)/);
    assert.doesNotMatch(runSeedCall[0], /\.then\(async/);
  });

  it('extends both stock keys and configured companion keys before refreshing seed-meta', async () => {
    const expires = [];
    const writes = [];

    const ok = await maintainClosedMarketEquityKeys({
      marketSymbols: ['MSFT', 'AAPL'],
      marketSeedTtl: 7200,
      preserveKeys: ['market:stock-index:v1:CN'],
      lastEquityQuoteCount: 2,
      upstashExpire: async (key, ttl) => { expires.push([key, ttl]); return true; },
      upstashGet: async () => { throw new Error('should not read meta when last count is present'); },
      upstashSet: async (key, value, ttl) => { writes.push([key, value, ttl]); return true; },
      nowMs: () => 123456,
    });

    assert.equal(ok, true);
    assert.deepEqual(expires, [
      ['market:quotes:v1:AAPL,MSFT', 7200],
      ['market:stocks-bootstrap:v1', 7200],
      ['market:stock-index:v1:CN', 7200],
    ]);
    assert.deepEqual(writes, [
      ['seed-meta:market:stocks', { fetchedAt: 123456, recordCount: 2 }, 604800],
    ]);
  });

  it('falls back to the prior seed-meta record count when the process has not seeded yet', async () => {
    const writes = [];

    const ok = await maintainClosedMarketEquityKeys({
      marketSymbols: ['AAPL'],
      marketSeedTtl: 7200,
      lastEquityQuoteCount: 0,
      upstashExpire: async () => true,
      upstashGet: async (key) => {
        assert.equal(key, 'seed-meta:market:stocks');
        return { fetchedAt: 111, recordCount: 17 };
      },
      upstashSet: async (key, value, ttl) => { writes.push([key, value, ttl]); return true; },
      nowMs: () => 222,
    });

    assert.equal(ok, true);
    assert.deepEqual(writes, [
      ['seed-meta:market:stocks', { fetchedAt: 222, recordCount: 17 }, 604800],
    ]);
  });

  it('returns false and skips seed-meta writes when either last-good key is missing', async () => {
    const writes = [];

    const ok = await maintainClosedMarketEquityKeys({
      marketSymbols: ['AAPL'],
      marketSeedTtl: 7200,
      lastEquityQuoteCount: 5,
      upstashExpire: async (key) => key !== 'market:stocks-bootstrap:v1',
      upstashGet: async () => ({ recordCount: 5 }),
      upstashSet: async (...args) => { writes.push(args); return true; },
    });

    assert.equal(ok, false);
    assert.deepEqual(writes, []);
  });
});
