import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySectorValuationFreshness,
  CACHE_TOOLS,
} from '../api/mcp/registry/cache-tools';

describe('get_market_data sector valuation coverage contract', () => {
  it('declares the valuation coverage agents receive from market:sectors:v2', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool);
    assert.match(tool.description, /valuation coverage/i);

    const sectors = tool.outputSchema?.properties?.data?.properties?.sectors;
    const coverage = sectors?.properties?.valuationCoverage;
    assert.ok(coverage, 'valuationCoverage must be discoverable in the MCP output schema');
    assert.deepEqual(
      Object.keys(coverage.properties || {}).sort(),
      [
        'currentValuationCount',
        'expectedValuationCount',
        'fetchedAt',
        'lastGood',
        'source',
        'sourceStatus',
        'stale',
        'staleValuationSymbols',
        'unavailableSymbols',
        'valuationCount',
        'valuationDiagnostics',
      ],
    );
    assert.deepEqual(coverage.properties?.sourceStatus?.enum, ['ok', 'partial', 'degraded']);
  });

  it('checks the sector seed metadata as part of aggregate market freshness', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool);
    const sectorCheck = tool._freshnessChecks?.find(
      (check) => check.key === 'seed-meta:market:sectors',
    );
    assert.deepEqual(sectorCheck, {
      key: 'seed-meta:market:sectors',
      maxStaleMin: 30,
    });
  });

  it('marks valuation coverage stale once the published snapshot ages past the sector budget', () => {
    const now = 1_700_000_000_000;
    const data = {
      sectors: {
        valuationCoverage: {
          valuationCount: 12,
          expectedValuationCount: 12,
          sourceStatus: 'ok',
          source: 'yahoo_quote_summary_authenticated_direct',
          fetchedAt: now - 31 * 60_000,
          stale: false,
        },
      },
    };

    applySectorValuationFreshness(data, now);
    assert.equal(data.sectors.valuationCoverage.stale, true);

    applySectorValuationFreshness(data, now - 31 * 60_000);
    assert.equal(data.sectors.valuationCoverage.stale, false);
  });

  it('runs the freshness helper through the registered get_market_data post-filter', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool?._postFilter);
    const data = {
      sectors: {
        valuationCoverage: {
          fetchedAt: Date.now() - 31 * 60_000,
          stale: false,
        },
      },
    };
    tool._postFilter(data, { limit: 0 });
    assert.equal(data.sectors.valuationCoverage.stale, true);
  });

  it('fails closed for legacy sector payloads without valuationCoverage', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool?._postFilter);
    const data = { sectors: { sectors: [] } };
    tool._postFilter(data, { limit: 0 });
    assert.deepEqual(data.sectors.valuationCoverage, {
      sourceStatus: 'degraded',
      stale: true,
    });
  });

  it('keeps valuation coverage aligned with a filtered sector symbol request', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool?._postFilter);
    const data = {
      sectors: {
        sectors: [{ symbol: 'XLK' }, { symbol: 'XLF' }],
        valuations: {
          XLK: { trailingPE: 25 },
          XLF: { trailingPE: 15 },
        },
        valuationCoverage: {
          valuationCount: 2,
          expectedValuationCount: 2,
          sourceStatus: 'ok',
          fetchedAt: Date.now(),
          unavailableSymbols: ['SMH'],
          valuationDiagnostics: [
            { symbol: 'XLK', outcomes: [] },
            { symbol: 'XLF', outcomes: [] },
          ],
        },
      },
    };
    tool._postFilter(data, { symbols: ['XLK'], limit: 0 });
    assert.deepEqual(Object.keys(data.sectors.valuations), ['XLK']);
    assert.equal(data.sectors.valuationCoverage.valuationCount, 1);
    assert.equal(data.sectors.valuationCoverage.expectedValuationCount, 1);
    assert.equal(data.sectors.valuationCoverage.sourceStatus, 'ok');
    assert.equal(data.sectors.valuationCoverage.unavailableSymbols, undefined);
    assert.deepEqual(data.sectors.valuationCoverage.valuationDiagnostics.map((entry) => entry.symbol), ['XLK']);
  });

  it('recomputes partial sourceStatus when the filter includes unavailable sector symbols', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool?._postFilter);
    const data = {
      sectors: {
        sectors: [{ symbol: 'XLK' }, { symbol: 'SMH' }],
        valuations: {
          XLK: { trailingPE: 25 },
        },
        valuationCoverage: {
          valuationCount: 1,
          expectedValuationCount: 2,
          sourceStatus: 'partial',
          fetchedAt: Date.now(),
          unavailableSymbols: ['SMH'],
          lastGood: {
            fetchedAt: Date.now() - 60_000,
            stale: true,
            symbols: ['XLK', 'XLF'],
          },
          valuationDiagnostics: [
            { symbol: 'XLK', outcomes: [] },
            { symbol: 'SMH', outcomes: [] },
            { symbol: 'XLF', outcomes: [] },
          ],
        },
      },
    };
    tool._postFilter(data, { symbols: ['XLK', 'SMH'], limit: 0 });
    assert.deepEqual(Object.keys(data.sectors.valuations), ['XLK']);
    assert.equal(data.sectors.valuationCoverage.valuationCount, 1);
    assert.equal(data.sectors.valuationCoverage.expectedValuationCount, 2);
    assert.equal(data.sectors.valuationCoverage.sourceStatus, 'partial');
    assert.deepEqual(data.sectors.valuationCoverage.unavailableSymbols, ['SMH']);
    assert.deepEqual(data.sectors.valuationCoverage.lastGood.symbols, ['XLK']);
    assert.deepEqual(
      data.sectors.valuationCoverage.valuationDiagnostics.map((entry) => entry.symbol),
      ['XLK', 'SMH'],
    );
  });

  // The stored currentValuationCount is deliberately the WHOLE-snapshot value
  // (8 of 12), not the value a narrowed view should carry. If _postFilter's
  // recompute is deleted, the assertion below sees 8 and fails -- the earlier
  // version of this test seeded the already-correct answer, so it passed
  // whether or not the production code did anything.
  it('recomputes current count for the narrowed view and keeps it partial', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool?._postFilter);
    const data = {
      sectors: {
        sectors: [{ symbol: 'XLK' }, { symbol: 'SMH' }],
        valuations: {
          XLK: { trailingPE: 25 },
          SMH: { trailingPE: 35 },
        },
        valuationCoverage: {
          valuationCount: 12,
          expectedValuationCount: 12,
          currentValuationCount: 8,
          sourceStatus: 'partial',
          fetchedAt: Date.now(),
          staleValuationSymbols: ['SMH'],
        },
      },
    };

    tool._postFilter(data, { symbols: ['XLK', 'SMH'], limit: 0 });
    assert.equal(data.sectors.valuationCoverage.valuationCount, 2);
    assert.equal(data.sectors.valuationCoverage.expectedValuationCount, 2);
    assert.equal(data.sectors.valuationCoverage.currentValuationCount, 1);
    assert.equal(data.sectors.valuationCoverage.sourceStatus, 'partial');
    assert.deepEqual(data.sectors.valuationCoverage.staleValuationSymbols, ['SMH']);
  });

  it('drops stale symbols outside the requested subset and omits an equal current count', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool?._postFilter);
    const data = {
      sectors: {
        sectors: [{ symbol: 'XLK' }, { symbol: 'SMH' }],
        valuations: { XLK: { trailingPE: 25 }, SMH: { trailingPE: 35 } },
        valuationCoverage: {
          valuationCount: 12,
          expectedValuationCount: 12,
          currentValuationCount: 8,
          sourceStatus: 'partial',
          fetchedAt: Date.now(),
          staleValuationSymbols: ['SMH'],
        },
      },
    };

    // Narrowed to a symbol that is entirely current: the view is complete, and
    // currentValuationCount must be OMITTED because it equals valuationCount
    // (the producer's own omit-when-equal contract).
    tool._postFilter(data, { symbols: ['XLK'], limit: 0 });
    assert.equal(data.sectors.valuationCoverage.valuationCount, 1);
    assert.equal(data.sectors.valuationCoverage.sourceStatus, 'ok');
    assert.equal(data.sectors.valuationCoverage.staleValuationSymbols, undefined);
    assert.ok(
      !('currentValuationCount' in data.sectors.valuationCoverage),
      'currentValuationCount must be omitted when it equals valuationCount',
    );
  });

  it('marks a narrowed view degraded when every requested symbol is stale', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool?._postFilter);
    const data = {
      sectors: {
        sectors: [{ symbol: 'SMH' }],
        valuations: { SMH: { trailingPE: 35 } },
        valuationCoverage: {
          valuationCount: 12,
          expectedValuationCount: 12,
          currentValuationCount: 8,
          sourceStatus: 'partial',
          fetchedAt: Date.now(),
          staleValuationSymbols: ['SMH'],
        },
      },
    };

    // Nothing in the requested set is current, so 'partial' would overstate it.
    tool._postFilter(data, { symbols: ['SMH'], limit: 0 });
    assert.equal(data.sectors.valuationCoverage.currentValuationCount, 0);
    assert.equal(data.sectors.valuationCoverage.sourceStatus, 'degraded');
  });

  it('marks filtered coverage degraded when every requested sector symbol is unavailable', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool?._postFilter);
    const data = {
      sectors: {
        sectors: [{ symbol: 'SMH' }],
        valuations: {
          XLK: { trailingPE: 25 },
        },
        valuationCoverage: {
          valuationCount: 1,
          expectedValuationCount: 2,
          sourceStatus: 'partial',
          fetchedAt: Date.now(),
          unavailableSymbols: ['SMH'],
        },
      },
    };
    tool._postFilter(data, { symbols: ['SMH'], limit: 0 });
    assert.deepEqual(data.sectors.valuations, {});
    assert.equal(data.sectors.valuationCoverage.valuationCount, 0);
    assert.equal(data.sectors.valuationCoverage.expectedValuationCount, 1);
    assert.equal(data.sectors.valuationCoverage.sourceStatus, 'degraded');
    assert.deepEqual(data.sectors.valuationCoverage.unavailableSymbols, ['SMH']);
  });

  it('clears lastGood when the filter removes every borrowed symbol', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool?._postFilter);
    const data = {
      sectors: {
        sectors: [{ symbol: 'XLK' }],
        valuations: {
          XLK: { trailingPE: 25 },
        },
        valuationCoverage: {
          valuationCount: 1,
          expectedValuationCount: 1,
          sourceStatus: 'ok',
          fetchedAt: Date.now(),
          lastGood: {
            fetchedAt: Date.now() - 60_000,
            stale: true,
            symbols: ['XLF'],
          },
        },
      },
    };
    tool._postFilter(data, { symbols: ['XLK'], limit: 0 });
    assert.equal(data.sectors.valuationCoverage.lastGood, undefined);
    assert.equal(data.sectors.valuationCoverage.sourceStatus, 'ok');
  });

  it('clears sector valuations and coverage when symbols filter matches no sector ETFs', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
    assert.ok(tool?._postFilter);
    const data = {
      sectors: {
        sectors: [{ symbol: 'XLK' }, { symbol: 'XLF' }],
        valuations: {
          XLK: { trailingPE: 25 },
          XLF: { trailingPE: 15 },
        },
        valuationCoverage: {
          valuationCount: 2,
          expectedValuationCount: 2,
          sourceStatus: 'ok',
          fetchedAt: Date.now(),
          lastGood: {
            fetchedAt: Date.now() - 60_000,
            stale: true,
            symbols: ['XLK'],
          },
          valuationDiagnostics: [{ symbol: 'XLK', outcomes: [] }],
        },
      },
    };
    tool._postFilter(data, { symbols: ['AAPL'], limit: 0 });
    assert.deepEqual(data.sectors.sectors, []);
    assert.deepEqual(data.sectors.valuations, {});
    assert.equal(data.sectors.valuationCoverage.valuationCount, 0);
    assert.equal(data.sectors.valuationCoverage.expectedValuationCount, 0);
    assert.equal(data.sectors.valuationCoverage.sourceStatus, 'ok');
    assert.equal(data.sectors.valuationCoverage.lastGood, undefined);
    assert.equal(data.sectors.valuationCoverage.valuationDiagnostics, undefined);
  });
});
