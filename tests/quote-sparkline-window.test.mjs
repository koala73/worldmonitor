import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  SPARKLINE_INTERVAL_SECONDS,
  SPARKLINE_WINDOW_SECONDS,
  SPARKLINE_HISTORY_QUERY,
  SPARKLINE_HISTORY_RETRY_SECONDS,
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
  it('drops the 94.93 / 98.32 / 94.80 Brent bad tick when it is a 5-minute close', () => {
    // 98.32 is bar 24, the last minute of its 5-minute bucket, so bucketing alone keeps it.
    const closes = [...wobble(23, 94.9), 94.93, 98.32, 94.80, ...wobble(20, 94.8)];
    assert.equal((T0 + closes.indexOf(98.32) * MINUTE) % SPARKLINE_INTERVAL_SECONDS, 4 * MINUTE);
    const { sparkline } = buildQuoteSparkline(minuteChart(T0, closes), null);
    assert.ok(sparkline.length > 0, 'series built');
    assert.ok(!sparkline.includes(98.32), `spike removed: ${sparkline.join(',')}`);
    assert.ok(Math.max(...sparkline) < 95, 'no point near the spike survives');
    assert.equal(sparkline.length, Math.ceil(closes.length / 5), 'the spike\'s bucket keeps a clean close instead of being dropped');
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

  it('keeps the previous session 30 minutes after a Monday 23:00 UTC open', () => {
    // Brent-like day: the session opens 23:00 UTC and trades 23 hours with a
    // one-hour break, so the previous session is Sun 23:00 to Mon 22:00 UTC.
    const prevOpen = Date.UTC(2026, 10, 8, 23, 0, 0) / 1000;
    const prevTs = Array.from({ length: 23 * 12 }, (_, i) => prevOpen + i * 300);
    const history = chart(prevTs, prevTs.map((_, i) => 64 + (i % 5) * 0.01), '5m');
    const open = Date.UTC(2026, 10, 9, 23, 0, 0) / 1000;
    const todayCloses = wobble(30, 64.2);
    const today = minuteChart(open, todayCloses); // Mon 23:00 to 23:29 UTC

    const out = buildQuoteSparkline(today, history);
    // History holding only the previous session: 276 bars plus 6 from the new
    // one, all of them, not the 276 that fit in 24 wall-clock hours.
    assert.equal(out.sparkline.length, 23 * 12 + 6);
    assert.equal(out.sparklineStartAt / 1000, prevOpen, 'starts at the previous session open');
    assert.equal(out.sparkline.at(-1), todayCloses.at(-1), 'ends at the last print of the new session');

    // Yahoo's 3-day chart at Mon 23:30 UTC also holds Friday (Thu 23:00 to
    // Fri 22:00 UTC). The last 6 Friday bars complete the 288.
    const fridayOpen = Date.UTC(2026, 10, 5, 23, 0, 0) / 1000;
    const fridayTs = Array.from({ length: 23 * 12 }, (_, i) => fridayOpen + i * 300);
    const fullHistory = chart([...fridayTs, ...prevTs], [...fridayTs.map(() => 63.9), ...prevTs.map(() => 64)], '5m');
    const real = buildQuoteSparkline(today, fullHistory);
    assert.equal(real.sparkline.length, SPARKLINE_WINDOW_SECONDS / SPARKLINE_INTERVAL_SECONDS);
    assert.equal(real.sparklineStartAt, Date.UTC(2026, 10, 6, 21, 30), 'starts at Fri 21:30 UTC');

    // A full 24-hour previous session (FX) caps the series at 288 bars.
    const fxTs = Array.from({ length: 24 * 12 }, (_, i) => prevOpen + i * 300);
    const fx = buildQuoteSparkline(today, chart(fxTs, fxTs.map(() => 64), '5m'));
    assert.equal(fx.sparkline.length, SPARKLINE_WINDOW_SECONDS / SPARKLINE_INTERVAL_SECONDS);
    assert.equal(fx.sparklineStartAt / 1000, prevOpen + 6 * 300, '24 traded hours back from the last bar');
  });

  it('reaches back to Friday when the market reopens on Sunday evening', () => {
    const fridayOpen = Date.UTC(2026, 10, 5, 23, 0, 0) / 1000; // Thu 23:00 to Fri 22:00 UTC
    const fridayTs = Array.from({ length: 23 * 12 }, (_, i) => fridayOpen + i * 300);
    const history = chart(fridayTs, fridayTs.map(() => 63), '5m');
    const sundayOpen = Date.UTC(2026, 10, 8, 23, 0, 0) / 1000;
    const out = buildQuoteSparkline(minuteChart(sundayOpen, wobble(30, 63.5)), history);
    assert.equal(out.sparkline.length, 23 * 12 + 6, 'not the 6 bars since the reopen');
    assert.equal(out.sparklineStartAt / 1000, fridayOpen);
  });

  it('keeps every bar of a thin contract that trades less than 24 hours in the history window', () => {
    const prevTs = Array.from({ length: 36 }, (_, i) => Date.UTC(2026, 10, 9, 8, 0, 0) / 1000 + i * 300);
    const history = chart(prevTs, prevTs.map(() => 30), '5m');
    const today = minuteChart(Date.UTC(2026, 10, 10, 8, 0, 0) / 1000, wobble(10, 31));
    const out = buildQuoteSparkline(today, history);
    assert.equal(out.sparkline.length, 36 + 2);
    assert.equal(out.sparklineStartAt / 1000, prevTs[0], 'start label names the real first bar');
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

  it('asks Yahoo for 3 trading days so a Sunday reopen still reaches Thursday evening', () => {
    // Yahoo cuts the chart at New York midnight and counts Sunday's evening
    // session as a day. At Sun 23:30 UTC, range=2d is Friday from 05:00 UTC
    // plus Sunday; range=3d adds Thursday, whose evening opens Friday's session.
    assert.equal(SPARKLINE_HISTORY_QUERY, '?range=3d&interval=5m');
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
      '_fetchYahooChartOnce', 'sleep', 'SPARKLINE_HISTORY_QUERY', 'SPARKLINE_HISTORY_RETRY_SECONDS', 'buildQuoteSparkline', 'logThrottled',
      `${source.slice(start, end)}\nreturn _commoditySparkline;`,
    )(fetchOnce, async () => {}, SPARKLINE_HISTORY_QUERY, SPARKLINE_HISTORY_RETRY_SECONDS, buildQuoteSparkline, () => {});

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

describe('bad ticks on thin and boundary bars', () => {
  it('drops a bad tick on a contract that skips minutes', () => {
    const ts = [];
    const closes = [];
    for (let i = 0; i < 40; i += 1) {
      if (i > 16 && i < 24 && i !== 19) continue;
      ts.push(T0 + i * MINUTE);
      closes.push(i === 19 ? 98.32 : 94.9);
    }
    const { sparkline } = buildQuoteSparkline(chart(ts, closes), null);
    assert.ok(!sparkline.includes(98.32), 'spike between sparse prints removed');
  });

  it('drops a bad tick on the first bar of today\'s chart', () => {
    const historyTs = Array.from({ length: 12 * 30 }, (_, i) => T0 - 30 * 3600 + i * 300);
    const history = chart(historyTs, historyTs.map(() => 94.9), '5m');
    const todayCloses = [98.32, ...wobble(40, 94.9)];
    const today = minuteChart(T0, todayCloses);
    today.chart.result[0].timestamp[0] = T0 + 4 * MINUTE;
    for (let i = 1; i < todayCloses.length; i += 1) today.chart.result[0].timestamp[i] = T0 + (i + 4) * MINUTE;
    const { sparkline } = buildQuoteSparkline(today, history);
    assert.ok(!sparkline.includes(98.32), 'spike at the history boundary removed');
  });
});

describe('island prints on thin contracts', () => {
  // CT=F on 2026-11-10, as Yahoo served it: a zero-volume 82.37 print three
  // hours from 78.76 (the day before) and 78.39. Yahoo's daily high was 79.90.
  const at = (day, hh, mm) => Date.UTC(2026, 10, day, hh, mm) / 1000;
  const history = chart(
    [at(9, 8, 20), at(9, 13, 15), at(9, 13, 20), at(9, 16, 20), at(10, 10, 15), at(10, 13, 20), at(10, 16, 20)],
    [79.27, 79.19, 79.14, 78.76, 82.37, 78.39, 78.27],
    '5m',
  );

  it('drops a print with a trading gap on both sides that jumps and reverts', () => {
    const today = chart([at(10, 10, 16), at(10, 13, 20), at(10, 16, 20), at(10, 16, 30)], [82.37, 78.39, 78.27, 78.28]);
    const out = buildQuoteSparkline(today, history);
    // Fewer than 288 traded bars in the history window, so Monday's bars stay
    // (#10424); the island print is still removed.
    assert.deepEqual(out.sparkline, [79.27, 79.19, 79.14, 78.76, 78.39, 78.27, 78.28], 'island print removed, the window keeps the rest');
    assert.equal(out.sparklineStartAt, at(9, 8, 20) * 1000, 'the series starts at the first kept close');
  });

  it('keeps an island print when the next print holds the move', () => {
    const today = chart([at(10, 10, 16), at(10, 13, 20), at(10, 16, 20)], [82.37, 82.1, 82.2]);
    const { sparkline } = buildQuoteSparkline(today, history);
    assert.ok(sparkline.includes(82.37), 'move that holds kept');
  });
});

describe('stale-quote dips', () => {
  function liveFx(name) {
    return JSON.parse(readFileSync(new URL(`./fixtures/${name}-5m-2026-11-11.json`, import.meta.url), 'utf8'));
  }

  function replay(fixture) {
    return buildQuoteSparkline(chart(fixture.close.map((_, i) => fixture.sparklineStartAt / 1000 + i * 300), fixture.close, '5m'), null).sparkline;
  }

  function largestLoneShare(values) {
    const range = Math.max(...values) - Math.min(...values);
    if (!range) return 0;
    return Math.max(0, ...values.slice(1, -1).map((v, i) => {
      const up = v - values[i];
      const down = v - values[i + 2];
      return Math.sign(up) === Math.sign(down) ? Math.min(Math.abs(up), Math.abs(down)) / range : 0;
    }));
  }

  for (const [name, dip] of [['usdtry', 50.131], ['usdcny', 6.6696]]) {
    it(`drops the live ${name} ${dip} lone point below 0.2% and keeps the last close`, () => {
      const fixture = liveFx(name);
      assert.ok(fixture.close.includes(dip), 'fixture contains the reported point');
      const values = replay(fixture);
      assert.equal(values.filter((v) => v === dip).length, fixture.close.filter((v) => v === dip).length - 1, `${dip} lone point removed; any sustained occurrence kept`);
      assert.equal(values.at(-1), fixture.close.at(-1));
      assert.ok(largestLoneShare(values) < 0.5, 'no unconfirmed point dominates the autoscaled range');
    });
  }

  it('keeps every close of a sustained 0.4% FX move on both input intervals', () => {
    const values = [...wobble(40, 50, 0.001), 50.05, 50.10, 50.15, ...wobble(40, 50.20, 0.001)];
    for (const interval of [60, 300]) {
      const timestamps = values.map((_, i) => T0 + i * interval);
      const expected = interval === 300 ? values : values.filter((_, i) => i % 5 === 4 || i === values.length - 1);
      assert.deepEqual(buildQuoteSparkline(chart(timestamps, values), null).sparkline, expected);
    }
  });

  it('keeps small reversals when a short tape cannot calibrate volatility', () => {
    for (const values of [[50, 50.01, 50], [50, 50.01, 50, 50], [50, 50, 50.01, 50, 50]]) {
      assert.deepEqual(buildQuoteSparkline(chart(values.map((_, i) => T0 + i * 300), values, '5m'), null).sparkline, values);
    }
  });

  it('filters five-minute closes before taking the last 288 points', () => {
    const values = Array.from({ length: 310 * 5 }, () => 50);
    // A two-minute trough survives the minute pass. Its deeper point closes
    // the bucket at index 22, the first point after an unfiltered 288 cut.
    values[22 * 5 + 3] = 49.6;
    values[22 * 5 + 4] = 49.5;
    const out = buildQuoteSparkline(minuteChart(T0, values), null);
    assert.deepEqual(out.sparkline, Array(288).fill(50));
    assert.equal(out.sparklineStartAt, (T0 + 22 * 300) * 1000, 'the removed close is replaced, so the window still starts 288 buckets back');
  });

  it('drops the two-bar USDTRY dips that land on 5-minute closes (live tape, 2026-11-10)', () => {
    // 50.207 then 50.113: each bar is under the 0.2% floor against its neighbour,
    // but the 50.113 bar closes its 5-minute bucket, 0.23% under the tape.
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/usdtry-1m-2026-11-10.json', import.meta.url), 'utf8'));
    const { sparkline } = buildQuoteSparkline(chart(fixture.timestamp, fixture.close), null);
    assert.equal(sparkline.length, 42, '42 five-minute closes, two of them dips replaced in place');
    assert.ok(Math.min(...sparkline) > 50.2, `dips removed: ${Math.min(...sparkline)}`);
    assert.equal(sparkline.at(-1), fixture.close.at(-1), 'last point is the last print');
  });

  it('drops the recurring one-minute USDTRY print 0.23% under the tape', () => {
    const closes = [];
    for (let i = 0; i < 120; i += 1) closes.push(i % 20 === 9 ? 50.1119 : +(50.225 + ((i % 3) - 1) * 0.003).toFixed(4));
    const { sparkline } = buildQuoteSparkline(minuteChart(T0, closes), null);
    assert.ok(Math.min(...sparkline) > 50.2, `stale prints removed: ${Math.min(...sparkline)}`);
  });
});

describe('cotton raw bars and revised history, 2026-11-09 through 11', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/cotton-bars-2026-11-09-11.json', import.meta.url), 'utf8'));
  const wrap = (result) => ({ chart: { result: [result] } });

  it('removes the cached two-print island and keeps the sustained November 11 level', () => {
    const { sparkline } = buildQuoteSparkline(wrap(fixture.recent), wrap(fixture.cachedHistory));
    const expected = [79.27, 79.19, 79.14, 78.76, 78.39, 78.27, 82.72, 82.55, 82.58, 82.64, 82.35];
    assert.deepEqual(sparkline.map((v) => +v.toFixed(2)), expected);
  });

  it('removes the zero-volume November 10 island from raw minute and fresh five-minute bars', () => {
    for (const result of [fixture.raw, fixture.history]) {
      const { sparkline } = buildQuoteSparkline(wrap(result), null);
      assert.ok(!sparkline.some((v) => Math.abs(v - 82.37) < 0.001));
      assert.ok(sparkline.some((v) => Math.abs(v - 82.55) < 0.001), 'later confirmed level kept');
      assert.equal(sparkline.at(-1), result.indicators.quote[0].close.at(-1));
    }
  });

  it('keeps two confirming liquid-market closes and an unconfirmed final sparse pair', () => {
    const values = [...wobble(40, 50, 0.001), 50.2, 50.21, ...wobble(40, 50, 0.001)];
    assert.deepEqual(buildQuoteSparkline(chart(values.map((_, i) => T0 + i * 300), values), null).sparkline, values);
    const sparse = [79.27, 79.19, 79.14, 78.76, 82.72, 82.37];
    assert.deepEqual(buildQuoteSparkline(chart(sparse.map((_, i) => T0 + i * 3600), sparse), null).sparkline, sparse);
  });

  it('keeps non-clustered sparse two-print reversals before considering singletons', () => {
    for (const values of [[78, 78, 78, 82, 79, 78, 78, 78], [82, 82, 82, 78, 81, 82, 82, 82]]) {
      assert.deepEqual(buildQuoteSparkline(chart(values.map((_, i) => T0 + i * 3600), values), null).sparkline, values);
    }
  });

  it('keeps actual trading gaps across bucketing for sparse pair decisions', () => {
    for (const values of [[78, 82, 79, 78, 78, 78, 78, 78], [82, 78, 81, 82, 82, 82, 82, 82]]) {
      for (let minute = 0; minute < 5; minute += 1) {
        const out = buildQuoteSparkline(chart(values.map((_, i) => T0 + minute * 60 + i * 16 * 60), values), null);
        assert.deepEqual(out.sparkline, values, `bucket phase ${minute}`);
        assert.equal(out.sparklineStartAt, T0 * 1000, 'label remains bucket-aligned');
      }
    }
  });
});

describe('adaptive FX filtering reaches both commodity writers', () => {
  it('the cron and relay publish the same filtered live USDTRY series', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/usdtry-5m-2026-11-11.json', import.meta.url), 'utf8'));
    const today = chart(fixture.close.map((_, i) => fixture.sparklineStartAt / 1000 + i * 300), fixture.close, '5m');
    today.chart.result[0].meta.regularMarketTime = today.chart.result[0].timestamp.at(-1);
    today.chart.result[0].meta.chartPreviousClose = fixture.close[0];
    const history = chart([], []);
    const { fetchYahooQuoteChart } = await import('../scripts/_yahoo-fetch.mjs');
    const cron = await fetchYahooQuoteChart('USDTRY=X', {
      fetchJson: async (url) => structuredClone(url.endsWith(SPARKLINE_HISTORY_QUERY) ? history : today),
      delayMs: 0, sparklineWindow: true,
    });
    const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    const start = source.indexOf('const _sparklineHistories');
    const end = source.indexOf('function fetchYahooChartDirect(');
    assert.ok(start > 0 && end > start);
    const commoditySparkline = Function(
      '_fetchYahooChartOnce', 'sleep', 'SPARKLINE_HISTORY_QUERY', 'SPARKLINE_HISTORY_RETRY_SECONDS', 'buildQuoteSparkline', 'logThrottled',
      `${source.slice(start, end)}\nreturn _commoditySparkline;`,
    )(async () => ({ chart: history }), async () => {}, SPARKLINE_HISTORY_QUERY, SPARKLINE_HISTORY_RETRY_SECONDS, buildQuoteSparkline, () => {});
    const relay = await commoditySparkline('USDTRY=X', { chart: today, lastTradeAt: today.chart.result[0].meta.regularMarketTime });
    assert.deepEqual(cron.sparkline, relay.sparkline);
    assert.ok(!cron.sparkline.includes(50.131));
    assert.equal(cron.sparkline.at(-1), fixture.close.at(-1));
  });
});

describe('the cron seeder caches the history chart per session', () => {
  const historyTs = Array.from({ length: 30 * 12 }, (_, i) => T0 - 30 * 3600 + i * 300);
  const history = chart(historyTs, historyTs.map((_, i) => 90 + (i % 5) * 0.01), '5m');

  function todayFrom(start) {
    const today = minuteChart(start, wobble(53, 91));
    today.chart.result[0].meta.regularMarketTime = start + 52 * MINUTE;
    today.chart.result[0].meta.chartPreviousClose = 90;
    return today;
  }

  function fakeRedis() {
    const store = new Map();
    return async ([verb, key, value]) => {
      if (verb === 'GET') return { result: store.get(key) ?? null };
      store.set(key, value);
      return { result: 'OK' };
    };
  }

  it('makes the history request once per symbol per session across runs', async () => {
    const { fetchYahooQuoteChart, createSparklineHistoryCache } = await import('../scripts/_yahoo-fetch.mjs');
    const historyCache = createSparklineHistoryCache(fakeRedis(), 'test:history:');
    let today = todayFrom(T0);
    const urls = [];
    const fetchJson = async (url) => {
      urls.push(url);
      return structuredClone(url.endsWith(SPARKLINE_HISTORY_QUERY) ? history : today);
    };
    const run = () => fetchYahooQuoteChart('BZ=F', { fetchJson, delayMs: 0, sparklineWindow: true, historyCache });
    const historyRequests = () => urls.filter((u) => u.endsWith(SPARKLINE_HISTORY_QUERY)).length;

    const first = await run();
    const second = await run();
    assert.equal(historyRequests(), 1, 'second run reads the cached history');
    assert.deepEqual(second.sparkline, first.sparkline, 'cached history builds the same series');
    assert.equal(second.sparklineStartAt, first.sparklineStartAt);

    today = todayFrom(T0 + 86400);
    await run();
    assert.equal(historyRequests(), 2, 'a new session refetches history');
  });

  it('still publishes the quote when Redis is down', async () => {
    const { fetchYahooQuoteChart, createSparklineHistoryCache } = await import('../scripts/_yahoo-fetch.mjs');
    const historyCache = createSparklineHistoryCache(async () => { throw new Error('ECONNRESET'); }, 'test:history:');
    const today = todayFrom(T0);
    const fetchJson = async (url) => structuredClone(url.endsWith(SPARKLINE_HISTORY_QUERY) ? history : today);
    const quote = await fetchYahooQuoteChart('BZ=F', { fetchJson, delayMs: 0, sparklineWindow: true, historyCache });
    assert.equal(quote.sparkline.length, SPARKLINE_WINDOW_SECONDS / SPARKLINE_INTERVAL_SECONDS);
  });
});

describe('history caches need a session to key on', () => {
  const historyTs = Array.from({ length: 30 * 12 }, (_, i) => T0 - 30 * 3600 + i * 300);
  const history = chart(historyTs, historyTs.map(() => 90.5), '5m');
  const undated = () => {
    const c = chart([], []);
    c.chart.result[0].meta = { regularMarketPrice: 91, chartPreviousClose: 90 };
    return c;
  };

  it('the cron path never serves cached history when the chart has no session time', async () => {
    const { fetchYahooQuoteChart, createSparklineHistoryCache } = await import('../scripts/_yahoo-fetch.mjs');
    const store = new Map();
    const historyCache = createSparklineHistoryCache(async ([verb, key, value]) => {
      if (verb === 'GET') return { result: store.get(key) ?? null };
      store.set(key, value);
      return { result: 'OK' };
    }, 'test:history:');
    const urls = [];
    const fetchJson = async (url) => { urls.push(url); return structuredClone(url.endsWith(SPARKLINE_HISTORY_QUERY) ? history : undated()); };
    await fetchYahooQuoteChart('BZ=F', { fetchJson, delayMs: 0, sparklineWindow: true, historyCache });
    await fetchYahooQuoteChart('BZ=F', { fetchJson, delayMs: 0, sparklineWindow: true, historyCache });
    assert.equal(urls.filter((u) => u.endsWith(SPARKLINE_HISTORY_QUERY)).length, 2);
    assert.equal(store.size, 0, 'nothing cached under an undefined session');
  });

  it('the relay never reuses history when the quote has no session time', async () => {
    const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    const start = source.indexOf('const _sparklineHistories');
    const end = source.indexOf('function fetchYahooChartDirect(');
    const calls = [];
    const commoditySparkline = Function(
      '_fetchYahooChartOnce', 'sleep', 'SPARKLINE_HISTORY_QUERY', 'SPARKLINE_HISTORY_RETRY_SECONDS', 'buildQuoteSparkline', 'logThrottled',
      `${source.slice(start, end)}\nreturn _commoditySparkline;`,
    )(async (_s, q) => { calls.push(q); return { chart: structuredClone(history) }; }, async () => {}, SPARKLINE_HISTORY_QUERY, SPARKLINE_HISTORY_RETRY_SECONDS, buildQuoteSparkline, () => {});
    await commoditySparkline('BZ=F', { chart: undated(), lastTradeAt: undefined });
    await commoditySparkline('BZ=F', { chart: undated(), lastTradeAt: undefined });
    assert.equal(calls.length, 2);
  });
});

describe('a failed history request backs off instead of retrying every cycle', () => {
  const historyTs = Array.from({ length: 30 * 12 }, (_, i) => T0 - 30 * 3600 + i * 300);
  const history = chart(historyTs, historyTs.map(() => 90.5), '5m');
  const today = minuteChart(T0, wobble(53, 91));
  today.chart.result[0].meta.regularMarketTime = T0 + 52 * MINUTE;
  today.chart.result[0].meta.chartPreviousClose = 90;

  it('the cron path skips the history request for a while after Yahoo refuses it', async () => {
    const { fetchYahooQuoteChart, createSparklineHistoryCache } = await import('../scripts/_yahoo-fetch.mjs');
    const store = new Map();
    const ttls = new Map();
    const historyCache = createSparklineHistoryCache(async ([verb, key, value, ex, seconds]) => {
      if (verb === 'GET') return { result: store.get(key) ?? null };
      store.set(key, value);
      if (ex === 'EX') ttls.set(key, seconds);
      return { result: 'OK' };
    }, 'test:history:');
    let refuse = true;
    const urls = [];
    const fetchJson = async (url) => {
      urls.push(url);
      if (url.endsWith(SPARKLINE_HISTORY_QUERY)) {
        if (refuse) throw new Error('HTTP 429');
        return structuredClone(history);
      }
      return structuredClone(today);
    };
    const run = () => fetchYahooQuoteChart('BZ=F', { fetchJson, delayMs: 0, sparklineWindow: true, historyCache });
    const historyRequests = () => urls.filter((u) => u.endsWith(SPARKLINE_HISTORY_QUERY)).length;

    await run();
    const backedOff = await run();
    assert.equal(historyRequests(), 1, 'the second run does not ask again');
    assert.equal(backedOff.sparklineStartAt, T0 * 1000, 'today\'s bars still publish');
    assert.equal(ttls.get('test:history:BZ=F'), SPARKLINE_HISTORY_RETRY_SECONDS);

    store.clear();
    refuse = false;
    const recovered = await run();
    assert.equal(historyRequests(), 2, 'after the back-off the request is made again');
    assert.equal(recovered.sparkline.length, SPARKLINE_WINDOW_SECONDS / SPARKLINE_INTERVAL_SECONDS);
  });

  it('the relay skips the history request for a while after it fails', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 * 1000 });
    const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    const start = source.indexOf('const _sparklineHistories');
    const end = source.indexOf('function fetchYahooChartDirect(');
    let refuse = true;
    const calls = [];
    const commoditySparkline = Function(
      '_fetchYahooChartOnce', 'sleep', 'SPARKLINE_HISTORY_QUERY', 'SPARKLINE_HISTORY_RETRY_SECONDS', 'buildQuoteSparkline', 'logThrottled',
      `${source.slice(start, end)}\nreturn _commoditySparkline;`,
    )(async (_s, q) => { calls.push(q); return refuse ? null : { chart: structuredClone(history) }; }, async () => {}, SPARKLINE_HISTORY_QUERY, SPARKLINE_HISTORY_RETRY_SECONDS, buildQuoteSparkline, () => {});
    const quote = { chart: today, lastTradeAt: T0 + 52 * MINUTE };

    await commoditySparkline('BZ=F', quote);
    t.mock.timers.tick(5 * MINUTE * 1000);
    const backedOff = await commoditySparkline('BZ=F', quote);
    assert.equal(calls.length, 1, 'the next cycle does not ask again');
    assert.equal(backedOff.sparklineStartAt, T0 * 1000, 'today\'s bars still publish');

    refuse = false;
    t.mock.timers.tick(SPARKLINE_HISTORY_RETRY_SECONDS * 1000);
    const recovered = await commoditySparkline('BZ=F', quote);
    assert.equal(calls.length, 2, 'after the back-off the request is made again');
    assert.equal(recovered.sparkline.length, SPARKLINE_WINDOW_SECONDS / SPARKLINE_INTERVAL_SECONDS);
  });
});

describe('a removed close keeps its place on the time axis', () => {
  const at = (i) => T0 + i * 300;

  it('replaces a dropped dense close with the line between its neighbours', () => {
    const values = wobble(60, 50, 0.001);
    values[30] = 49.5;
    const out = buildQuoteSparkline(chart(values.map((_, i) => at(i)), values, '5m'), null);
    assert.equal(out.sparkline.length, 60, 'later points keep their slot');
    assert.ok(Math.abs(out.sparkline[30] - (values[29] + values[31]) / 2) < 1e-9, 'midpoint of the retained closes');
    assert.equal(out.sparkline[31], values[31], 'the next close is not shifted into the gap');
    assert.equal(out.sparklineStartAt, at(0) * 1000);
  });

  it('interpolates at the removed print\'s own time, not its bucket start', () => {
    // Every print lands 4 minutes into its bucket; the bucket at index 30 is lost whole.
    const values = Array.from({ length: 60 }, (_, i) => +(50 + i * 0.001).toFixed(4));
    values[30] = 49.5;
    const times = values.map((_, i) => at(i) + 240);
    const { sparkline } = buildQuoteSparkline(chart(times, values, '1m'), null);
    assert.equal(sparkline.length, 60);
    assert.ok(Math.abs(sparkline[30] - 50.03) < 1e-9, `midpoint, got ${sparkline[30]}`);
  });

  it('fills a lost bucket whose real gaps are exactly 15 minutes even when its bucket start is further away', () => {
    const minutes = [0, 5, 10, 14, 29, 44, 49, 54];
    const values = [50, 50, 50, 50, 49.5, 50, 50, 50];
    const { sparkline } = buildQuoteSparkline(chart(minutes.map((m) => T0 + m * 60), values, '1m'), null);
    // Buckets 0, 5, 10 (minute 14 closes it), 40, 45, 50, plus the refilled 25.
    assert.equal(sparkline.length, 7);
  });
});
