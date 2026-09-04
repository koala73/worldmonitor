import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildSectorValuationCoverage,
  collectSectorValuations,
  collectV7Valuations,
  mergeReturnMetrics,
  METRICS_REFRESH_MAX_AGE_MS,
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
    // seedSectorSummary is the only place these provenance fields become
    // production behaviour; a dropped or renamed passthrough is otherwise
    // invisible to the unit tests, which exercise collect/build separately.
    assert.match(sectorSeedSrc, /currentValuationCount/);
    assert.match(sectorSeedSrc, /lastGoodValuationSymbols/);
    // The operator log must not report replayed records as live coverage.
    assert.match(sectorSeedSrc, /live, \$\{valCount - liveCount\} stale/);
  });

  it('hands the relay client a rotating exit resolver, not just the pinned one', () => {
    // Anchored to the constructor call: a bare name match would pass on any
    // stray mention, and the whole defect this guards is a resolver that exists
    // but never reaches the client. The behavioural proof that the client USES
    // it lives in the exit-rotation suite; this guards only the passthrough.
    const construction = src.slice(
      src.indexOf('new YahooQuoteSummaryClient({'),
      src.indexOf('function fetchYahooQuoteSummary('),
    )
      // Comments in this region mention the resolver by name; matching them
      // would pass even with the property itself deleted.
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.ok(construction.length > 0, 'client construction not found');
    // Require the SHORTHAND form. A bare name match also accepts
    // `resolveProxyStringForAttempt: resolveProxyString` -- right key, wrong
    // function, rotation silently dead -- which is the likelier mutation than
    // deleting the line outright.
    assert.match(construction, /\bresolveProxyStringForAttempt\s*,/);
    assert.doesNotMatch(
      construction,
      /\bresolveProxyStringForAttempt\s*:/,
      'the rotating resolver must be passed itself, not aliased to another function',
    );
    assert.match(
      src,
      /require\('\.\/_proxy-utils\.cjs'\)/,
    );
    assert.match(
      src.slice(0, src.indexOf('\n', src.indexOf("require('./_proxy-utils.cjs')"))),
      /resolveProxyStringForAttempt/,
      'the rotating resolver must actually be imported',
    );
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

  it('uses a bounded v7 batch fallback for symbols omitted from individual responses', async () => {
    let batchCalls = 0;
    const result = await collectSectorValuations({
      symbols: ['XLK', 'SMH'],
      fetchValue: async () => { throw new Error('quoteSummary must not run when batch v7 recovers'); },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async () => ({
          kind: 'missing_fields',
          value: null,
          diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'missing_fields' }],
        }),
        fetchV7BatchDetailed: async (symbols) => {
          batchCalls++;
          assert.deepEqual(symbols, ['XLK', 'SMH']);
          return {
            kind: 'success',
            value: {
              source: 'yahoo_v7_quote_authenticated_direct',
              valuations: {
                XLK: { trailingPE: 25, forwardPE: null, beta: 1.1 },
                SMH: { trailingPE: 37, forwardPE: null, beta: 1.2 },
              },
              outcomes: {
                XLK: { kind: 'success', value: { trailingPE: 25, forwardPE: null, beta: 1.1 } },
                SMH: { kind: 'success', value: { trailingPE: 37, forwardPE: null, beta: 1.2 } },
              },
            },
            diagnostics: [{ route: 'v7Quote', transport: 'direct', attempts: 1, status: 200, responseClass: 'success' }],
          };
        },
      },
    });

    assert.equal(batchCalls, 1);
    assert.equal(result.valuationCount, 2);
    assert.deepEqual(result.valuationSources, ['yahoo_v7_quote_authenticated_direct']);
    assert.ok(result.valuationDiagnostics.every((entry) => entry.outcomes.some((outcome) => outcome.responseClass === 'success')));
  });

  it('preserves per-symbol transport and source for a mixed direct/proxy batch', async () => {
    const result = await collectSectorValuations({
      symbols: ['XLK', 'SMH'],
      fetchValue: async () => { throw new Error('quoteSummary must not run when the batch recovers'); },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async () => ({
          kind: 'missing_fields',
          value: null,
          diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'missing_fields' }],
        }),
        fetchV7BatchAcrossExits: async () => ({
          kind: 'success',
          stopReason: 'complete',
          bestExitAttempt: 4,
          lastExitAttempt: 4,
          exitsTried: 1,
          exitBySymbol: { SMH: 4 },
          value: {
            valuations: {
              XLK: { trailingPE: 25, forwardPE: 22, beta: 1.1 },
              SMH: { trailingPE: 37, forwardPE: 34, beta: 1.2 },
            },
            outcomes: {
              XLK: { kind: 'success' },
              SMH: { kind: 'success' },
            },
            transportBySymbol: {
              XLK: 'direct',
              SMH: 'proxy',
            },
            sourceBySymbol: {
              XLK: 'yahoo_v7_quote_authenticated_direct',
              SMH: 'yahoo_v7_quote_authenticated_proxy',
            },
          },
          diagnostics: [{ route: 'v7QuoteBatch', transport: 'proxy', responseClass: 'success' }],
        }),
      },
      upstashGet: async () => null,
      upstashSet: async () => true,
    });

    const batchOutcomeBySymbol = Object.fromEntries(
      result.valuationDiagnostics.map((entry) => [
        entry.symbol,
        entry.outcomes.find((outcome) => outcome.route === 'v7QuoteBatch'),
      ]),
    );
    assert.equal(batchOutcomeBySymbol.XLK.transport, 'direct');
    assert.equal(batchOutcomeBySymbol.XLK.exitAttempt, undefined);
    assert.equal(batchOutcomeBySymbol.XLK.exitAttemptsTried, undefined);
    assert.equal(batchOutcomeBySymbol.SMH.transport, 'proxy');
    assert.equal(batchOutcomeBySymbol.SMH.exitAttempt, 4);
    assert.deepEqual(
      [...result.valuationSources].sort(),
      ['yahoo_v7_quote_authenticated_direct', 'yahoo_v7_quote_authenticated_proxy'],
    );
  });

  it('records authenticated v7 coverage and explicit last-good metric provenance', async () => {
    const nowMs = 1_700_000_000_000;
    const result = await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => { throw new Error('v10 must not run for a v7 success with fresh metrics'); },
      parseValue: (raw) => raw,
      sleepFn: async () => {},
      now: () => nowMs,
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
        fetchedAt: nowMs,
        metricsFetchedAt: nowMs,
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
    assert.equal(result.lastGoodFetchedAt, nowMs);
    assert.deepEqual(result.valuationSources, ['yahoo_v7_quote_authenticated_direct']);
  });

  it('refreshes aged return metrics via quoteSummary even when v7 covered every symbol', async () => {
    const nowMs = 1_700_000_000_000 + METRICS_REFRESH_MAX_AGE_MS + 1;
    const v10Symbols = [];
    let written = null;
    const result = await collectSectorValuations({
      symbols: ['XLK', 'XLF'],
      fetchValue: async (symbol) => {
        v10Symbols.push(symbol);
        return {
          value: {
            trailingPE: 99,
            forwardPE: 98,
            beta: 9,
            ytdReturn: symbol === 'XLK' ? 0.21 : 0.11,
            threeYearReturn: symbol === 'XLK' ? 0.22 : 0.12,
            fiveYearReturn: symbol === 'XLK' ? 0.23 : 0.13,
          },
          source: 'yahoo_quote_summary_authenticated',
        };
      },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      now: () => nowMs,
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async (symbol) => ({
          kind: 'success',
          value: {
            trailingPE: symbol === 'XLK' ? 25 : 15,
            forwardPE: symbol === 'XLK' ? 22 : 14,
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
        metricsFetchedAt: 1_700_000_000_000,
        valuations: {
          XLK: { trailingPE: 24, forwardPE: 21, beta: 1.05, ytdReturn: 0.08, threeYearReturn: 0.12, fiveYearReturn: 0.1 },
          XLF: { trailingPE: 14, forwardPE: 13, beta: 1.0, ytdReturn: 0.06, threeYearReturn: 0.11, fiveYearReturn: 0.09 },
        },
      }),
      upstashSet: async (_key, value) => { written = value; return true; },
    });

    assert.deepEqual(v10Symbols, ['XLK', 'XLF'], 'aged metrics must force quoteSummary despite full v7 coverage');
    assert.deepEqual(result.valuations.XLK, {
      trailingPE: 25,
      forwardPE: 22,
      beta: 1.1,
      ytdReturn: 0.21,
      threeYearReturn: 0.22,
      fiveYearReturn: 0.23,
    });
    assert.equal(result.valuations.XLF.ytdReturn, 0.11);
    assert.equal(result.lastGoodMetricsUsed, undefined, 'live metrics refresh must not borrow last-good');
    assert.ok(written, 'complete live metrics must advance the snapshot');
    assert.equal(written.metricsFetchedAt, nowMs);
    assert.equal(written.valuations.XLK.trailingPE, 25, 'v7 core must win over quoteSummary PE');
    assert.equal(written.valuations.XLK.ytdReturn, 0.21);
  });

  it('skips quoteSummary metrics refresh while the snapshot metrics age is still fresh', async () => {
    const nowMs = 1_700_000_000_000 + METRICS_REFRESH_MAX_AGE_MS - 1;
    const v10Symbols = [];
    await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async (symbol) => {
        v10Symbols.push(symbol);
        throw new Error(`quoteSummary must not run while metrics are fresh: ${symbol}`);
      },
      parseValue: (raw) => raw,
      sleepFn: async () => {},
      now: () => nowMs,
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
        metricsFetchedAt: 1_700_000_000_000,
        valuations: { XLK: { ytdReturn: 0.08, threeYearReturn: 0.12, fiveYearReturn: 0.1 } },
      }),
      upstashSet: async () => {},
    });

    assert.deepEqual(v10Symbols, [], 'fresh metricsFetchedAt must suppress the age-triggered refresh');
  });

  it('treats a core-only last-good snapshot as metrics-due on the next healthy v7 cycle', async () => {
    const nowMs = 1_700_000_500_000;
    const v10Symbols = [];
    const result = await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async (symbol) => {
        v10Symbols.push(symbol);
        return {
          value: {
            trailingPE: 99,
            ytdReturn: 0.31,
            threeYearReturn: 0.32,
            fiveYearReturn: 0.33,
          },
          source: 'yahoo_quote_summary_authenticated',
        };
      },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      now: () => nowMs,
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
        // Core persist omitted metricsFetchedAt because returns were never live.
        valuations: {
          XLK: {
            trailingPE: 24,
            forwardPE: 21,
            beta: 1.05,
            ytdReturn: null,
            threeYearReturn: null,
            fiveYearReturn: null,
          },
        },
      }),
      upstashSet: async () => true,
    });

    assert.deepEqual(v10Symbols, ['XLK']);
    assert.equal(result.valuations.XLK.ytdReturn, 0.31);
    assert.equal(result.valuations.XLK.trailingPE, 25);
    assert.equal(result.lastGoodMetricsUsed, undefined);
  });

  it('keeps unstamped metrics due after a failed refresh writes core values', async () => {
    const writes = [];
    const firstCycle = await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => null,
      parseValue: (raw) => raw,
      sleepFn: async () => {},
      now: () => 1_700_000_500_000,
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
        valuations: {
          XLK: {
            trailingPE: 24,
            forwardPE: 21,
            beta: 1.05,
            ytdReturn: null,
            threeYearReturn: null,
            fiveYearReturn: null,
          },
        },
      }),
      upstashSet: async (_key, value) => { writes.push(value); return true; },
    });

    assert.equal(firstCycle.valuations.XLK.ytdReturn, null);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].metricsFetchedAt, undefined, 'failed refresh must not make null return metrics look fresh');

    const secondCycleQuoteSummaryCalls = [];
    await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async (symbol) => {
        secondCycleQuoteSummaryCalls.push(symbol);
        return null;
      },
      parseValue: (raw) => raw,
      sleepFn: async () => {},
      now: () => 1_700_000_800_000,
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async () => ({
          kind: 'success',
          value: {
            trailingPE: 26,
            forwardPE: 23,
            beta: 1.2,
            ytdReturn: null,
            threeYearReturn: null,
            fiveYearReturn: null,
            source: 'yahoo_v7_quote_authenticated_direct',
          },
          diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'success' }],
        }),
      },
      upstashGet: async () => writes[0],
      upstashSet: async () => true,
    });

    assert.deepEqual(secondCycleQuoteSummaryCalls, ['XLK'], 'unstamped metrics must retry on the next cycle');
  });

  it('accepts return-only quoteSummary values during a metrics refresh', async () => {
    const nowMs = 1_700_000_000_000 + METRICS_REFRESH_MAX_AGE_MS + 1;
    let written = null;
    const result = await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => ({
        value: {
          ytdReturn: '0.41',
          threeYearReturn: 0.42,
          fiveYearReturn: 0.43,
        },
        source: 'yahoo_quote_summary_authenticated',
      }),
      parseValue: (raw) => {
        const value = raw?.value;
        if (!value) return null;
        return value.trailingPE == null && value.forwardPE == null ? null : value;
      },
      sleepFn: async () => {},
      now: () => nowMs,
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
        metricsFetchedAt: 1_700_000_000_000,
        valuations: {
          XLK: {
            trailingPE: 24,
            forwardPE: 21,
            beta: 1.05,
            ytdReturn: 0.08,
            threeYearReturn: 0.12,
            fiveYearReturn: 0.1,
          },
        },
      }),
      upstashSet: async (_key, value) => { written = value; return true; },
    });

    assert.deepEqual(result.valuations.XLK, {
      trailingPE: 25,
      forwardPE: 22,
      beta: 1.1,
      ytdReturn: 0.41,
      threeYearReturn: 0.42,
      fiveYearReturn: 0.43,
    });
    assert.equal(written.metricsFetchedAt, nowMs);
  });

  it('persists partial live return refreshes without advancing metric freshness', async () => {
    const nowMs = 1_700_000_000_000 + METRICS_REFRESH_MAX_AGE_MS + 1;
    let written = null;
    const result = await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => ({
        value: {
          ytdReturn: 0.51,
          threeYearReturn: null,
          fiveYearReturn: null,
        },
        source: 'yahoo_quote_summary_authenticated',
      }),
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      now: () => nowMs,
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
        metricsFetchedAt: 1_700_000_000_000,
        valuations: {
          XLK: {
            trailingPE: 24,
            forwardPE: 21,
            beta: 1.05,
            ytdReturn: 0.08,
            threeYearReturn: 0.12,
            fiveYearReturn: 0.1,
          },
        },
      }),
      upstashSet: async (_key, value) => { written = value; return true; },
    });

    assert.equal(result.valuations.XLK.ytdReturn, 0.51);
    assert.equal(result.valuations.XLK.threeYearReturn, 0.12);
    assert.equal(result.valuations.XLK.fiveYearReturn, 0.1);
    assert.ok(written, 'partial live return metrics must be saved');
    assert.equal(written.valuations.XLK.ytdReturn, 0.51);
    assert.equal(written.valuations.XLK.threeYearReturn, 0.12);
    assert.equal(written.metricsFetchedAt, 1_700_000_000_000, 'partial freshness cannot advance the all-metrics clock');
  });

  it('persists a complete v7 valuation snapshot when return metrics are unavailable', async () => {
    let written = null;
    const nowMs = 1_700_000_000_000;
    const result = await collectSectorValuations({
      symbols: ['XLK', 'XLF'],
      fetchValue: async () => null,
      parseValue: (raw) => raw,
      sleepFn: async () => {},
      now: () => nowMs,
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async (symbol) => ({
          kind: 'success',
          value: {
            trailingPE: symbol === 'XLK' ? 25 : 15,
            forwardPE: symbol === 'XLK' ? 22 : 14,
            beta: 1.1,
            ytdReturn: null,
            threeYearReturn: null,
            fiveYearReturn: null,
            source: 'yahoo_v7_quote_authenticated_direct',
          },
          diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'success' }],
        }),
      },
      // No prior metrics stamp: quoteSummary is attempted, fails, then core persists.
      upstashGet: async () => null,
      upstashSet: async (_key, value) => { written = value; return true; },
    });

    assert.equal(result.valuationCount, 2);
    assert.ok(written, 'core-complete v7 coverage must still persist when metrics stay null');
    assert.equal(written.fetchedAt, nowMs);
    assert.equal(written.metricsFetchedAt, undefined);
    // The snapshot keeps the canonical six-key shape with explicit nulls.
    // Stripping null keys makes a replayed record fail `=== null` guards in
    // MarketPanel and reach `undefined.toFixed()`.
    assert.deepEqual(written?.valuations, {
      XLK: { trailingPE: 25, forwardPE: 22, beta: 1.1, ytdReturn: null, threeYearReturn: null, fiveYearReturn: null },
      XLF: { trailingPE: 15, forwardPE: 14, beta: 1.1, ytdReturn: null, threeYearReturn: null, fiveYearReturn: null },
    });
    for (const record of Object.values(written.valuations)) {
      assert.deepEqual(
        Object.keys(record).sort(),
        ['beta', 'fiveYearReturn', 'forwardPE', 'threeYearReturn', 'trailingPE', 'ytdReturn'],
        'every persisted record must carry all six keys',
      );
    }
  });

  it('reuses complete last-good valuations for symbols missing from both live routes', async () => {
    const result = await collectSectorValuations({
      symbols: ['XLK', 'XLF'],
      fetchValue: async () => { throw new Error('v10 fallback must use the detailed route'); },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async (symbol) => symbol === 'XLK'
          ? {
            kind: 'success',
            value: {
              trailingPE: 25,
              forwardPE: 22,
              beta: 1.1,
              source: 'yahoo_v7_quote_authenticated_direct',
            },
            diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'success' }],
          }
          : {
            kind: 'missing_fields',
            value: null,
            diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'missing_fields' }],
          },
      },
      fetchValueDetailed: async () => ({
        kind: 'missing_fields',
        value: null,
        diagnostics: [{ route: 'quoteSummary', transport: 'direct', responseClass: 'missing_fields' }],
      }),
      upstashGet: async () => ({
        fetchedAt: 1_700_000_000_000,
        valuations: {
          XLK: { trailingPE: 24, forwardPE: 21, beta: 1.05 },
          XLF: { trailingPE: 15, forwardPE: 14, beta: 1.1 },
        },
      }),
      upstashSet: async () => { throw new Error('partial run must not replace last-good'); },
    });

    assert.equal(result.valuationCount, 2);
    assert.equal(result.currentValuationCount, 1);
    // Replayed records are normalized back to the canonical shape on read, so
    // a snapshot persisted with null keys stripped cannot reach the dashboard
    // formatters as `undefined`.
    assert.deepEqual(result.valuations.XLF, {
      trailingPE: 15,
      forwardPE: 14,
      beta: 1.1,
      ytdReturn: null,
      threeYearReturn: null,
      fiveYearReturn: null,
    });
    assert.deepEqual(result.lastGoodValuationSymbols, ['XLF']);
    // XLF carries a published value, so it is stale -- NOT unavailable.
    // unavailableSymbols means "nothing published for this symbol at all", and
    // is omitted entirely when empty.
    assert.deepEqual(result.unavailableSymbols ?? [], []);
    assert.ok(result.valuations.XLF, 'a stale symbol still publishes a valuation');
    assert.equal(result.lastGoodFetchedAt, 1_700_000_000_000);
  });

  it('reports degraded, not partial, when every symbol is served from last-good', async () => {
    const result = await collectSectorValuations({
      symbols: ['XLK', 'XLF'],
      fetchValue: async () => { throw new Error('v10 unavailable'); },
      parseValue: () => null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async () => ({
          kind: 'failed',
          value: null,
          diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'http_500' }],
        }),
      },
      fetchValueDetailed: async () => ({
        kind: 'failed',
        value: null,
        diagnostics: [{ route: 'quoteSummary', transport: 'direct', responseClass: 'http_500' }],
      }),
      upstashGet: async () => ({
        fetchedAt: 1_700_000_000_000,
        valuations: {
          XLK: { trailingPE: 24, forwardPE: 21, beta: 1.05 },
          XLF: { trailingPE: 15, forwardPE: 14, beta: 1.1 },
        },
      }),
      upstashSet: async () => { throw new Error('a fully stale run must not persist'); },
    });

    assert.equal(result.valuationCount, 2);
    assert.equal(result.currentValuationCount, 0);
    // Provenance must not name a live route when nothing was fetched live.
    assert.deepEqual(result.valuationSources, []);

    const coverage = buildSectorValuationCoverage({
      valuationCount: result.valuationCount,
      expectedCount: 2,
      fetchedAt: 1_700_000_100_000,
      sources: result.valuationSources,
      currentValuationCount: result.currentValuationCount,
      lastGoodFetchedAt: result.lastGoodFetchedAt,
      lastGoodValuationSymbols: result.lastGoodValuationSymbols,
    });
    // A totally dead upstream must stay distinguishable from partial coverage,
    // even while stale records keep valuationCount at full strength.
    assert.equal(coverage.sourceStatus, 'degraded');
    assert.equal(coverage.seedSourceState, 'error');
    assert.equal(coverage.errorCode, 'SECTOR_VALUATIONS_UNAVAILABLE');
  });

  it('refreshes a resident core-only snapshot instead of freezing until its TTL', async () => {
    let written = null;
    const nowMs = 1_700_000_500_000;
    await collectSectorValuations({
      symbols: ['XLK', 'XLF'],
      fetchValue: async () => null,
      parseValue: (raw) => raw,
      sleepFn: async () => {},
      now: () => nowMs,
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async (symbol) => ({
          kind: 'success',
          value: {
            trailingPE: symbol === 'XLK' ? 26 : 16,
            forwardPE: symbol === 'XLK' ? 23 : 15,
            beta: 1.1,
            ytdReturn: null,
            threeYearReturn: null,
            fiveYearReturn: null,
            source: 'yahoo_v7_quote_authenticated_direct',
          },
          diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'success' }],
        }),
      },
      // A snapshot this module already wrote: complete core coverage, no return
      // metrics. The previous gate required lastGoodCoreCount < symbols.length,
      // which this fails, so the key could never be rewritten before its TTL.
      upstashGet: async () => ({
        fetchedAt: 1_700_000_000_000,
        valuations: {
          XLK: { trailingPE: 24, forwardPE: 21, beta: 1.05, ytdReturn: null, threeYearReturn: null, fiveYearReturn: null },
          XLF: { trailingPE: 15, forwardPE: 14, beta: 1.1, ytdReturn: null, threeYearReturn: null, fiveYearReturn: null },
        },
      }),
      upstashSet: async (_key, value) => { written = value; return true; },
    });

    assert.ok(written, 'a fully live core-complete run must refresh the snapshot');
    assert.equal(written.fetchedAt, nowMs);
    assert.equal(written.metricsFetchedAt, undefined, 'core-only refresh must not stamp return metric freshness');
    assert.equal(written.valuations.XLK.trailingPE, 26, 'fresh values replace stored ones');
  });

  it('preserves stored return metrics when a core-only run refreshes the snapshot', async () => {
    let written = null;
    const nowMs = 1_700_000_000_000;
    await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => { throw new Error('v10 must not run for a v7 success with fresh metrics'); },
      parseValue: (raw) => raw,
      sleepFn: async () => {},
      now: () => nowMs,
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async () => ({
          kind: 'success',
          value: {
            trailingPE: 26, forwardPE: 23, beta: 1.1,
            ytdReturn: null, threeYearReturn: null, fiveYearReturn: null,
            source: 'yahoo_v7_quote_authenticated_direct',
          },
          diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'success' }],
        }),
      },
      upstashGet: async () => ({
        fetchedAt: nowMs,
        metricsFetchedAt: nowMs,
        // Already carries return metrics AND core, so mergeReturnMetrics
        // borrows -> the run is not standing on its own data -> no rewrite.
        valuations: {
          XLK: { trailingPE: 24, forwardPE: 21, beta: 1.05, ytdReturn: 0.08, threeYearReturn: 0.12, fiveYearReturn: 0.1 },
        },
      }),
      upstashSet: async (_key, value) => { written = value; return true; },
    });

    assert.equal(written, null, 'a run borrowing return metrics must not re-date the snapshot');
  });

  it('skips the batch fallback when the remaining budget is below the floor', async () => {
    let batchCalls = 0;
    let clock = 1_000;
    await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => null,
      parseValue: () => null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      maxDurationMs: 1_000,
      now: () => clock,
      v7Client: {
        fetchV7Detailed: async () => {
          // Burn the budget inside the per-symbol tier.
          clock = 1_999;
          return {
            kind: 'missing_fields',
            value: null,
            diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'missing_fields' }],
          };
        },
        fetchV7BatchDetailed: async () => { batchCalls++; return { kind: 'failed', value: null }; },
      },
    });

    assert.equal(batchCalls, 0, 'batch must not start with no meaningful budget left');
  });

  it('records a batch_error diagnostic instead of swallowing a thrown fallback', async () => {
    const result = await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => null,
      parseValue: () => null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: {
        fetchV7Detailed: async () => ({
          kind: 'missing_fields',
          value: null,
          diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'missing_fields' }],
        }),
        fetchV7BatchDetailed: async () => { throw new Error('boom in batch'); },
      },
    });

    const outcomes = result.valuationDiagnostics.flatMap((entry) => entry.outcomes);
    const batchOutcome = outcomes.find((outcome) => outcome.route === 'v7QuoteBatch');
    assert.ok(batchOutcome, 'the batch attempt must be reported under its own route label');
    assert.equal(batchOutcome.responseClass, 'batch_error');
    assert.match(batchOutcome.failure, /boom in batch/);
  });

  it('does not re-date borrowed last-good metrics after a partial run', async () => {
    let writes = 0;
    const nowMs = 1_700_000_000_000;
    const result = await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => { throw new Error('v10 must not run for a v7 success with fresh metrics'); },
      parseValue: (raw) => raw,
      sleepFn: async () => {},
      now: () => nowMs,
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
        fetchedAt: nowMs,
        metricsFetchedAt: nowMs,
        valuations: { XLK: { ytdReturn: 0.08, threeYearReturn: 0.12, fiveYearReturn: 0.1 } },
      }),
      upstashSet: async () => { writes++; },
    });

    assert.deepEqual(result.lastGoodMetricsUsed, ['XLK']);
    assert.equal(writes, 0, 'borrowed metrics must not renew the last-good timestamp');
  });

  it('merges last-good return metrics when quoteSummary fallback fields are incomplete', async () => {
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

describe('proxy exit preference', () => {
  const PREFERRED_EXIT_KEY = 'market:sectors:valuations:proxy-exit';

  // A batch client that only serves fundamentals from `goodExit`, recording the
  // exits it was asked to start from.
  function rotatingClient({ goodExit, symbols }) {
    const startsSeen = [];
    return {
      startsSeen,
      fetchV7Detailed: async () => ({
        kind: 'missing_fields',
        value: null,
        diagnostics: [{ route: 'v7Quote', transport: 'direct', responseClass: 'missing_fields' }],
      }),
      fetchV7BatchAcrossExits: async (requested, { startExitAttempt = 0 } = {}) => {
        startsSeen.push(startExitAttempt);
        // Walk exits from the start point exactly as the real client does.
        for (let attempt = startExitAttempt; attempt < startExitAttempt + 4; attempt++) {
          if (attempt !== goodExit) continue;
          return {
            kind: 'success',
            stopReason: 'complete',
            exitAttempt: attempt,
            // The real client nominates the exit that covered the most symbols;
            // here one exit covers them all, so it is both.
            bestExitAttempt: attempt,
            exitsTried: attempt - startExitAttempt + 1,
            exitBySymbol: Object.fromEntries(requested.map((s) => [s, attempt])),
            value: {
              source: 'yahoo_v7_quote_authenticated_proxy',
              valuations: Object.fromEntries(requested.map((s) => [s, { trailingPE: 25 }])),
              outcomes: Object.fromEntries(requested.map((s) => [s, { kind: 'success' }])),
            },
            diagnostics: [{ route: 'v7QuoteBatch', transport: 'proxy', responseClass: 'success' }],
          };
        }
        return {
          kind: 'missing_fields',
          stopReason: 'attempt_cap_exhausted',
          exitAttempt: startExitAttempt + 3,
          // Nothing was covered, so no exit is worth nominating.
          bestExitAttempt: null,
          exitsTried: 4,
          value: {
            valuations: {},
            outcomes: Object.fromEntries(requested.map((s) => [s, { kind: 'missing_fields' }])),
          },
          diagnostics: [{ route: 'v7QuoteBatch', transport: 'proxy', responseClass: 'missing_fields' }],
        };
      },
      symbols,
    };
  }

  it('starts rotation at the remembered exit instead of the pinned default', async () => {
    const client = rotatingClient({ goodExit: 5, symbols: ['XLK', 'SMH'] });
    const result = await collectSectorValuations({
      symbols: ['XLK', 'SMH'],
      fetchValue: async () => { throw new Error('quoteSummary must not run when the batch recovers'); },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      upstashGet: async (key) => (key === PREFERRED_EXIT_KEY ? { attempt: 5 } : null),
      upstashSet: async () => true,
    });

    assert.deepEqual(client.startsSeen, [5], 'the cached exit is tried first');
    assert.equal(result.valuationCount, 2);
  });

  it('remembers a newly discovered good exit so the next cycle costs one request set', async () => {
    const writes = [];
    const client = rotatingClient({ goodExit: 2, symbols: ['XLK', 'SMH'] });
    await collectSectorValuations({
      symbols: ['XLK', 'SMH'],
      fetchValue: async () => { throw new Error('quoteSummary must not run when the batch recovers'); },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      upstashGet: async () => null,
      upstashSet: async (key, value, ttl) => { writes.push({ key, value, ttl }); return true; },
    });

    const exitWrite = writes.find((w) => w.key === PREFERRED_EXIT_KEY);
    assert.ok(exitWrite, 'the winning exit is persisted');
    assert.equal(exitWrite.value.attempt, 2);
    // Assert the real TTL, not merely truthiness: `ttl: 1` would satisfy `> 0`
    // while expiring immediately and defeating the point of remembering it.
    assert.equal(exitWrite.ttl, 24 * 3600, 'the preference lives a day, not a moment');
  });

  it('publishes the serving exit per symbol in the diagnostics', async () => {
    // These fields are what lets an operator tell "Yahoo has no such field" from
    // "we ran out of exits". Nothing asserted them, so a rename or a dropped
    // field would ship silently.
    const client = rotatingClient({ goodExit: 2, symbols: ['XLK', 'SMH'] });
    const result = await collectSectorValuations({
      symbols: ['XLK', 'SMH'],
      fetchValue: async () => { throw new Error('quoteSummary must not run when the batch recovers'); },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      upstashGet: async () => null,
      upstashSet: async () => true,
    });

    const batchOutcomes = (result.valuationDiagnostics || [])
      .flatMap((entry) => entry.outcomes)
      .filter((outcome) => outcome.route === 'v7QuoteBatch');
    assert.ok(batchOutcomes.length > 0, 'the batch route reports diagnostics');
    for (const outcome of batchOutcomes) {
      assert.equal(outcome.exitAttempt, 2, 'the exit that served the symbol is named');
    }
  });

  it('keeps publishing valuations when the preference write fails', async () => {
    const client = rotatingClient({ goodExit: 0, symbols: ['XLK', 'SMH'] });
    const result = await collectSectorValuations({
      symbols: ['XLK', 'SMH'],
      fetchValue: async () => { throw new Error('quoteSummary must not run when the batch recovers'); },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      // Stored exit 1 is stale; exit 0 is the one that works, so the run both
      // recovers AND tries to rewrite the preference -- which then fails.
      upstashGet: async (key) => (key === PREFERRED_EXIT_KEY ? { attempt: 0 } : null),
      upstashSet: async (key) => {
        if (key === PREFERRED_EXIT_KEY) throw new Error('redis down');
        return true;
      },
    });

    assert.equal(result.valuationCount, 2, 'a failed preference write never costs the cycle');
  });

  it('does not rewrite a fresh preference when the cached exit still works', async () => {
    const writes = [];
    const now = 1_700_000_000_000;
    const client = rotatingClient({ goodExit: 3, symbols: ['XLK', 'SMH'] });
    await collectSectorValuations({
      symbols: ['XLK', 'SMH'],
      fetchValue: async () => { throw new Error('quoteSummary must not run when the batch recovers'); },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      now: () => now,
      upstashGet: async (key) => (
        key === PREFERRED_EXIT_KEY ? { attempt: 3, savedAt: now - 60_000 } : null
      ),
      upstashSet: async (key, value, ttl) => { writes.push({ key, value, ttl }); return true; },
    });

    assert.equal(
      writes.filter((w) => w.key === PREFERRED_EXIT_KEY).length,
      0,
      'an unchanged, fresh preference must not be rewritten every five minutes',
    );
  });

  it('renews a still-good preference before its TTL forgets a working exit', async () => {
    const writes = [];
    const now = 1_700_000_000_000;
    const client = rotatingClient({ goodExit: 3, symbols: ['XLK', 'SMH'] });
    await collectSectorValuations({
      symbols: ['XLK', 'SMH'],
      fetchValue: async () => { throw new Error('quoteSummary must not run when the batch recovers'); },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      now: () => now,
      // Past the 24h key's half-life: without renewal the preference expires and
      // the next cold cycle pays the full rotation cost to rediscover exit 3.
      upstashGet: async (key) => (
        key === PREFERRED_EXIT_KEY ? { attempt: 3, savedAt: now - 20 * 3600 * 1000 } : null
      ),
      upstashSet: async (key, value, ttl) => { writes.push({ key, value, ttl }); return true; },
    });

    const exitWrite = writes.find((w) => w.key === PREFERRED_EXIT_KEY);
    assert.ok(exitWrite, 'an aging preference is renewed');
    assert.equal(exitWrite.value.attempt, 3, 'renewal keeps the same working exit');
    assert.equal(exitWrite.value.savedAt, now, 'renewal restamps the clock');
  });

  it('does not read the preference for a client that cannot rotate', async () => {
    // The gate exists so a non-rotating client does not spend a Redis
    // round-trip per cycle on a value it cannot act on. Nothing pinned it.
    const reads = [];
    await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => null,
      parseValue: () => null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      // No fetchV7BatchAcrossExits -- rotation is impossible for this client.
      v7Client: {
        fetchV7Detailed: async () => ({ kind: 'missing_fields', value: null, diagnostics: [] }),
      },
      upstashGet: async (key) => { reads.push(key); return null; },
      upstashSet: async () => true,
    });

    assert.equal(
      reads.filter((key) => key === PREFERRED_EXIT_KEY).length,
      0,
      'no preference read when nothing can use it',
    );
  });

  it('deliberately leaves the per-symbol tier on the configured exit', async () => {
    // Characterizes the KNOWN GAP documented in collectV7Valuations: the
    // per-symbol tier is NOT given the remembered exit, because routing it there
    // would stop the batch running on healthy cycles and the batch is what keeps
    // the preference fresh. Pinning it means a future change in either direction
    // is a visible decision rather than an accident. See issue #6279.
    const perSymbolOptions = [];
    const client = rotatingClient({ goodExit: 7, symbols: ['XLK', 'SMH'] });
    const wrapped = {
      ...client,
      fetchV7Detailed: async (_symbol, options) => {
        perSymbolOptions.push(options);
        return { kind: 'missing_fields', value: null, diagnostics: [] };
      },
    };

    await collectSectorValuations({
      symbols: ['XLK', 'SMH'],
      fetchValue: async () => null,
      parseValue: () => null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: wrapped,
      upstashGet: async (key) => (key === PREFERRED_EXIT_KEY ? { attempt: 7 } : null),
      upstashSet: async () => true,
    });

    assert.ok(perSymbolOptions.length > 0, 'the per-symbol tier ran');
    for (const options of perSymbolOptions) {
      assert.equal(
        options?.startExitAttempt,
        undefined,
        'the per-symbol tier receives no exit override today',
      );
    }
    assert.deepEqual(client.startsSeen, [7], 'only the batch consumes the remembered exit');
  });

  it('advances the window when no exit in it covered anything', async () => {
    // The rotation window is deterministic: attempts run start..start+N. If
    // nothing in that window ever serves the symbols, and only a full success
    // writes the preference, the seeder re-probes the identical four ports every
    // five minutes forever -- burning metered proxy bandwidth and never
    // discovering the good exits that exist elsewhere in the pool.
    const writes = [];
    const client = rotatingClient({ goodExit: 999, symbols: ['XLK', 'SMH'] });
    await collectSectorValuations({
      symbols: ['XLK', 'SMH'],
      fetchValue: async () => null,
      parseValue: () => null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      upstashGet: async (key) => (
        key === PREFERRED_EXIT_KEY ? { attempt: 4, savedAt: 1_700_000_000_000 } : null
      ),
      upstashSet: async (key, value, ttl) => { writes.push({ key, value, ttl }); return true; },
      now: () => 1_700_000_000_000,
    });

    const exitWrite = writes.find((w) => w.key === PREFERRED_EXIT_KEY);
    assert.ok(exitWrite, 'an exhausted window must be recorded so the next cycle moves on');
    assert.equal(
      exitWrite.value.attempt,
      8,
      'the next cycle starts past the four exits this one already proved bad',
    );
  });

  it('advances past an exhausted partial window instead of pinning its contributor', async () => {
    const writes = [];
    const client = {
      fetchV7Detailed: async () => ({ kind: 'missing_fields', value: null, diagnostics: [] }),
      fetchV7BatchAcrossExits: async (requested, { startExitAttempt }) => ({
        kind: 'partial',
        stopReason: 'attempt_cap_exhausted',
        bestExitAttempt: startExitAttempt,
        lastExitAttempt: startExitAttempt + 3,
        exitsTried: 4,
        exitBySymbol: { [requested[0]]: startExitAttempt },
        value: {
          valuations: { [requested[0]]: { trailingPE: 25, source: 'yahoo_v7_quote_authenticated_proxy' } },
          outcomes: Object.fromEntries(requested.map((s) => [s, { kind: s === requested[0] ? 'success' : 'missing_fields' }])),
        },
        diagnostics: [],
      }),
    };

    await collectSectorValuations({
      symbols: ['XLK', 'SMH'],
      fetchValue: async () => null,
      parseValue: () => null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      upstashGet: async (key) => (
        key === PREFERRED_EXIT_KEY ? { attempt: 4, savedAt: 1_700_000_000_000 } : null
      ),
      upstashSet: async (key, value, ttl) => { writes.push({ key, value, ttl }); return true; },
      now: () => 1_700_000_000_000,
    });

    const exitWrite = writes.find((w) => w.key === PREFERRED_EXIT_KEY);
    assert.equal(exitWrite?.value.attempt, 8, 'the next cycle starts after every exhausted exit');
  });

  it('does not advance the preference after a provider-wide failure', async () => {
    const writes = [];
    const client = {
      fetchV7Detailed: async () => ({ kind: 'failed', value: null, diagnostics: [] }),
      fetchV7BatchAcrossExits: async (requested) => ({
        kind: 'failed',
        stopReason: 'durable_failures',
        bestExitAttempt: null,
        lastExitAttempt: 8,
        exitsTried: 2,
        exitBySymbol: {},
        value: {
          valuations: {},
          outcomes: Object.fromEntries(requested.map((s) => [s, { kind: 'failed' }])),
        },
        diagnostics: [],
      }),
    };

    await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => null,
      parseValue: () => null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      upstashGet: async (key) => (key === PREFERRED_EXIT_KEY ? { attempt: 7 } : null),
      upstashSet: async (key, value) => { writes.push({ key, value }); return true; },
    });

    assert.equal(
      writes.some((write) => write.key === PREFERRED_EXIT_KEY),
      false,
      'provider failure is not evidence that an untested exit is better',
    );
  });

  it('keeps process-local rotation progress when the preference write is unavailable', async () => {
    const startsSeen = [];
    const client = {
      fetchV7Detailed: async () => ({ kind: 'missing_fields', value: null, diagnostics: [] }),
      fetchV7BatchAcrossExits: async (requested, { startExitAttempt }) => {
        startsSeen.push(startExitAttempt);
        if (startExitAttempt === 0) {
          return {
            kind: 'missing_fields',
            stopReason: 'attempt_cap_exhausted',
            bestExitAttempt: null,
            lastExitAttempt: 3,
            exitsTried: 4,
            exitBySymbol: {},
            value: { valuations: {}, outcomes: { [requested[0]]: { kind: 'missing_fields' } } },
            diagnostics: [],
          };
        }
        return {
          kind: 'success',
          stopReason: 'complete',
          bestExitAttempt: startExitAttempt,
          lastExitAttempt: startExitAttempt,
          exitsTried: 1,
          exitBySymbol: { [requested[0]]: startExitAttempt },
          value: {
            valuations: { [requested[0]]: { trailingPE: 25, source: 'yahoo_v7_quote_authenticated_proxy' } },
            outcomes: { [requested[0]]: { kind: 'success' } },
          },
          diagnostics: [],
        };
      },
    };
    const args = {
      symbols: ['XLK'],
      fetchValue: async () => null,
      parseValue: () => null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      upstashGet: async () => null,
      upstashSet: async () => false,
    };

    await collectSectorValuations(args);
    const second = await collectSectorValuations(args);

    assert.deepEqual(startsSeen, [0, 4]);
    assert.equal(second.valuationCount, 1, 'the next local window can recover without Redis');
  });

  it('runs the current-data fallback before an optional preference write', async () => {
    let now = 0;
    const order = [];
    const client = {
      fetchV7Detailed: async () => ({ kind: 'missing_fields', value: null, diagnostics: [] }),
      fetchV7BatchAcrossExits: async (requested) => ({
        kind: 'partial',
        stopReason: 'attempt_cap_exhausted',
        bestExitAttempt: 0,
        lastExitAttempt: 3,
        exitsTried: 4,
        exitBySymbol: { [requested[0]]: 0 },
        value: {
          valuations: { [requested[0]]: { trailingPE: 25, source: 'yahoo_v7_quote_authenticated_proxy' } },
          outcomes: Object.fromEntries(requested.map((s) => [s, { kind: s === requested[0] ? 'success' : 'missing_fields' }])),
        },
        diagnostics: [],
      }),
    };

    const result = await collectSectorValuations({
      symbols: ['XLK', 'SMH'],
      fetchValue: async () => {
        order.push('fallback');
        return { value: { trailingPE: 30 } };
      },
      parseValue: (raw) => raw?.value || null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      upstashGet: async () => null,
      upstashSet: async (key) => {
        if (key === PREFERRED_EXIT_KEY) {
          order.push('preference');
          now += 10_000;
        }
        return true;
      },
      maxDurationMs: 6_000,
      now: () => now,
    });

    assert.equal(result.valuationCount, 2);
    assert.deepEqual(order.slice(0, 2), ['fallback', 'preference']);
  });

  it('does not await an unresolved optional preference write', async () => {
    const client = rotatingClient({ goodExit: 0, symbols: ['XLK'] });
    let releasePreference;
    let markPreferenceStarted;
    const blockedPreference = new Promise((resolve) => { releasePreference = resolve; });
    const preferenceStarted = new Promise((resolve) => { markPreferenceStarted = resolve; });
    const collection = collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => { throw new Error('quoteSummary must not run when the batch recovers'); },
      parseValue: (raw) => raw?.value ?? null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      upstashGet: async () => null,
      upstashSet: async (key) => {
        if (key !== PREFERRED_EXIT_KEY) return true;
        markPreferenceStarted();
        return blockedPreference;
      },
    });

    try {
      await preferenceStarted;
      const stillBlocked = Symbol('preference write still blocked collection');
      const result = await Promise.race([
        collection,
        new Promise((resolve) => setImmediate(() => resolve(stillBlocked))),
      ]);
      assert.notEqual(result, stillBlocked, 'collection must resolve without the preference SET');
      assert.equal(result.valuationCount, 1);
    } finally {
      releasePreference(true);
      await collection;
    }
  });

  it('ignores a malformed or out-of-range remembered exit', async () => {
    for (const stored of [{ attempt: -1 }, { attempt: 'exit-2' }, { attempt: 1.5 }, {}, 'nonsense']) {
      const client = rotatingClient({ goodExit: 0, symbols: ['XLK'] });
      const result = await collectSectorValuations({
        symbols: ['XLK'],
        fetchValue: async () => null,
        parseValue: () => null,
        sleepFn: async () => {},
        v7UserAgent: 'test-agent',
        v7Client: client,
        upstashGet: async (key) => (key === PREFERRED_EXIT_KEY ? stored : null),
        upstashSet: async () => true,
      });
      assert.deepEqual(
        client.startsSeen,
        [0],
        `stored ${JSON.stringify(stored)} must fall back to the default exit`,
      );
      assert.equal(result.valuationCount, 1);
    }
  });

  it('survives a preference read failure without losing the cycle', async () => {
    const client = rotatingClient({ goodExit: 0, symbols: ['XLK'] });
    const result = await collectSectorValuations({
      symbols: ['XLK'],
      fetchValue: async () => null,
      parseValue: () => null,
      sleepFn: async () => {},
      v7UserAgent: 'test-agent',
      v7Client: client,
      upstashGet: async (key) => {
        if (key === PREFERRED_EXIT_KEY) throw new Error('redis down');
        return null;
      },
      upstashSet: async () => true,
    });

    assert.deepEqual(client.startsSeen, [0]);
    assert.equal(result.valuationCount, 1, 'valuations still publish when the preference is unreadable');
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
