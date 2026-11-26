// Weekend and pre-open futures quotes must show the last completed session's move.
//
// Yahoo rolls a futures chart to the next session before that session trades.
// The default (1d) chart then has no bars, and chartPreviousClose/previousClose
// equal regularMarketPrice, so a change computed from it reads 0.00% all weekend
// while equity indices still show Friday's move. The fixtures are real Yahoo
// responses captured 2026-11-02 ~12:30 UTC: LE=F (CME live cattle) had not
// opened Monday's session yet, which is the same state every CME future is in
// on a weekend. GC=F was trading.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import * as yahooFetch from '../scripts/_yahoo-fetch.mjs';
import { marketMoveSeverity } from '../scripts/lib/notification-publish-policy.cjs';
import { createYahooEquityIndexBasisResolver, INDEX_TIME_ZONES } from '../scripts/shared/yahoo-closed-session.cjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/yahoo-closed-session/${name}`, import.meta.url), 'utf8'));

const LE_ROLLED_1D = fixture('le-f-1d-2026-11-02.json');
const LE_DAILY_5D = fixture('le-f-5d-1d-2026-11-02.json');
const GC_LIVE_1D = fixture('gc-f-1d-2026-11-02.json');
const GC_DAILY_1Y = fixture('gc-f-1y-1d-2026-11-02.json');

// LE=F last traded Friday at 220.95; Thursday's session closed at 227.275.
const LE_FRIDAY_MOVE = -2.78;
// GC=F trading Monday at 3913.4 against Friday's 3898.9 close.
const GC_MONDAY_MOVE = 0.37;
const GC_FRIDAY_CLOSE = 3898.89990234375;
const LE_THURSDAY_CLOSE = 227.27499389648438;

// The daily chart as it reads once Monday's session has traded: its last
// trade moved past the rolled quote's, and the new session's bar has a close.
function dailyAfterOpen() {
  const daily = structuredClone(LE_DAILY_5D);
  const result = daily.chart.result[0];
  result.meta.regularMarketTime = result.timestamp.at(-1) + 9 * 3600;
  result.indicators.quote[0].close[result.timestamp.length - 1] = 221.5;
  return daily;
}

function stubYahoo(responses) {
  const urls = [];
  const requestOptions = [];
  const fetchJson = async (url, options = {}) => {
    urls.push(url);
    requestOptions.push(options);
    const match = responses.find(([suffix]) => url.endsWith(suffix));
    if (!match) throw new Error(`unexpected Yahoo request ${url}`);
    return structuredClone(match[1]);
  };
  return { urls, requestOptions, fetchJson };
}

describe('cron seeders (fetchYahooQuoteChart)', () => {
  const fetchQuote = (symbol, fetchJson) => {
    assert.equal(typeof yahooFetch.fetchYahooQuoteChart, 'function', 'fetchYahooQuoteChart is exported');
    return yahooFetch.fetchYahooQuoteChart(symbol, { fetchJson, delayMs: 0 });
  };

  it('a chart rolled to an unopened session reports the last completed session move, not 0.00', async () => {
    const rolled = stubYahoo([
      ['/LE%3DF', LE_ROLLED_1D],
      ['/LE%3DF?range=5d&interval=1d', LE_DAILY_5D],
    ]);
    const quote = await fetchQuote('LE=F', rolled.fetchJson);
    assert.equal(quote.price, 220.95);
    assert.equal(quote.change, LE_FRIDAY_MOVE);
    assert.equal(rolled.urls.length, 2);
  });

  it('measures against the session before the rolled quote even if trading opens between the requests', async () => {
    const opened = stubYahoo([
      ['/LE%3DF', LE_ROLLED_1D],
      ['/LE%3DF?range=5d&interval=1d', dailyAfterOpen()],
    ]);
    const quote = await fetchQuote('LE=F', opened.fetchJson);
    assert.equal(quote.change, LE_FRIDAY_MOVE);
  });

  it('gives the optional daily chart no retries, keeping the quote request on the default budget', async () => {
    const rolled = stubYahoo([
      ['/LE%3DF', LE_ROLLED_1D],
      ['/LE%3DF?range=5d&interval=1d', LE_DAILY_5D],
    ]);
    await fetchQuote('LE=F', rolled.fetchJson);
    assert.equal(rolled.requestOptions[0].maxRetries, undefined);
    assert.equal(rolled.requestOptions[1].maxRetries, 0);
  });

  it('a trading quote costs one Yahoo request and keeps its own previous close', async () => {
    const live = stubYahoo([['/GC%3DF', GC_LIVE_1D]]);
    const quote = await fetchQuote('GC=F', live.fetchJson);
    assert.equal(quote.change, GC_MONDAY_MOVE);
    assert.equal(live.urls.length, 1);
  });

  it('keeps the Yahoo observation timestamp on the Brent futures quote', async () => {
    const brent = structuredClone(GC_LIVE_1D);
    const { meta } = brent.chart.result[0];
    meta.symbol = 'BZ=F';
    const { fetchJson } = stubYahoo([['/BZ%3DF', brent]]);
    const quote = await fetchQuote('BZ=F', fetchJson);
    assert.equal(quote.priceBasis, 'futures');
    assert.equal(quote.priceSource, 'Yahoo Finance');
    assert.equal(quote.priceAt, meta.regularMarketTime * 1000);
  });

  it('keeps the quote when the daily chart request fails', async () => {
    const failing = stubYahoo([['/LE%3DF', LE_ROLLED_1D]]);
    const quote = await fetchQuote('LE=F', failing.fetchJson);
    assert.equal(quote.price, 220.95);
    assert.equal(quote.change, 0);
  });
});

describe('previous session close from a daily chart (gold-extended Prev and drivers)', () => {
  it('is the close before the session of the last trade, not the close before the chart range', async () => {
    const { previousSessionClose } = await import('../scripts/shared/yahoo-closed-session.cjs');
    // The 1y chart's chartPreviousClose is the close one year ago (4014).
    assert.equal(GC_DAILY_1Y.chart.result[0].meta.chartPreviousClose, 4014);
    assert.equal(previousSessionClose(GC_DAILY_1Y), GC_FRIDAY_CLOSE);
    assert.equal(+previousSessionClose(GC_DAILY_1Y).toFixed(2), GC_LIVE_1D.chart.result[0].meta.previousClose,
      'matches the previous close Yahoo quotes for the live session');
    assert.equal(previousSessionClose(LE_DAILY_5D), LE_THURSDAY_CLOSE,
      'skips the empty bar of the session that has not traded');
  });
});

const RELAY_SOURCE = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = RELAY_SOURCE.search(new RegExp(`(async )?function ${name}\\(`));
  assert.notEqual(start, -1, `could not find ${name} in ais-relay.cjs`);
  const bodyStart = RELAY_SOURCE.indexOf('{', RELAY_SOURCE.indexOf(')', start));
  let depth = 0;
  for (let i = bodyStart; i < RELAY_SOURCE.length; i += 1) {
    if (RELAY_SOURCE[i] === '{') depth += 1;
    if (RELAY_SOURCE[i] === '}') depth -= 1;
    if (depth === 0) return RELAY_SOURCE.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name} in ais-relay.cjs`);
}

async function loadRelayQuoteFetch(responses, resolveIndexClose = createYahooEquityIndexBasisResolver()) {
  const shared = await import('../scripts/shared/yahoo-closed-session.cjs');
  const requests = [];
  const parse = Function('awaitsSessionOpen', `
    ${extractFunction('_finiteObservation')}
    ${extractFunction('_parseYahooChartJson')}
    return _parseYahooChartJson;
  `)(shared.awaitsSessionOpen);
  const fetchOnce = async (symbol, query = '') => {
    requests.push(`${symbol}${query}`);
    const match = responses[`${symbol}${query}`];
    return match ? parse(JSON.stringify(match)) : null;
  };
  const fetchYahooChartDirect = Function(
    '_fetchYahooChartOnce', 'sleep', 'PREVIOUS_SESSION_CHART_QUERY', 'isYahooEquityIndex',
    'previousSessionClose', 'resolveYahooIndexClose', '_previousSessionCloses',
    `${extractFunction('_withPreviousSessionChange')}
     ${extractFunction('fetchYahooChartDirect')}
     return fetchYahooChartDirect;`,
  )(
    fetchOnce, async () => {}, shared.PREVIOUS_SESSION_CHART_QUERY, shared.isYahooEquityIndex,
    shared.previousSessionClose, resolveIndexClose, new Map(),
  );
  return { fetchYahooChartDirect, requests };
}

describe('relay market loop (fetchYahooChartDirect)', () => {
  it('reports the last completed session move for a rolled future, fetching its daily chart once per session', async () => {
    const { fetchYahooChartDirect, requests } = await loadRelayQuoteFetch({
      'LE=F': LE_ROLLED_1D,
      'LE=F?range=5d&interval=1d': LE_DAILY_5D,
    });
    const first = await fetchYahooChartDirect('LE=F');
    assert.equal(+first.change.toFixed(2), LE_FRIDAY_MOVE);
    const second = await fetchYahooChartDirect('LE=F');
    assert.equal(+second.change.toFixed(2), LE_FRIDAY_MOVE);
    assert.deepEqual(requests, ['LE=F', 'LE=F?range=5d&interval=1d', 'LE=F'],
      'the previous session close is reused until the last trade changes');
  });

  it('measures against the session before the rolled quote even if trading opens between the requests', async () => {
    const { fetchYahooChartDirect } = await loadRelayQuoteFetch({
      'LE=F': LE_ROLLED_1D,
      'LE=F?range=5d&interval=1d': dailyAfterOpen(),
    });
    const quote = await fetchYahooChartDirect('LE=F');
    assert.equal(+quote.change.toFixed(2), LE_FRIDAY_MOVE);
  });

  it('leaves a trading quote and explicit-range charts on a single request', async () => {
    const { fetchYahooChartDirect, requests } = await loadRelayQuoteFetch({
      'GC=F': GC_LIVE_1D,
      'GC=F?range=1y&interval=1d': GC_DAILY_1Y,
    });
    const live = await fetchYahooChartDirect('GC=F');
    assert.equal(+live.change.toFixed(2), GC_MONDAY_MOVE);
    await fetchYahooChartDirect('GC=F', '?range=1y&interval=1d');
    assert.deepEqual(requests, ['GC=F', 'GC=F?range=1y&interval=1d']);
  });
});

// Minimal projection of the Nov 24 Yahoo quote capture. Daily rows are
// fixtures from TWSE's index history, not a captured Yahoo daily response.
const TAIEX = '^TWII';
const DAILY = '?range=5d&interval=1d';
const NOV24_OPEN = 1795482000;
const NOV24_TRADE = 1795498395;
const NOV23_OPEN = NOV24_OPEN - 86400;
const NOV20_OPEN = NOV23_OPEN - 3 * 86400;
const NOV19_OPEN = NOV20_OPEN - 86400;

function taiexQuote(time = NOV24_TRADE, price = 40122.35, staleClose = 36033.30, symbol = TAIEX) {
  return { chart: { result: [{
    meta: {
      symbol,
      regularMarketPrice: price,
      regularMarketTime: time,
      exchangeTimezoneName: 'Asia/Taipei',
      currentTradingPeriod: { regular: { start: Math.floor(time / 86400) * 86400 + 3600 } },
      chartPreviousClose: staleClose,
      previousClose: staleClose,
    },
    indicators: { quote: [{ close: [price] }] },
  }] } };
}

function taiexDaily(bars) {
  const last = bars.filter(([, close]) => close != null).at(-1);
  return { chart: { result: [{
    meta: { symbol: TAIEX, regularMarketPrice: last[1], regularMarketTime: last[0] },
    timestamp: bars.map(([date]) => date),
    indicators: { quote: [{ close: bars.map(([, close]) => close) }] },
  }] } };
}

const NOV24_DAILY = taiexDaily([
  [NOV20_OPEN, 36033.29], [NOV23_OPEN, 36811.89], [NOV24_OPEN, 40122.35],
]);

describe('TAIEX prior-session basis', () => {
  it('normalizes the cron quote against the preceding session and preserves its intraday sparkline', async () => {
    const { fetchJson, requestOptions } = stubYahoo([
      ['/%5ETWII', taiexQuote()],
      ['/%5ETWII' + DAILY, NOV24_DAILY],
    ]);
    const quote = await yahooFetch.fetchYahooQuoteChart(TAIEX, {
      fetchJson, delayMs: 0, resolveIndexClose: createYahooEquityIndexBasisResolver(),
    });
    assert.equal(quote.price, 40122.35);
    assert.equal(quote.change, 8.99);
    assert.deepEqual(quote.sparkline, [40122.35]);
    assert.deepEqual(requestOptions.map(({ maxRetries }) => maxRetries), [undefined, 0]);
  });

  it('accepts a current-session daily bar stamped after the quote, but not a later session', async () => {
    const { equityIndexPreviousSessionClose } = await import('../scripts/shared/yahoo-closed-session.cjs');
    // The daily chart is fetched after the quote, so its live bar can carry a newer trade time.
    const later = taiexDaily([[NOV20_OPEN, 36033.29], [NOV23_OPEN, 36811.89], [NOV24_TRADE + 30, 40130]]);
    assert.equal(equityIndexPreviousSessionClose(TAIEX, later, NOV24_TRADE), 36811.89);
    const nextOnly = taiexDaily([[NOV20_OPEN, 36033.29], [NOV23_OPEN, 36811.89], [NOV24_OPEN + 86400, 40130]]);
    assert.equal(equityIndexPreviousSessionClose(TAIEX, nextOnly, NOV24_TRADE), null);
  });

  it('downgrades the reproduced false alert and caches its basis across same-session quotes', async () => {
    const responses = { [TAIEX]: taiexQuote(), [TAIEX + DAILY]: NOV24_DAILY };
    let now = 0;
    const { fetchYahooChartDirect, requests } = await loadRelayQuoteFetch(
      responses, createYahooEquityIndexBasisResolver({ now: () => now }),
    );
    const q = await fetchYahooChartDirect(TAIEX);
    assert.equal(+q.change.toFixed(2), 8.99);
    assert.equal(marketMoveSeverity({ assetClass: 'equity', symbol: TAIEX, changePct: q.change }), 'high');

    responses[TAIEX] = taiexQuote(NOV24_TRADE + 15, 40100);
    assert.equal(+(await fetchYahooChartDirect(TAIEX)).change.toFixed(2), 8.93);
    assert.deepEqual(requests, [TAIEX, TAIEX + DAILY, TAIEX]);

    // A new session must not inherit the cached baseline. The daily chart
    // might not have its current row yet or might have an incomplete close.
    responses[TAIEX] = taiexQuote(NOV24_TRADE + 86400, 40000);
    assert.equal(await fetchYahooChartDirect(TAIEX), null);
    responses[TAIEX + DAILY] = taiexDaily([
      [NOV23_OPEN, 36811.89], [NOV24_OPEN, 40122.35], [NOV24_OPEN + 86400, null],
    ]);
    assert.equal(await fetchYahooChartDirect(TAIEX), null, 'wait briefly before retrying failed history');
    now += 15 * 60 * 1000;
    assert.equal(+(await fetchYahooChartDirect(TAIEX)).change.toFixed(2), -0.3);
  });

  it('never uses stale fields on history failure or an empty preceding bar, and accepts a weekend gap', async () => {
    // Synthetic intraday observation within the Nov 20 exchange range.
    const friday = taiexQuote(NOV20_OPEN + 4 * 3600 + 94, 36000, 40194.91);
    const responses = { [TAIEX]: friday };
    let now = 0;
    const { fetchYahooChartDirect } = await loadRelayQuoteFetch(
      responses, createYahooEquityIndexBasisResolver({ now: () => now }),
    );
    assert.equal(await fetchYahooChartDirect(TAIEX), null);
    const failing = stubYahoo([['/%5ETWII', friday]]);
    assert.equal(await yahooFetch.fetchYahooQuoteChart(TAIEX, {
      fetchJson: failing.fetchJson, delayMs: 0, resolveIndexClose: createYahooEquityIndexBasisResolver(),
    }), null);
    now += 15 * 60 * 1000;

    responses[TAIEX + DAILY] = taiexDaily([
      [NOV19_OPEN - 86400, 40194.91], [NOV19_OPEN, null], [NOV20_OPEN, 36000],
    ]);
    assert.equal(await fetchYahooChartDirect(TAIEX), null, 'do not skip a missing Thursday close back to Wednesday');
    now += 15 * 60 * 1000;
    responses[TAIEX + DAILY] = taiexDaily([[NOV19_OPEN, 38426.89], [NOV20_OPEN, 36000]]);
    const q = await fetchYahooChartDirect(TAIEX);
    assert.equal(+q.change.toFixed(2), -6.32);
    assert.equal(marketMoveSeverity({ assetClass: 'equity', symbol: TAIEX, changePct: q.change }), 'high');

    responses[TAIEX] = taiexQuote(NOV23_OPEN + 3600, 36500);
    responses[TAIEX + DAILY] = NOV24_DAILY;
    assert.equal(+(await fetchYahooChartDirect(TAIEX)).change.toFixed(2), 1.3);
  });
});

describe('Yahoo-backed equity benchmark scope and shared basis', () => {
  it('covers every catalog cash benchmark without applying to stocks, ETFs, futures, volatility or yields', () => {
    const { symbols, yahooOnly, auxiliarySymbols } = JSON.parse(
      readFileSync(new URL('../shared/stocks.json', import.meta.url), 'utf8'),
    );
    const uncareted = new Set(['000001.SS', 'FTSEMIB.MI', 'DFMGI.AE']);
    const benchmarks = symbols.map(({ symbol }) => symbol).filter((symbol) =>
      yahooOnly.includes(symbol) && (symbol.startsWith('^') || uncareted.has(symbol)));
    assert.deepEqual(Object.keys(INDEX_TIME_ZONES).sort(), benchmarks.sort());
    assert.equal(benchmarks.length, 26);
    assert.ok(auxiliarySymbols.every(({ symbol }) => !Object.hasOwn(INDEX_TIME_ZONES, symbol)));
  });

  it('normalizes Hong Kong and Shanghai quote percentages at the same producer boundary', async () => {
    const hk = '^HSI';
    const sh = '000001.SS';
    const responses = {
      [hk]: taiexQuote(NOV24_OPEN + 7 * 3600, 22219.65, 22410.80, hk),
      [hk + DAILY]: taiexDaily([[NOV20_OPEN, 22410.80], [NOV23_OPEN, 22383.74], [NOV24_OPEN, null]]),
      [sh]: taiexQuote(NOV24_OPEN + 6 * 3600, 3548.369, 3533.79, sh),
      [sh + DAILY]: taiexDaily([[NOV20_OPEN, 3533.79], [NOV23_OPEN, 3538.948], [NOV24_OPEN, null]]),
    };
    const { fetchYahooChartDirect, requests } = await loadRelayQuoteFetch(responses);
    assert.equal(+(await fetchYahooChartDirect(hk)).change.toFixed(2), -0.73);
    assert.equal(+(await fetchYahooChartDirect(sh)).change.toFixed(2), 0.27);
    assert.equal((await fetchYahooChartDirect(sh, DAILY)).price, 3538.948, 'explicit range keeps its own path');
    assert.deepEqual(requests, [hk, hk + DAILY, sh, sh + DAILY, sh + DAILY]);
  });

  it('uses the last traded Sydney session across a pre-open holiday and daylight-saving transition', async () => {
    const symbol = '^AXJO';
    const ts = (iso) => Date.parse(iso) / 1000;
    // Easter closed the ASX Apr 3 and 6, and Sydney changed clocks Apr 5.
    const apr1 = ts('2026-04-01T10:00:00+11:00');
    const apr2 = ts('2026-04-02T10:00:00+11:00'); // previous UTC date
    const apr7 = ts('2026-04-07T10:00:00+10:00');
    const daily = taiexDaily([[apr1, 8000], [apr2, 8100], [apr7, null]]);
    const preopen = taiexQuote(ts('2026-04-02T16:15:00+11:00'), 8100, 8100, symbol);
    preopen.chart.result[0].meta.currentTradingPeriod.regular.start = apr7;
    const responses = { [symbol]: preopen, [symbol + DAILY]: daily };
    const { fetchYahooChartDirect } = await loadRelayQuoteFetch(responses);
    assert.equal(+(await fetchYahooChartDirect(symbol)).change.toFixed(2), 1.25);
    responses[symbol] = taiexQuote(apr7 + 600, 8181, 8000, symbol);
    assert.equal(+(await fetchYahooChartDirect(symbol)).change.toFixed(2), 1);
  });

  it('does not repeat a failing daily request from a fresh cron process before the retry window', async () => {
    let now = 0;
    let calls = 0;
    let daily = null;
    const shared = new Map();
    const options = {
      now: () => now, read: async (key) => shared.get(key),
      write: async (key, value) => shared.set(key, value),
    };
    const loadDaily = async () => { calls += 1; return daily; };
    assert.equal(await createYahooEquityIndexBasisResolver(options)(TAIEX, NOV24_TRADE, loadDaily), null);
    daily = NOV24_DAILY;
    assert.equal(await createYahooEquityIndexBasisResolver(options)(TAIEX, NOV24_TRADE, loadDaily), null);
    assert.equal(calls, 1);
    now += 15 * 60 * 1000;
    assert.equal(await createYahooEquityIndexBasisResolver(options)(TAIEX, NOV24_TRADE, loadDaily), 36811.89);
    assert.equal(calls, 2);
  });

  it('shares and coalesces verified lookups across ticks, workers and restarts', async () => {
    const shared = new Map();
    const read = async (key) => shared.get(key);
    const ttls = [];
    const write = async (key, value, ttl) => { shared.set(key, value); ttls.push(ttl); };
    const relay = createYahooEquityIndexBasisResolver({ read, write });
    let calls = 0;
    const loadDaily = async () => { calls += 1; return NOV24_DAILY; };
    const quotes = await Promise.all([
      relay(TAIEX, NOV24_TRADE, loadDaily),
      relay(TAIEX, NOV24_TRADE + 20, loadDaily),
    ]);
    assert.deepEqual(quotes, [36811.89, 36811.89]);
    const restartedCron = createYahooEquityIndexBasisResolver({ read, write });
    assert.equal(await restartedCron(TAIEX, NOV24_TRADE + 30, loadDaily), 36811.89);
    assert.equal(calls, 1);
    assert.deepEqual(ttls, [7 * 86400]);
  });
});

describe('index basis backoff and Redis adapters', () => {
  const NO_BASIS_DAILY = taiexDaily([[NOV23_OPEN, 36811.89], [NOV24_OPEN + 86400, 40130]]);

  function sharedRedis() {
    const values = new Map();
    const calls = [];
    return {
      values,
      calls,
      read: async (key) => values.get(key) ?? null,
      write: async (key, entry, ttl) => { calls.push(['set', key, ttl]); values.set(key, entry); },
      writeIfAbsent: async (key, entry, ttl) => {
        calls.push(['setnx', key, ttl]);
        if (!values.has(key)) values.set(key, entry);
      },
    };
  }

  it('shares a missing prior-session bar across producers without replacing a verified close', async () => {
    let now = 0;
    const redis = sharedRedis();
    const cron = createYahooEquityIndexBasisResolver({ ...redis, scope: 'cron', now: () => now });
    assert.equal(await cron(TAIEX, NOV24_TRADE, async () => NO_BASIS_DAILY), null);
    assert.deepEqual(redis.calls, [['setnx', `market:yahoo-index-close:v1:${TAIEX}:2026-11-24`, 900]]);

    let relayCalls = 0;
    const relay = createYahooEquityIndexBasisResolver({ ...redis, scope: 'relay', now: () => now });
    assert.equal(await relay(TAIEX, NOV24_TRADE, async () => { relayCalls += 1; return NOV24_DAILY; }), null);
    assert.equal(relayCalls, 0, 'the same chart would show the same gap');

    redis.values.set(`market:yahoo-index-close:v1:${TAIEX}:2026-11-24`, { close: 36811.89 });
    now += 16 * 60 * 1000;
    const late = createYahooEquityIndexBasisResolver({ ...redis, scope: 'cron', now: () => now });
    assert.equal(await late(TAIEX, NOV24_TRADE, async () => NO_BASIS_DAILY), 36811.89);
  });

  it('backs off a failed request for its own producer only, for five minutes', async () => {
    let now = 0;
    const redis = sharedRedis();
    const options = { ...redis, now: () => now };
    let calls = 0;
    const failing = async () => { calls += 1; return null; };
    const loaded = async () => { calls += 1; return NOV24_DAILY; };

    assert.equal(await createYahooEquityIndexBasisResolver({ ...options, scope: 'cron' })(TAIEX, NOV24_TRADE, failing), null);
    assert.deepEqual(redis.calls, [['set', `market:yahoo-index-close:v1:${TAIEX}:2026-11-24:retry:cron`, 300]]);
    assert.equal(await createYahooEquityIndexBasisResolver({ ...options, scope: 'cron' })(TAIEX, NOV24_TRADE, loaded), null,
      'a restarted cron process keeps its own backoff');
    assert.equal(calls, 1);

    assert.equal(await createYahooEquityIndexBasisResolver({ ...options, scope: 'relay' })(TAIEX, NOV24_TRADE, loaded), 36811.89,
      "the relay's route is tried even while the cron backs off");
    assert.equal(calls, 2);

    redis.values.delete(`market:yahoo-index-close:v1:${TAIEX}:2026-11-24`);
    now += 5 * 60 * 1000 + 1;
    assert.equal(await createYahooEquityIndexBasisResolver({ ...options, scope: 'cron' })(TAIEX, NOV24_TRADE, loaded), 36811.89);
  });

  it('a warm producer in backoff adopts a close another producer verified, without refetching', async () => {
    const redis = sharedRedis();
    const relay = createYahooEquityIndexBasisResolver({ ...redis, scope: 'relay', now: () => 0 });
    let calls = 0;
    assert.equal(await relay(TAIEX, NOV24_TRADE, async () => { calls += 1; return null; }), null);
    redis.values.set(`market:yahoo-index-close:v1:${TAIEX}:2026-11-24`, { close: 36811.89 });
    assert.equal(await relay(TAIEX, NOV24_TRADE + 60, async () => { calls += 1; return NOV24_DAILY; }), 36811.89);
    assert.equal(calls, 1, 'the backoff still applies to Yahoo');
  });

  it('still resolves when Redis reads and writes fail', async () => {
    const broken = async () => { throw new Error('redis down'); };
    const resolve = createYahooEquityIndexBasisResolver({ read: broken, write: broken, writeIfAbsent: broken });
    assert.equal(await resolve(TAIEX, NOV24_TRADE, async () => NOV24_DAILY), 36811.89);
    const missing = createYahooEquityIndexBasisResolver({ read: broken, write: broken, writeIfAbsent: broken });
    assert.equal(await missing(TAIEX, NOV24_TRADE, async () => NO_BASIS_DAILY), null);
  });

  it('cron adapter sends GET, SET EX and SET NX EX with the right keys and TTLs', async () => {
    const store = new Map();
    const commands = [];
    const command = async (args) => {
      commands.push(args);
      if (args[0] === 'GET') return store.get(args[1]) ?? null;
      if (args.includes('NX') && store.has(args[1])) return null;
      store.set(args[1], args[2]);
      return 'OK';
    };
    const key = `market:yahoo-index-close:v1:${TAIEX}:2026-11-24`;
    let now = 0;
    const cron = yahooFetch.createRedisIndexBasisResolver({ command, now: () => now });
    assert.equal(await cron(TAIEX, NOV24_TRADE, async () => null), null);
    assert.deepEqual(commands.at(-1), ['SET', `${key}:retry:cron`, JSON.stringify({ close: null, retryAt: 300000 }), 'EX', 300]);

    now += 6 * 60 * 1000;
    const noBasis = yahooFetch.createRedisIndexBasisResolver({ command, now: () => now });
    assert.equal(await noBasis(TAIEX, NOV24_TRADE, async () => NO_BASIS_DAILY), null);
    assert.deepEqual(commands.at(-1), ['SET', key, JSON.stringify({ close: null, retryAt: now + 900000 }), 'NX', 'EX', 900]);

    store.set(key, JSON.stringify({ close: 36811.89 }));
    const reader = yahooFetch.createRedisIndexBasisResolver({ command, now: () => now });
    assert.equal(await reader(TAIEX, NOV24_TRADE, async () => assert.fail('a verified close is reused')), 36811.89);
    assert.deepEqual(commands.at(-1), ['GET', key]);

    store.clear();
    const writer = yahooFetch.createRedisIndexBasisResolver({ command, now: () => now });
    assert.equal(await writer(TAIEX, NOV24_TRADE, async () => NOV24_DAILY), 36811.89);
    assert.deepEqual(commands.at(-1), ['SET', key, JSON.stringify({ close: 36811.89 }), 'EX', 7 * 86400]);
  });

  it('relay adapter routes verified closes to SET and missing bars to SET NX', async () => {
    const start = RELAY_SOURCE.indexOf('const resolveYahooIndexClose = createYahooEquityIndexBasisResolver(');
    assert.notEqual(start, -1);
    const open = RELAY_SOURCE.indexOf('(', start);
    let depth = 0;
    let end = open;
    for (; end < RELAY_SOURCE.length; end += 1) {
      if (RELAY_SOURCE[end] === '(') depth += 1;
      if (RELAY_SOURCE[end] === ')') depth -= 1;
      if (depth === 0) break;
    }
    const calls = [];
    const resolver = Function(
      'createYahooEquityIndexBasisResolver', 'upstashGet', 'upstashSet', 'upstashSetNx',
      `return createYahooEquityIndexBasisResolver${RELAY_SOURCE.slice(open, end + 1)};`,
    )(
      createYahooEquityIndexBasisResolver,
      async (...args) => { calls.push(['get', ...args]); return null; },
      async (...args) => { calls.push(['set', args[0], args[2]]); return true; },
      async (...args) => { calls.push(['setnx', args[0], args[2]]); return 'ok'; },
    );
    const key = `market:yahoo-index-close:v1:${TAIEX}:2026-11-24`;
    assert.equal(await resolver(TAIEX, NOV24_TRADE, async () => NO_BASIS_DAILY), null);
    assert.deepEqual(calls, [
      ['get', key, undefined, 1500], ['get', `${key}:retry:relay`, undefined, 1500], ['setnx', key, 900],
    ]);
    const fresh = Function(
      'createYahooEquityIndexBasisResolver', 'upstashGet', 'upstashSet', 'upstashSetNx',
      `return createYahooEquityIndexBasisResolver${RELAY_SOURCE.slice(open, end + 1)};`,
    )(createYahooEquityIndexBasisResolver, async () => null,
      async (...args) => { calls.push(['set', args[0], args[2]]); return true; }, async () => 'ok');
    assert.equal(await fresh(TAIEX, NOV24_TRADE, async () => NOV24_DAILY), 36811.89);
    assert.deepEqual(calls.at(-1), ['set', key, 7 * 86400]);
  });
});

describe('relay Gulf quotes (seedGulfQuotes)', () => {
  const GULF = [
    { symbol: '^TASI.SR', name: 'Tadawul All Share', country: 'Saudi Arabia', flag: 'SA', type: 'index' },
    { symbol: 'QAT', name: 'Qatar (iShares)', country: 'Qatar', flag: 'QA', type: 'index' },
    { symbol: 'SARUSD=X', name: 'Saudi Riyal', country: 'Saudi Arabia', flag: 'SA', type: 'currency' },
  ];

  async function loadSeedGulf({ fresh, previous }) {
    const { isYahooEquityIndex } = await import('../scripts/shared/yahoo-closed-session.cjs');
    const writes = [];
    const seed = Function(
      'GULF_SYMBOLS', 'GULF_SEED_TTL', 'envelopeRead', 'envelopeWrite', 'upstashSet',
      'fetchYahooChartDirect', 'sleep', 'isYahooEquityIndex', 'console',
      `${extractFunction('seedGulfQuotes')}
       return seedGulfQuotes;`,
    )(
      GULF, 5400, async () => previous, async (key, payload) => { writes.push(payload); return true; }, async () => true,
      async (symbol) => fresh[symbol] ?? null, async () => {}, isYahooEquityIndex, { log() {}, warn() {} },
    );
    return { seed, writes };
  }

  it('keeps the last Tadawul row while its prior close is unverified', async () => {
    const tasiRow = { symbol: '^TASI.SR', name: 'Tadawul All Share', country: 'Saudi Arabia', flag: 'SA', type: 'index', price: 11000, change: 0.5, sparkline: [] };
    const qatRow = { symbol: 'QAT', price: 17, change: 1, sparkline: [] };
    const { seed, writes } = await loadSeedGulf({
      fresh: { 'SARUSD=X': { price: 0.2666, change: 0, sparkline: [] } },
      previous: { quotes: [tasiRow, qatRow] },
    });
    assert.equal(await seed(), 2);
    assert.deepEqual(writes[0].quotes.map((q) => q.symbol), ['^TASI.SR', 'SARUSD=X']);
    assert.equal(writes[0].quotes[0], tasiRow);
  });

  it('stamps each fresh quote with its Yahoo observation time', async () => {
    const lastTradeAt = Date.UTC(2026, 10, 24, 12) / 1000;
    const { seed, writes } = await loadSeedGulf({
      fresh: { 'SARUSD=X': { price: 0.2666, change: 0, sparkline: [], lastTradeAt }, QAT: { price: 17, change: 1, sparkline: [] } },
      previous: null,
    });
    assert.equal(await seed(), 2);
    assert.deepEqual(writes[0].quotes.map((q) => [q.symbol, q.priceAt]), [['QAT', undefined], ['SARUSD=X', lastTradeAt * 1000]]);
  });

  it('does not republish retained rows when nothing was fetched', async () => {
    const { seed, writes } = await loadSeedGulf({
      fresh: {},
      previous: { quotes: [{ symbol: '^TASI.SR', price: 11000, change: 0.5, sparkline: [] }] },
    });
    assert.equal(await seed(), 0);
    assert.equal(writes.length, 0);
  });
});
