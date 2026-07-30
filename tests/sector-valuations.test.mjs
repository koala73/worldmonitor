import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

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

describe('fetchYahooQuoteSummary (static analysis)', () => {
  const fnStart = src.indexOf('function fetchYahooQuoteSummary(');
  // Window sized to cover the direct-fetch block (headers, timeout, field
  // extraction). Grown to 2000 when proxy-fallback wiring (settled guard,
  // curl helper reference) was added — field extraction must stay visible.
  const fnChunk = src.slice(fnStart, fnStart + 2000);

  it('exists in ais-relay.cjs', () => {
    assert.ok(fnStart > -1, 'fetchYahooQuoteSummary function not found');
  });

  it('uses summaryDetail and defaultKeyStatistics modules', () => {
    assert.match(fnChunk, /summaryDetail/, 'should request summaryDetail module');
    assert.match(fnChunk, /defaultKeyStatistics/, 'should request defaultKeyStatistics module');
  });

  it('uses v10/finance/quoteSummary endpoint', () => {
    assert.match(fnChunk, /v10\/finance\/quoteSummary/, 'should call Yahoo quoteSummary v10 API');
  });

  it('extracts trailingPE, forwardPE, and beta', () => {
    assert.match(fnChunk, /trailingPE/, 'should extract trailingPE');
    assert.match(fnChunk, /forwardPE/, 'should extract forwardPE');
    assert.match(fnChunk, /beta/, 'should extract beta');
  });

  it('extracts return metrics from defaultKeyStatistics', () => {
    assert.match(fnChunk, /ytdReturn/, 'should extract ytdReturn');
  });

  it('includes User-Agent header', () => {
    assert.match(fnChunk, /User-Agent/, 'should include User-Agent for Yahoo requests');
  });

  it('has timeout configured', () => {
    assert.match(fnChunk, /timeout:\s*\d+/, 'should have a timeout set');
  });
});

describe('seedSectorSummary valuation integration (static analysis)', () => {
  const fnStart = src.indexOf('async function seedSectorSummary()');
  const fnEnd = src.indexOf('\n// Gulf Quotes');
  const fnBody = src.slice(fnStart, fnEnd);

  it('calls fetchYahooQuoteSummary for each sector', () => {
    assert.match(fnBody, /fetchYahooQuoteSummary\(s\)/, 'should call fetchYahooQuoteSummary per sector');
  });

  it('calls parseSectorValuation on raw response', () => {
    assert.match(fnBody, /parseSectorValuation\(raw\)/, 'should parse raw valuation data');
  });

  it('includes valuations in payload', () => {
    assert.match(fnBody, /valuations/, 'payload should include valuations object');
  });

  it('sleeps between Yahoo requests (rate limit)', () => {
    assert.match(fnBody, /await sleep\(150\)/, 'should sleep 150ms between Yahoo calls');
  });

  it('logs valuation count', () => {
    assert.match(fnBody, /valCount/, 'should log how many valuations were fetched');
  });
});
