import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  SPARKLINE_INTERVAL_SECONDS,
  SPARKLINE_WINDOW_SECONDS,
  SPARKLINE_HISTORY_QUERY,
  buildQuoteSparkline,
} = require('../scripts/shared/quote-sparkline.cjs');

const MINUTE = 60;
const T0 = Date.UTC(2026, 10, 10, 4, 0, 0) / 1000;

function chart(timestamps, closes, granularity = '1m') {
  return {
    chart: {
      result: [{
        meta: { regularMarketPrice: closes.at(-1), dataGranularity: granularity },
        timestamp: timestamps,
        indicators: { quote: [{ close: closes }] },
      }],
    },
  };
}

function minuteChart(start, closes) {
  return chart(closes.map((_, i) => start + i * MINUTE), closes);
}

function wobble(n, base, step = 0.01) {
  return Array.from({ length: n }, (_, i) => +(base + ((i % 4) - 1.5) * step).toFixed(4));
}

describe('buildQuoteSparkline', () => {
  it('drops the 94.93 / 98.32 / 94.80 Brent bad tick', () => {
    const closes = [...wobble(20, 94.9), 94.93, 98.32, 94.80, ...wobble(20, 94.8)];
    const { sparkline } = buildQuoteSparkline(minuteChart(T0, closes), null);
    assert.ok(sparkline.length > 0, 'series built');
    assert.ok(!sparkline.includes(98.32), `spike removed: ${sparkline.join(',')}`);
    assert.ok(Math.max(...sparkline) < 95, 'no point near the spike survives');
  });

  it('keeps a level shift that persists', () => {
    const closes = [...wobble(30, 94.9), 98.32, ...wobble(30, 98.3)];
    const { sparkline } = buildQuoteSparkline(minuteChart(T0, closes), null);
    assert.ok(Math.max(...sparkline) > 98, 'new level kept');
    assert.ok(Math.min(...sparkline) < 95, 'old level kept');
  });

  it('keeps a jump across a trading gap even when the next print reverts', () => {
    const before = wobble(20, 94.9);
    const ts = [
      ...before.map((_, i) => T0 + i * MINUTE),
      T0 + 3 * 3600 + 4 * MINUTE,
      T0 + 3 * 3600 + 5 * MINUTE,
      ...wobble(10, 94.9).map((_, i) => T0 + 3 * 3600 + (i + 6) * MINUTE),
    ];
    const closes = [...before, 98.32, 94.9, ...wobble(10, 94.9)];
    const { sparkline } = buildQuoteSparkline(chart(ts, closes), null);
    assert.ok(sparkline.includes(98.32), 'gap open kept');
  });

  it('labels the series with its bar width and first bar time', () => {
    const closes = wobble(60, 50);
    const out = buildQuoteSparkline(minuteChart(T0, closes), null);
    assert.equal(out.sparklineIntervalSeconds, SPARKLINE_INTERVAL_SECONDS);
    assert.equal(out.sparklineStartAt, T0 * 1000);
    assert.equal(out.sparkline.length, 60 * MINUTE / SPARKLINE_INTERVAL_SECONDS);
    assert.equal(out.sparkline.at(-1), closes.at(-1), 'last point is the last print');
  });

  it('spans the same 24 hours at session start as late in the day', () => {
    const historyStart = T0 - 30 * 3600;
    const historyTs = Array.from({ length: 30 * 12 }, (_, i) => historyStart + i * 300);
    const history = chart(historyTs, historyTs.map((_, i) => 90 + (i % 7) * 0.01), '5m');
    const earlyToday = minuteChart(T0, wobble(53, 91));
    const lateToday = minuteChart(T0, wobble(600, 91));

    const early = buildQuoteSparkline(earlyToday, history);
    const late = buildQuoteSparkline(lateToday, history);
    const span = (out, today) => {
      const ts = today.chart.result[0].timestamp;
      const lastBar = Math.floor(ts.at(-1) / 300) * 300;
      return lastBar - out.sparklineStartAt / 1000 + SPARKLINE_INTERVAL_SECONDS;
    };
    assert.equal(span(early, earlyToday), SPARKLINE_WINDOW_SECONDS);
    assert.equal(span(late, lateToday), SPARKLINE_WINDOW_SECONDS);
    assert.equal(early.sparkline.length, SPARKLINE_WINDOW_SECONDS / SPARKLINE_INTERVAL_SECONDS);
  });

  it('leaves closed-market bars out instead of drawing a flat line', () => {
    const session1 = Array.from({ length: 60 }, (_, i) => T0 + i * MINUTE);
    const session2 = Array.from({ length: 60 }, (_, i) => T0 + 10 * 3600 + i * MINUTE);
    const ts = [...session1, ...session2];
    const out = buildQuoteSparkline(chart(ts, ts.map((_, i) => 10 + (i % 3) * 0.01)), null);
    assert.equal(out.sparkline.length, 24, 'two one-hour sessions, twelve 5-minute bars each');
  });

  it('builds the window from history alone when today has no bars yet', () => {
    const historyTs = Array.from({ length: 12 * 30 }, (_, i) => T0 - 30 * 3600 + i * 300);
    const history = chart(historyTs, historyTs.map(() => 70), '5m');
    const out = buildQuoteSparkline(chart([], []), history);
    assert.equal(out.sparkline.length, SPARKLINE_WINDOW_SECONDS / SPARKLINE_INTERVAL_SECONDS);
    assert.equal(out.sparklineStartAt / 1000, historyTs.at(-1) - SPARKLINE_WINDOW_SECONDS + SPARKLINE_INTERVAL_SECONDS);
  });

  it('returns an unlabeled empty series when there are no bars', () => {
    assert.deepEqual(buildQuoteSparkline(chart([], []), null), { sparkline: [] });
    assert.deepEqual(buildQuoteSparkline(null, null), { sparkline: [] });
  });
});

describe('commodity seeders publish the 24-hour sparkline', () => {
  const today = minuteChart(T0, wobble(53, 91));
  const historyTs = Array.from({ length: 30 * 12 }, (_, i) => T0 - 30 * 3600 + i * 300);
  const history = chart(historyTs, historyTs.map(() => 90.5), '5m');
  today.chart.result[0].meta.regularMarketTime = T0 + 52 * MINUTE;
  today.chart.result[0].meta.chartPreviousClose = 90;

  it('the cron path fetches the history chart and labels the series', async () => {
    const { fetchYahooQuoteChart } = await import('../scripts/_yahoo-fetch.mjs');
    const urls = [];
    const fetchJson = async (url) => {
      urls.push(url);
      return structuredClone(url.endsWith(SPARKLINE_HISTORY_QUERY) ? history : today);
    };
    const quote = await fetchYahooQuoteChart('BZ=F', { fetchJson, delayMs: 0, sparklineWindow: true });
    assert.equal(urls.length, 2);
    assert.equal(quote.sparkline.length, SPARKLINE_WINDOW_SECONDS / SPARKLINE_INTERVAL_SECONDS);
    assert.equal(quote.sparklineIntervalSeconds, SPARKLINE_INTERVAL_SECONDS);
    assert.ok(Number.isFinite(quote.sparklineStartAt));
  });

  it('the cron path keeps the quote and labels today\'s bars when the history request fails', async () => {
    const { fetchYahooQuoteChart } = await import('../scripts/_yahoo-fetch.mjs');
    const fetchJson = async (url) => {
      if (url.endsWith(SPARKLINE_HISTORY_QUERY)) throw new Error('HTTP 429');
      return structuredClone(today);
    };
    const quote = await fetchYahooQuoteChart('BZ=F', { fetchJson, delayMs: 0, sparklineWindow: true });
    assert.equal(quote.price, today.chart.result[0].meta.regularMarketPrice);
    assert.equal(quote.sparklineStartAt, T0 * 1000);
  });

  it('the stock path stays on one request and the raw series', async () => {
    const { fetchYahooQuoteChart } = await import('../scripts/_yahoo-fetch.mjs');
    const urls = [];
    const fetchJson = async (url) => { urls.push(url); return structuredClone(today); };
    const quote = await fetchYahooQuoteChart('AAPL', { fetchJson, delayMs: 0 });
    assert.equal(urls.length, 1);
    assert.equal(quote.sparklineStartAt, undefined);
  });

  it('the relay fetches history once per session, not every cycle', async () => {
    const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    const start = source.indexOf('const _sparklineHistories');
    const end = source.indexOf('function fetchYahooChartDirect(');
    assert.ok(start > 0 && end > start, 'relay sparkline helper found');
    const calls = [];
    const fetchOnce = async (symbol, query) => { calls.push(query); return { chart: structuredClone(history) }; };
    const commoditySparkline = Function(
      '_fetchYahooChartOnce', 'sleep', 'SPARKLINE_HISTORY_QUERY', 'buildQuoteSparkline',
      `${source.slice(start, end)}\nreturn _commoditySparkline;`,
    )(fetchOnce, async () => {}, SPARKLINE_HISTORY_QUERY, buildQuoteSparkline);

    const first = await commoditySparkline('BZ=F', { chart: today, lastTradeAt: T0 + 52 * MINUTE });
    await commoditySparkline('BZ=F', { chart: today, lastTradeAt: T0 + 57 * MINUTE });
    assert.deepEqual(calls, [SPARKLINE_HISTORY_QUERY]);
    assert.equal(first.sparkline.length, SPARKLINE_WINDOW_SECONDS / SPARKLINE_INTERVAL_SECONDS);
    assert.equal(first.sparklineIntervalSeconds, SPARKLINE_INTERVAL_SECONDS);

    const nextDay = minuteChart(T0 + 86400, wobble(10, 92));
    await commoditySparkline('BZ=F', { chart: nextDay, lastTradeAt: T0 + 86400 + 9 * MINUTE });
    assert.equal(calls.length, 2, 'a new session refetches history');
  });
});
