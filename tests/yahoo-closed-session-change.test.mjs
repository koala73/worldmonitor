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

async function loadRelayQuoteFetch(responses) {
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
    '_fetchYahooChartOnce', 'sleep', 'PREVIOUS_SESSION_CHART_QUERY', 'TAIEX_SYMBOL',
    'previousSessionClose', 'taiexPreviousSessionClose', 'taiexSessionDay', '_previousSessionCloses',
    `${extractFunction('_withPreviousSessionChange')}
     ${extractFunction('fetchYahooChartDirect')}
     return fetchYahooChartDirect;`,
  )(
    fetchOnce, async () => {}, shared.PREVIOUS_SESSION_CHART_QUERY, shared.TAIEX_SYMBOL,
    shared.previousSessionClose, shared.taiexPreviousSessionClose, shared.taiexSessionDay, new Map(),
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

function taiexQuote(time = NOV24_TRADE, price = 40122.35, staleClose = 36033.30) {
  return { chart: { result: [{
    meta: {
      symbol: TAIEX,
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
    const quote = await yahooFetch.fetchYahooQuoteChart(TAIEX, { fetchJson, delayMs: 0 });
    assert.equal(quote.price, 40122.35);
    assert.equal(quote.change, 8.99);
    assert.deepEqual(quote.sparkline, [40122.35]);
    assert.deepEqual(requestOptions.map(({ maxRetries }) => maxRetries), [undefined, 0]);
  });

  it('downgrades the reproduced false alert and caches its basis across same-session quotes', async () => {
    const responses = { [TAIEX]: taiexQuote(), [TAIEX + DAILY]: NOV24_DAILY };
    const { fetchYahooChartDirect, requests } = await loadRelayQuoteFetch(responses);
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
    assert.equal(+(await fetchYahooChartDirect(TAIEX)).change.toFixed(2), -0.3);
  });

  it('never uses stale fields on history failure or an empty preceding bar, and accepts a weekend gap', async () => {
    // Synthetic intraday observation within the Nov 20 exchange range.
    const friday = taiexQuote(NOV20_OPEN + 4 * 3600 + 94, 36000, 40194.91);
    const responses = { [TAIEX]: friday };
    const { fetchYahooChartDirect } = await loadRelayQuoteFetch(responses);
    assert.equal(await fetchYahooChartDirect(TAIEX), null);
    const failing = stubYahoo([['/%5ETWII', friday]]);
    assert.equal(await yahooFetch.fetchYahooQuoteChart(TAIEX, { fetchJson: failing.fetchJson, delayMs: 0 }), null);

    responses[TAIEX + DAILY] = taiexDaily([
      [NOV19_OPEN - 86400, 40194.91], [NOV19_OPEN, null], [NOV20_OPEN, 36000],
    ]);
    assert.equal(await fetchYahooChartDirect(TAIEX), null, 'do not skip a missing Thursday close back to Wednesday');
    responses[TAIEX + DAILY] = taiexDaily([[NOV19_OPEN, 38426.89], [NOV20_OPEN, 36000]]);
    const q = await fetchYahooChartDirect(TAIEX);
    assert.equal(+q.change.toFixed(2), -6.32);
    assert.equal(marketMoveSeverity({ assetClass: 'equity', symbol: TAIEX, changePct: q.change }), 'high');

    responses[TAIEX] = taiexQuote(NOV23_OPEN + 3600, 36500);
    responses[TAIEX + DAILY] = NOV24_DAILY;
    assert.equal(+(await fetchYahooChartDirect(TAIEX)).change.toFixed(2), 1.3);
  });
});
