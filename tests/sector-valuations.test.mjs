import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  collectSectorValuations,
  collectV7Valuations,
  mergeReturnMetrics,
  parseV7Quote,
} from '../scripts/_yahoo-sector-valuations.cjs';

const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
const valuationFetcherSrc = readFileSync('scripts/_yahoo-sector-valuations.cjs', 'utf8');

const extractFn = (name) => {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`Function ${name} not found`);
  let depth = 0;
  let i = src.indexOf('{', start);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') depth--;
    if (depth === 0) break;
  }
  return src.slice(bodyStart, i + 1);
};

// eslint-disable-next-line no-new-func
const parseSectorValuation = new Function(
  'raw',
  extractFn('parseSectorValuation')
    .replace(/^{/, '')
    .replace(/}$/, ''),
);

describe('parseSectorValuation', () => {
  it('returns null for null input', () => {
    assert.equal(parseSectorValuation(null), null);
  });

  it('returns null for undefined input', () => {
    assert.equal(parseSectorValuation(undefined), null);
  });

  it('returns null when both PE values are missing', () => {
    assert.equal(parseSectorValuation({ beta: 1.2 }), null);
  });

  it('parses numeric values correctly', () => {
    const result = parseSectorValuation({
      trailingPE: 25.3,
      forwardPE: 22.1,
      beta: 1.05,
      ytdReturn: 0.08,
      threeYearReturn: 0.12,
      fiveYearReturn: 0.10,
    });
    assert.equal(result.trailingPE, 25.3);
    assert.equal(result.forwardPE, 22.1);
    assert.equal(result.beta, 1.05);
    assert.equal(result.ytdReturn, 0.08);
    assert.equal(result.threeYearReturn, 0.12);
    assert.equal(result.fiveYearReturn, 0.10);
  });

  it('handles string values via typeof guard (PizzINT pattern)', () => {
    const result = parseSectorValuation({
      trailingPE: '18.5',
      forwardPE: '16.2',
      beta: '0.95',
      ytdReturn: '0.05',
    });
    assert.equal(result.trailingPE, 18.5);
    assert.equal(result.forwardPE, 16.2);
    assert.equal(result.beta, 0.95);
    assert.equal(result.ytdReturn, 0.05);
  });

  it('returns null for NaN/Infinity values', () => {
    const result = parseSectorValuation({
      trailingPE: NaN,
      forwardPE: Infinity,
    });
    assert.equal(result, null);
  });

  it('allows partial data (trailingPE only)', () => {
    const result = parseSectorValuation({
      trailingPE: 20,
    });
    assert.equal(result.trailingPE, 20);
    assert.equal(result.forwardPE, null);
    assert.equal(result.beta, null);
    assert.equal(result.ytdReturn, null);
  });

  it('allows partial data (forwardPE only)', () => {
    const result = parseSectorValuation({
      forwardPE: 15,
    });
    assert.equal(result.trailingPE, null);
    assert.equal(result.forwardPE, 15);
  });
});

describe('authenticated Yahoo quoteSummary integration (static analysis)', () => {
  const fnStart = src.indexOf('function fetchYahooQuoteSummary(');
  const fnChunk = src.slice(fnStart, fnStart + 300);
  const sectorSeedSrc = extractFn('seedSectorSummary');

  it('exists in ais-relay.cjs', () => {
    assert.ok(fnStart > -1, 'fetchYahooQuoteSummary function not found');
  });

  it('delegates to the cached authenticated client', () => {
    assert.match(fnChunk, /_yahooQuoteSummaryClient\.fetch\(symbol\)/);
  });

  it('bootstraps both the Yahoo cookie and crumb before quoteSummary', () => {
    assert.match(valuationFetcherSrc, /https:\/\/fc\.yahoo\.com/);
    assert.match(valuationFetcherSrc, /\/v1\/test\/getcrumb/);
    assert.match(valuationFetcherSrc, /v10\/finance\/quoteSummary/);
  });

  it('extracts PE, beta, and return metrics', () => {
    for (const field of [
      'trailingPE',
      'forwardPE',
      'beta3Year',
      'ytdReturn',
      'threeYearAverageReturn',
      'fiveYearAverageReturn',
    ]) {
      assert.match(valuationFetcherSrc, new RegExp(field));
    }
  });

  it('includes User-Agent header', () => {
    assert.match(valuationFetcherSrc, /'User-Agent'/);
  });

  it('bounds route failures with one refresh and a cooldown', () => {
    assert.match(valuationFetcherSrc, /attempt < 2/);
    assert.match(valuationFetcherSrc, /cooldownUntil/);
  });

  it('wires authenticated diagnostics and canonical-write health into the relay seed', () => {
    assert.match(sectorSeedSrc, /fetchValueDetailed: \(symbol, options\) => _yahooQuoteSummaryClient\.fetchDetailed\(symbol, options\)/);
    assert.match(sectorSeedSrc, /v7Client: _yahooQuoteSummaryClient/);
    assert.match(sectorSeedSrc, /valuationDiagnostics/);
    assert.match(sectorSeedSrc, /buildSectorSeedMeta\(sectorMeta, ok\)/);
  });
});

describe('sector valuation collection', () => {
  it('executes one bounded, paced fetch per symbol and preserves source coverage', async () => {
    const calls = [];
    const delays = [];
    const result = await collectSectorValuations({
      symbols: ['XLK', 'XLF', 'XLE'],
      fetchValue: async (symbol) => {
        calls.push(symbol);
        if (symbol === 'XLF') return null;
        return {
          source: symbol === 'XLK'
            ? 'yahoo_quote_summary_authenticated_direct'
            : 'yahoo_quote_summary_authenticated_proxy',
          value: { trailingPE: symbol === 'XLK' ? 25 : 18 },
        };
      },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async (ms) => delays.push(ms),
    });

    assert.deepEqual(calls, ['XLK', 'XLF', 'XLE']);
    assert.deepEqual(delays, [150, 150, 150]);
    assert.deepEqual(result, {
      valuations: {
        XLK: { trailingPE: 25 },
        XLE: { trailingPE: 18 },
      },
      valuationSources: [
        'yahoo_quote_summary_authenticated_direct',
        'yahoo_quote_summary_authenticated_proxy',
      ],
      valuationCount: 2,
      unavailableSymbols: ['XLF'],
    });
  });

  it('uses v7 as primary source when v7UserAgent is provided', async () => {
    const v10Symbols = [];
    let lastGoodSetKey = null;
    let lastGoodSetValue = null;
    const result = await collectSectorValuations({
      symbols: ['XLK', 'XLF'],
      fetchValue: async (symbol) => {
        v10Symbols.push(symbol);
        return {
          value: {
            forwardPE: 20,
            ytdReturn: 0.08,
            threeYearReturn: 0.12,
            fiveYearReturn: 0.1,
          },
        };
      },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7ResolveProxyString: () => '',
      v7Client: {
        fetchV7Detailed: async () => ({
          kind: 'failed',
          value: null,
          diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'http_401' }],
        }),
      },
      upstashGet: async () => null,
      upstashSet: async (key, value) => {
        lastGoodSetKey = key;
        lastGoodSetValue = value;
        return true;
      },
    });

    // The authenticated v7 tier fails closed in this fixture, so v10 fallback
    // handles all symbols. The test verifies v7 runs before v10 and does not
    // add unbounded retries when its route is unavailable.
    assert.equal(v10Symbols.length, 2, 'v10 fallback handles symbols v7 could not reach');
    assert.ok(result.valuationCount > 0, 'should return valuations');
    // v7 coverage exists but v10 data has no raw.source -> fallback to yahoo_v7_quote
    assert.deepEqual(result.valuationSources, ['yahoo_v7_quote'], 'should report v7 as fallback source');
    assert.equal(lastGoodSetKey, 'market:sectors:valuations:last-good', 'should persist last-good cache');
    assert.ok(lastGoodSetValue?.valuations?.XLK, 'last-good should contain XLK valuations');
  });

  it('logs when a complete last-good snapshot write returns false', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      await collectSectorValuations({
        symbols: ['XLK'],
        fetchValue: async () => ({
          value: {
            trailingPE: 25,
            forwardPE: 22,
            ytdReturn: 0.08,
            threeYearReturn: 0.12,
            fiveYearReturn: 0.1,
          },
        }),
        parseValue: (raw) => raw?.value ?? null,
        sleepFn: async () => {},
        upstashGet: async () => null,
        upstashSet: async () => false,
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      warnings.some((message) => message.includes('last-good valuation snapshot write failed')),
      'false upstashSet must surface a bounded warning',
    );
  });

  it('falls back to v10 for symbols v7 did not cover', async () => {
    const v10Symbols = [];
    const result = await collectSectorValuations({
      symbols: ['XLK', 'XLF', 'XLE'],
      fetchValue: async (symbol) => {
        v10Symbols.push(symbol);
        return { value: { trailingPE: symbol === 'XLF' ? 18 : 15 } };
      },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7ResolveProxyString: () => '',
      v7Client: {
        fetchV7Detailed: async (symbol) => symbol === 'XLK'
          ? {
            kind: 'success',
            value: { trailingPE: 25, forwardPE: 22, beta: 1.1, source: 'yahoo_v7_quote_authenticated_direct' },
            diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'success' }],
          }
          : {
            kind: 'failed',
            value: null,
            diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'http_401' }],
          },
      },
      upstashGet: async () => null,
      upstashSet: async () => {},
    });

    // v7 only covers XLK; v10 runs for the remaining symbols.
    assert.equal(result.valuationCount, 3, 'should return all three valuations');
    assert.ok(result.valuations.XLK, 'should have XLK from v7');
    assert.ok(result.valuations.XLF, 'should have XLF from v10 fallback');
    assert.ok(result.valuations.XLE, 'should have XLE from v10 fallback');
  });

  it('records authenticated v7 coverage and explicit last-good metric provenance', async () => {
    const result = await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => { throw new Error('v10 must not run for a v7 success'); },
      parseValue: (raw) => raw,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async () => ({
          kind: 'success',
          value: {
            trailingPE: 25,
            forwardPE: 22,
            beta: 1.1,
            ytdReturn: null,
            threeYearReturn: null,
            fiveYearReturn: null,
            source: 'yahoo_v7_quote_authenticated_direct',
          },
          diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'success' }],
        }),
      },
      upstashGet: async () => ({
        fetchedAt: 1_700_000_000_000,
        valuations: { XLK: { ytdReturn: 0.08, threeYearReturn: 0.12, fiveYearReturn: 0.1 } },
      }),
      upstashSet: async () => {},
    });

    assert.equal(result.valuationCount, 1);
    assert.deepEqual(result.valuations.XLK, {
      trailingPE: 25,
      forwardPE: 22,
      beta: 1.1,
      ytdReturn: 0.08,
      threeYearReturn: 0.12,
      fiveYearReturn: 0.1,
    });
    assert.deepEqual(result.lastGoodMetricsUsed, ['XLK']);
    assert.equal(result.lastGoodFetchedAt, 1_700_000_000_000);
    assert.deepEqual(result.valuationSources, ['yahoo_v7_quote_authenticated_direct']);
  });

  it('does not re-date borrowed last-good metrics after a partial run', async () => {
    let writes = 0;
    const result = await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => { throw new Error('v10 must not run for a v7 success'); },
      parseValue: (raw) => raw,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async () => ({
          kind: 'success',
          value: {
            trailingPE: 25,
            forwardPE: 22,
            beta: 1.1,
            ytdReturn: null,
            threeYearReturn: null,
            fiveYearReturn: null,
            source: 'yahoo_v7_quote_authenticated_direct',
          },
          diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'success' }],
        }),
      },
      upstashGet: async () => ({
        fetchedAt: 1_700_000_000_000,
        valuations: { XLK: { ytdReturn: 0.08, threeYearReturn: 0.12, fiveYearReturn: 0.1 } },
      }),
      upstashSet: async () => { writes++; },
    });

    assert.deepEqual(result.lastGoodMetricsUsed, ['XLK']);
    assert.equal(writes, 0, 'borrowed metrics must not renew the last-good timestamp');
  });

  it('loads last-good after quoteSummary fallback and preserves it when fallback fields are incomplete', async () => {
    let reads = 0;
    let writes = 0;
    const result = await collectSectorValuations({
      symbols: ['XLK', 'XLF'],
      fetchValue: async () => ({ value: { forwardPE: 20 } }),
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async () => ({
          kind: 'failed',
          value: null,
          diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'http_401' }],
        }),
      },
      upstashGet: async () => {
        reads++;
        return {
          fetchedAt: 1_700_000_000_000,
          valuations: {
            XLK: { ytdReturn: 0.08, threeYearReturn: 0.12, fiveYearReturn: 0.1 },
            XLF: { ytdReturn: 0.06, threeYearReturn: 0.11, fiveYearReturn: 0.09 },
          },
        };
      },
      upstashSet: async () => { writes++; },
    });

    assert.equal(reads, 1);
    assert.equal(writes, 0, 'incomplete fallback data must not replace last-good');
    assert.deepEqual(result.lastGoodMetricsUsed, ['XLK', 'XLF']);
    assert.equal(result.lastGoodFetchedAt, 1_700_000_000_000);
    assert.equal(result.valuations.XLK.ytdReturn, 0.08);
    assert.equal(result.valuations.XLF.fiveYearReturn, 0.09);
  });

  it('stops v7 and quoteSummary fallback work when the valuation budget expires', async () => {
    let current = 1_700_000_000_000;
    const v7Calls = [];
    const v10Calls = [];
    const result = await collectSectorValuations({
      symbols: ['XLK', 'XLF'],
      fetchValue: async (symbol) => {
        v10Calls.push(symbol);
        return { value: { trailingPE: 20 } };
      },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      now: () => current,
      maxDurationMs: 10,
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async (symbol) => {
          v7Calls.push(symbol);
          current += 11;
          return {
            kind: 'failed',
            value: null,
            diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'http_503' }],
          };
        },
      },
    });

    assert.deepEqual(v7Calls, ['XLK']);
    assert.deepEqual(v10Calls, []);
    assert.equal(result.valuationCount, 0);
    assert.deepEqual(result.unavailableSymbols, ['XLK', 'XLF']);
    assert.ok(result.valuationDiagnostics.some((entry) => entry.symbol === 'XLF'
      && entry.outcomes[0].responseClass === 'deadline_exceeded'));
  });
});

describe('parseV7Quote', () => {
  it('returns no_data for empty response', () => {
    const result = parseV7Quote('{"quoteResponse":{"result":[]}}');
    assert.equal(result.kind, 'no_data');
  });

  it('parses valid v7 quote response', () => {
    const result = parseV7Quote(JSON.stringify({
      quoteResponse: {
        result: [{ symbol: 'XLK', trailingPE: 25.3, forwardPE: 22.1, beta: 1.05 }],
      },
    }));
    assert.equal(result.kind, 'success');
    assert.equal(result.value.trailingPE, 25.3);
    assert.equal(result.value.forwardPE, 22.1);
    assert.equal(result.value.beta, 1.05);
    assert.equal(result.value.ytdReturn, null);
  });

  it('returns invalid_json for garbage body', () => {
    assert.equal(parseV7Quote('not json').kind, 'invalid_json');
  });
});

describe('mergeReturnMetrics', () => {
  it('fills null return metrics from last-good data', () => {
    const fresh = { XLK: { trailingPE: 25, ytdReturn: null, threeYearReturn: null, fiveYearReturn: null } };
    const lastGood = { XLK: { ytdReturn: 0.08, threeYearReturn: 0.12, fiveYearReturn: 0.10 } };
    mergeReturnMetrics(fresh, lastGood);
    assert.equal(fresh.XLK.ytdReturn, 0.08);
    assert.equal(fresh.XLK.threeYearReturn, 0.12);
    assert.equal(fresh.XLK.fiveYearReturn, 0.10);
  });

  it('does not overwrite existing metrics from v7', () => {
    const fresh = { XLK: { trailingPE: 25, ytdReturn: 0.05 } };
    const lastGood = { XLK: { ytdReturn: 0.08 } };
    mergeReturnMetrics(fresh, lastGood);
    assert.equal(fresh.XLK.ytdReturn, 0.05);
  });

  it('handles missing last-good data gracefully', () => {
    const fresh = { XLK: { trailingPE: 25 } };
    mergeReturnMetrics(fresh, null);
    assert.equal(fresh.XLK.trailingPE, 25);
  });
});

describe('v7 module functions (static analysis)', () => {
  it('exports parseV7Quote', () => {
    assert.match(valuationFetcherSrc, /parseV7Quote/);
  });

  it('exports collectV7Valuations', () => {
    assert.match(valuationFetcherSrc, /collectV7Valuations/);
  });

  it('exports mergeReturnMetrics', () => {
    assert.match(valuationFetcherSrc, /mergeReturnMetrics/);
  });

  it('uses v7/finance/quote endpoint', () => {
    assert.match(valuationFetcherSrc, /v7\/finance\/quote/);
  });

  it('uses the LAST_GOOD_KEY for Redis cache', () => {
    assert.match(valuationFetcherSrc, /LAST_GOOD_KEY/);
  });

  it('tries v7 direct before proxy fallback', () => {
    assert.match(valuationFetcherSrc, /fetchYahooV7QuoteDirect/);
    assert.match(valuationFetcherSrc, /fetchYahooV7QuoteProxy/);
  });
});
