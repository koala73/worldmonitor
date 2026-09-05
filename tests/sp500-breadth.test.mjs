import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeBreadth,
  fetchSp500Breadth,
  MIN_VALID_CONSTITUENTS,
} from '../scripts/_sp500-breadth.mjs';

// Scanner row shape: d = [name, close, SMA20, SMA50, SMA200].
function row(name, close, sma20, sma50, sma200) {
  return { s: `NYSE:${name}`, d: [name, close, sma20, sma50, sma200] };
}

function universe(size, build) {
  return Array.from({ length: size }, (_, i) => build(i));
}

// Barchart started answering its quote pages with an HTTP 202 AWS WAF
// challenge shell on 2026-09-02. The old scraper treated 202 as success and
// returned null three times per run, so the seeder failed on every tick with
// nothing in the log but "0/3 readings".
const WAF_CHALLENGE_HTML = '<!DOCTYPE html><html><head><title></title><script>window.awsWafCookieDomainList = [];</script></head></html>';

describe('computeBreadth', () => {
  it('reports the share of constituents closing above each moving average', () => {
    const rows = universe(500, (i) => row(`T${i}`, 100, i < 100 ? 90 : 110, i < 250 ? 90 : 110, i < 400 ? 90 : 110));
    const { readings, constituents, valid } = computeBreadth(rows);
    assert.deepEqual(readings, { pctAbove20d: 20, pctAbove50d: 50, pctAbove200d: 80 });
    assert.equal(constituents, 500);
    assert.deepEqual(valid, { pctAbove20d: 500, pctAbove50d: 500, pctAbove200d: 500 });
  });

  it('rounds to two decimals and counts a close on the average as not above it', () => {
    const rows = universe(503, (i) => row(`T${i}`, 100, i === 0 ? 100 : i < 179 ? 90 : 110, 90, 90));
    assert.equal(computeBreadth(rows).readings.pctAbove20d, 35.39);
  });

  it('excludes rows whose close or average is missing from that window only', () => {
    const rows = universe(500, (i) => row(`T${i}`, 100, 90, 90, i < 40 ? null : 90));
    const { readings, valid } = computeBreadth(rows);
    assert.equal(valid.pctAbove200d, 460);
    assert.equal(readings.pctAbove200d, 100);
    assert.equal(readings.pctAbove20d, 100);
  });

  it('returns null for a window with fewer valid rows than the S&P 500 floor', () => {
    const rows = universe(MIN_VALID_CONSTITUENTS - 1, (i) => row(`T${i}`, 100, 90, 90, 90));
    assert.deepEqual(computeBreadth(rows).readings, { pctAbove20d: null, pctAbove50d: null, pctAbove200d: null });
  });

  it('returns null readings for an empty scan', () => {
    const { readings, constituents } = computeBreadth([]);
    assert.equal(constituents, 0);
    assert.deepEqual(readings, { pctAbove20d: null, pctAbove50d: null, pctAbove200d: null });
  });
});

describe('fetchSp500Breadth', () => {
  it('scans the S&P 500 symbol set with close and the three averages', async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      const rows = universe(503, (i) => row(`T${i}`, 100, 90, 90, 90));
      return new Response(JSON.stringify({ totalCount: rows.length, data: rows }), { status: 200 });
    };
    const { readings, constituents } = await fetchSp500Breadth({ fetchImpl });
    assert.equal(captured.url, 'https://scanner.tradingview.com/america/scan');
    assert.equal(captured.init.method, 'POST');
    const body = JSON.parse(captured.init.body);
    assert.deepEqual(body.symbols, { symbolset: ['SYML:SP;SPX'] });
    assert.deepEqual(body.columns, ['name', 'close', 'SMA20', 'SMA50', 'SMA200']);
    assert.equal(constituents, 503);
    assert.deepEqual(readings, { pctAbove20d: 100, pctAbove50d: 100, pctAbove200d: 100 });
  });

  it('rejects a bot-challenge page instead of reading it as three missing values', async () => {
    const fetchImpl = async () => new Response(WAF_CHALLENGE_HTML, { status: 202, headers: { 'content-type': 'text/html' } });
    await assert.rejects(fetchSp500Breadth({ fetchImpl }), /HTTP 202/);
  });

  it('rejects a 200 whose body is not a scan payload', async () => {
    const fetchImpl = async () => new Response(WAF_CHALLENGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    await assert.rejects(fetchSp500Breadth({ fetchImpl }), /not a scan payload/);
  });

  it('rejects a non-2xx status', async () => {
    const fetchImpl = async () => new Response('{"error":"rate limited"}', { status: 429 });
    await assert.rejects(fetchSp500Breadth({ fetchImpl }), /HTTP 429/);
  });
});
