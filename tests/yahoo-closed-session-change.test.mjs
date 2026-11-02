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
    '_fetchYahooChartOnce', 'sleep', 'PREVIOUS_SESSION_CHART_QUERY', 'previousSessionClose', '_previousSessionCloses',
    `${extractFunction('_withPreviousSessionChange')}
     ${extractFunction('fetchYahooChartDirect')}
     return fetchYahooChartDirect;`,
  )(fetchOnce, async () => {}, shared.PREVIOUS_SESSION_CHART_QUERY, shared.previousSessionClose, new Map());
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
