import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { collectSectorValuations } from '../scripts/_yahoo-sector-valuations.cjs';

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

  it('uses summaryDetail and defaultKeyStatistics modules', () => {
    assert.match(valuationFetcherSrc, /summaryDetail,defaultKeyStatistics/);
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
    });
  });
});
