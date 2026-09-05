import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHROME_UA } from '../scripts/_seed-utils.mjs';
import {
  BREADTH_HISTORY_KEY,
  computeBreadth,
  fetchSp500Breadth,
  mergeBreadthHistory,
  MIN_VALID_CONSTITUENTS,
  readBreadthHistory,
  readPublishedPctAbove200d,
  requireCompleteReadings,
} from '../scripts/_sp500-breadth.mjs';

// Scanner row shape: d = [name, close, SMA20, SMA50, SMA200].
function row(name, close, sma20, sma50, sma200) {
  return { s: `NYSE:${name}`, d: [name, close, sma20, sma50, sma200] };
}

function universe(size, build) {
  return Array.from({ length: size }, (_, i) => build(i));
}

function completeReadings() {
  return { pctAbove20d: 20, pctAbove50d: 50, pctAbove200d: 80 };
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

  it('returns null for only the window that falls under the floor', () => {
    const rows = universe(500, (i) => row(`T${i}`, 100, 90, 90, i < 60 ? null : 90));
    const { readings, valid } = computeBreadth(rows);
    assert.equal(valid.pctAbove200d, 440);
    assert.equal(readings.pctAbove200d, null);
    assert.equal(readings.pctAbove20d, 100);
    assert.equal(readings.pctAbove50d, 100);
  });

  it('returns null readings for an empty scan', () => {
    const { readings, constituents } = computeBreadth([]);
    assert.equal(constituents, 0);
    assert.deepEqual(readings, { pctAbove20d: null, pctAbove50d: null, pctAbove200d: null });
  });
});

describe('requireCompleteReadings', () => {
  it('accepts a full three-window reading', () => {
    requireCompleteReadings(completeReadings());
  });

  it('rejects a mixed-null reading so last-good is preserved', () => {
    let err;
    try {
      requireCompleteReadings({ pctAbove20d: 20, pctAbove50d: 50, pctAbove200d: null });
    } catch (caught) {
      err = caught;
    }
    assert.match(err?.message ?? '', /incomplete readings/);
    assert.equal(err.nonRetryable, true);
  });
});

describe('mergeBreadthHistory', () => {
  it('appends a new day and sets current from the last history row', () => {
    const prior = [{ date: '2026-09-01', ...completeReadings() }];
    const nextReadings = { pctAbove20d: 30, pctAbove50d: 40, pctAbove200d: 70 };
    const { history, current, updatedExisting } = mergeBreadthHistory(prior, nextReadings, '2026-09-05');
    assert.equal(updatedExisting, false);
    assert.equal(history.length, 2);
    assert.deepEqual(history.at(-1), { date: '2026-09-05', ...nextReadings });
    assert.deepEqual(current, nextReadings);
    assert.deepEqual(prior[0], { date: '2026-09-01', ...completeReadings() });
  });

  it('overwrites the same-day row and keeps current aligned with history[-1]', () => {
    const prior = [{ date: '2026-09-05', ...completeReadings() }];
    const nextReadings = { pctAbove20d: 21, pctAbove50d: 51, pctAbove200d: 81 };
    const { history, current, updatedExisting } = mergeBreadthHistory(prior, nextReadings, '2026-09-05');
    assert.equal(updatedExisting, true);
    assert.equal(history.length, 1);
    assert.deepEqual(history[0], { date: '2026-09-05', ...nextReadings });
    assert.deepEqual(current, nextReadings);
  });
});

describe('readBreadthHistory', () => {
  it('returns null for an HTTP 200 empty key', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ result: null }), { status: 200 });
    assert.equal(await readBreadthHistory({ fetchImpl, url: 'https://upstash.example', token: 't' }), null);
  });

  it('throws on a failed GET instead of treating it as empty history', async () => {
    const fetchImpl = async () => new Response('timeout', { status: 503 });
    const err = await readBreadthHistory({ fetchImpl, url: 'https://upstash.example', token: 't' }).then(
      () => null,
      (caught) => caught,
    );
    assert.match(err?.message ?? '', /Breadth history GET HTTP 503/);
    assert.equal(err.nonRetryable, false);
  });

  it('throws when Redis credentials are missing', async () => {
    const err = await readBreadthHistory({ fetchImpl: async () => { throw new Error('should not fetch'); } }).then(
      () => null,
      (caught) => caught,
    );
    assert.match(err?.message ?? '', /Missing UPSTASH/);
    assert.equal(err.nonRetryable, true);
  });
});

describe('readPublishedPctAbove200d', () => {
  it('returns the published current 200d reading', async () => {
    const payload = { current: { pctAbove20d: 20, pctAbove50d: 50, pctAbove200d: 64.07 }, history: [] };
    const fetchImpl = async (url) => {
      assert.match(url, new RegExp(`/get/${encodeURIComponent(BREADTH_HISTORY_KEY)}$`));
      return new Response(JSON.stringify({ result: JSON.stringify(payload) }), { status: 200 });
    };
    assert.equal(await readPublishedPctAbove200d({ fetchImpl, url: 'https://upstash.example', token: 't' }), 64.07);
  });

  it('returns null when the published current 200d is missing', async () => {
    const payload = { current: { pctAbove20d: 20, pctAbove50d: 50, pctAbove200d: null }, history: [] };
    const fetchImpl = async () => new Response(JSON.stringify({ result: JSON.stringify(payload) }), { status: 200 });
    assert.equal(await readPublishedPctAbove200d({ fetchImpl, url: 'https://upstash.example', token: 't' }), null);
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
    assert.equal(captured.init.headers['User-Agent'], CHROME_UA);
    const body = JSON.parse(captured.init.body);
    assert.deepEqual(body.symbols, { symbolset: ['SYML:SP;SPX'] });
    assert.deepEqual(body.columns, ['name', 'close', 'SMA20', 'SMA50', 'SMA200']);
    assert.deepEqual(body.range, [0, 1000]);
    assert.equal(constituents, 503);
    assert.deepEqual(readings, { pctAbove20d: 100, pctAbove50d: 100, pctAbove200d: 100 });
  });

  async function rejected(run) {
    return run().then(
      () => null,
      (caught) => caught,
    );
  }

  it('rejects a bot-challenge page instead of reading it as three missing values', async () => {
    const fetchImpl = async () => new Response(WAF_CHALLENGE_HTML, { status: 202, headers: { 'content-type': 'text/html' } });
    const err = await rejected(() => fetchSp500Breadth({ fetchImpl }));
    assert.match(err?.message ?? '', /HTTP 202/);
    assert.equal(err.nonRetryable, true);
  });

  it('rejects a 200 whose body is not a scan payload', async () => {
    const fetchImpl = async () => new Response(WAF_CHALLENGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    const err = await rejected(() => fetchSp500Breadth({ fetchImpl }));
    assert.match(err?.message ?? '', /not a scan payload/);
    assert.equal(err.nonRetryable, true);
  });

  it('rejects a retryable non-2xx without marking it permanent', async () => {
    const fetchImpl = async () => new Response('{"error":"rate limited"}', { status: 429 });
    const err = await rejected(() => fetchSp500Breadth({ fetchImpl }));
    assert.match(err?.message ?? '', /HTTP 429/);
    assert.equal(err.nonRetryable, false);
  });

  it('rejects a truncated page whose totalCount disagrees with data.length', async () => {
    const rows = universe(460, (i) => row(`T${i}`, 100, 90, 90, 90));
    const fetchImpl = async () => new Response(JSON.stringify({ totalCount: 503, data: rows }), { status: 200 });
    const err = await rejected(() => fetchSp500Breadth({ fetchImpl }));
    assert.match(err?.message ?? '', /truncated/);
    assert.equal(err.nonRetryable, true);
  });
});
