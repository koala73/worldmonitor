// Stock Connect northbound turnover + margin financing balance, straight from
// SSE and SZSE (#6155). Deliberately not BaoStock/AKShare (Python libraries, and
// the seeder fleet is Node ESM) nor EastMoney (undocumented private JSON with no
// published terms). These are new endpoints on the two hosts we already hold a
// terms contract for and already know how to reach from Railway, so this module
// carries only the endpoint contracts and normalisation -- the direct and proxy
// hops are the shared ones in scripts/_china-exchange-transport.mjs.
//
// WHAT IS NOT HERE: northbound NET flow. Both exchanges stopped publishing the
// northbound buy/sell split on 2024-08-16 (SZSE's own report footers link a
// `SGT_SGTJYRB_BEFORE` archive for the pre-cutoff series). Only gross turnover
// survives, so the snapshot states that unavailability explicitly rather than
// labelling turnover as a flow.

import {
  assertMetadataResponse,
  errorCodeFor,
  fetchViaConfiguredProxy,
  proxyFetch,
  readBoundedJsonResponse,
  shouldProxyExchangeFailure,
  shouldRetryExchangeProxyFailure,
  sourceError,
  transportFailureReason,
} from '../_china-exchange-transport.mjs';

export const CHINA_STOCK_CONNECT_KEY = 'market:china:stock-connect:v1';

// Northbound buy/sell disclosure ended on this date; the code below never
// reports a net figure and this constant is what says why in the payload.
export const NORTHBOUND_NET_FLOW_DISCONTINUED_ON = '2024-08-16';
export const NORTHBOUND_NET_FLOW_UNAVAILABLE_REASON = 'EXCHANGE_STOPPED_PUBLISHING_BUY_SELL_SPLIT';

const YI = 100_000_000; // 亿 -- the unit SSE/SZSE quote turnover and margin in
const WAN = 10_000; // 万 -- the unit both quote trade counts in
const DAY_MS = 86_400_000;
const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000; // CST, no daylight saving

export const HISTORY_LIMIT = 180;
// SZSE reports are keyed by an explicit date and margin publishes on a T+1 lag,
// so the two newest trading days are routinely empty: the current session has
// not closed and the previous one has not settled. Four probes clears that plus
// a spare once non-trading days are removed by the exchange calendar.
export const SZSE_MAX_DATE_PROBES = 4;
// The current Beijing month, plus the previous one when the current month has
// not yet accumulated SZSE_MAX_DATE_PROBES trading days.
const CALENDAR_MAX_MONTHS = 2;

const SSE_DIRECT_TIMEOUT_MS = 20_000;
const SSE_PROXY_TIMEOUT_MS = 12_000;
const SZSE_DIRECT_TIMEOUT_MS = 15_000;
const SZSE_PROXY_TIMEOUT_MS = 12_000;
const SZSE_PROXY_RETRY_DELAY_MS = 250;
const SSE_MAX_PROXY_ATTEMPTS = 1;
const SZSE_MAX_PROXY_ATTEMPTS = 2;
// Wall-clock ceiling shared by every www.szse.cn request in a run: the calendar
// plus both report sources plus their date probes. Per-request timeouts alone
// cannot bound this source, because the number of requests is data-dependent
// (how many trading days are still unpublished), so the product of probes and
// timeouts would otherwise overrun the bundle's per-section allowance.
const SZSE_RUN_BUDGET_MS = 100_000;
// Split into reservations rather than one pot. A single shared deadline is
// drained in call order, so the calendar and the first report source could
// consume all of it and leave szse-margin with nothing -- a source starved by
// scheduling rather than by anything wrong with it.
const SZSE_CALENDAR_BUDGET_MS = 30_000;
const SZSE_REPORT_BUDGET_MS = (SZSE_RUN_BUDGET_MS - SZSE_CALENDAR_BUDGET_MS) / 2;

// Every response we want is 1-6 KiB. The ceiling matters because dropping
// SZSE's txtDate makes the same endpoint dump its entire history since 2010
// (~438 KiB observed): that has to fail loudly as RESPONSE_TOO_LARGE, not parse.
const EXCHANGE_MAX_RESPONSE_BYTES = 65_536;

const SSE_MARGIN_PAGE_SIZE = 10;

export const STOCK_CONNECT_SOURCE_CONTRACTS = Object.freeze({
  'sse-northbound': Object.freeze({
    id: 'sse-northbound',
    exchange: 'SSE',
    series: 'northbound',
    label: 'Shanghai Connect northbound turnover',
    publisherId: 'publisher:sse-cn',
    publisherName: 'Shanghai Stock Exchange',
    metadataEndpoint: 'https://query.sse.com.cn/commonSoaQuery.do',
    metadataHost: 'query.sse.com.cn',
    // 沪股通成交概况 -- daily overview behind
    // https://www.sse.com.cn/services/hkexsc/hgtscsj/hgtcjgk/
    queryId: 'FW_HGTZL_HGTSCSJ_HGTCJGK_MRTJ',
    maxRequestsPerRun: 3,
    maxProxyRequestsPerRun: SSE_MAX_PROXY_ATTEMPTS,
    fallbackPolicy: 'direct_then_proxy_on_transport_failure',
    proxyEnvironmentVariable: 'SSE_PROXY_URL',
    maxResponseBytes: EXCHANGE_MAX_RESPONSE_BYTES,
    redirectPolicy: 'error',
    launchStatus: 'launched',
    admissionDecision: 'admitted_aggregate_statistics',
    termsUrl: 'https://www.sse.com.cn/home/legal/',
    termsNote: 'Public aggregate market statistics only; no per-investor or per-order data. Commercial reuse may require written permission.',
    robots: Object.freeze({ status: 'not_published', httpStatus: 404 }),
    preflight: Object.freeze({
      environment: 'workstation',
      checkedOn: '2026-08-05',
      reachable: true,
      metadataHttpStatus: 200,
      observedResponseBytes: 684,
    }),
  }),
  'sse-margin': Object.freeze({
    id: 'sse-margin',
    exchange: 'SSE',
    series: 'margin',
    label: 'Shanghai margin financing balance',
    publisherId: 'publisher:sse-cn',
    publisherName: 'Shanghai Stock Exchange',
    // 融资融券汇总 -- daily summary behind
    // https://www.sse.com.cn/market/othersdata/margin/sum/
    metadataEndpoint: 'https://query.sse.com.cn/marketdata/tradedata/queryMargin.do',
    metadataHost: 'query.sse.com.cn',
    queryId: null,
    maxRequestsPerRun: 3,
    maxProxyRequestsPerRun: SSE_MAX_PROXY_ATTEMPTS,
    fallbackPolicy: 'direct_then_proxy_on_transport_failure',
    proxyEnvironmentVariable: 'SSE_PROXY_URL',
    maxResponseBytes: EXCHANGE_MAX_RESPONSE_BYTES,
    redirectPolicy: 'error',
    launchStatus: 'launched',
    admissionDecision: 'admitted_aggregate_statistics',
    termsUrl: 'https://www.sse.com.cn/home/legal/',
    termsNote: 'Public aggregate market statistics only; no per-investor or per-order data. Commercial reuse may require written permission.',
    robots: Object.freeze({ status: 'not_published', httpStatus: 404 }),
    preflight: Object.freeze({
      environment: 'workstation',
      checkedOn: '2026-08-05',
      reachable: true,
      metadataHttpStatus: 200,
      observedResponseBytes: 2_928,
    }),
  }),
  'szse-northbound': Object.freeze({
    id: 'szse-northbound',
    exchange: 'SZSE',
    series: 'northbound',
    label: 'Shenzhen Connect northbound turnover',
    publisherId: 'publisher:szse-cn',
    publisherName: 'Shenzhen Stock Exchange',
    // 深股通交易日报 -- https://www.szse.cn/szhk/szhktradeinfo/szdaily/
    metadataEndpoint: 'https://www.szse.cn/api/report/ShowReport/data',
    metadataHost: 'www.szse.cn',
    queryId: 'SGT_SGTJYRB',
    maxRequestsPerRun: 8,
    maxProxyRequestsPerRun: SZSE_MAX_PROXY_ATTEMPTS,
    fallbackPolicy: 'direct_then_proxy_on_transport_failure',
    proxyEnvironmentVariable: 'SZSE_PROXY_URL',
    maxResponseBytes: EXCHANGE_MAX_RESPONSE_BYTES,
    redirectPolicy: 'error',
    launchStatus: 'launched',
    admissionDecision: 'admitted_aggregate_statistics',
    termsUrl: 'https://www.szse.cn/application/laws/',
    termsNote: 'Public aggregate market statistics only; no per-investor or per-order data. Commercial reuse may require written permission.',
    robots: Object.freeze({ status: 'empty', httpStatus: 200 }),
    preflight: Object.freeze({
      environment: 'workstation',
      checkedOn: '2026-08-05',
      reachable: true,
      metadataHttpStatus: 200,
      observedResponseBytes: 1_095,
    }),
  }),
  'szse-margin': Object.freeze({
    id: 'szse-margin',
    exchange: 'SZSE',
    series: 'margin',
    label: 'Shenzhen margin financing balance',
    publisherId: 'publisher:szse-cn',
    publisherName: 'Shenzhen Stock Exchange',
    // 融资融券交易总量 -- https://www.szse.cn/disclosure/margin/margin/
    metadataEndpoint: 'https://www.szse.cn/api/report/ShowReport/data',
    metadataHost: 'www.szse.cn',
    queryId: '1837_xxpl',
    maxRequestsPerRun: 8,
    maxProxyRequestsPerRun: SZSE_MAX_PROXY_ATTEMPTS,
    fallbackPolicy: 'direct_then_proxy_on_transport_failure',
    proxyEnvironmentVariable: 'SZSE_PROXY_URL',
    maxResponseBytes: EXCHANGE_MAX_RESPONSE_BYTES,
    redirectPolicy: 'error',
    launchStatus: 'launched',
    admissionDecision: 'admitted_aggregate_statistics',
    termsUrl: 'https://www.szse.cn/application/laws/',
    termsNote: 'Public aggregate market statistics only; no per-investor or per-order data. Commercial reuse may require written permission.',
    robots: Object.freeze({ status: 'empty', httpStatus: 200 }),
    preflight: Object.freeze({
      environment: 'workstation',
      checkedOn: '2026-08-05',
      reachable: true,
      metadataHttpStatus: 200,
      observedResponseBytes: 2_702,
    }),
  }),
});

export const SZSE_TRADING_CALENDAR_ENDPOINT = 'https://www.szse.cn/api/report/exchange/onepersistenthour/monthList';

export const STOCK_CONNECT_SOURCE_IDS = Object.freeze(
  Object.keys(STOCK_CONNECT_SOURCE_CONTRACTS),
);

// Worst case for the bundle scheduler. The SZSE half is the shared run budget
// plus one in-flight request, because the budget is checked before dialling, so
// a request admitted at the last moment still runs to its own timeout. The SSE
// half is bounded by request count alone: one call per source, direct + proxy.
export const CHINA_STOCK_CONNECT_MAX_NETWORK_MS = (
  SZSE_RUN_BUDGET_MS
  + SZSE_DIRECT_TIMEOUT_MS
  + 2 * (SSE_DIRECT_TIMEOUT_MS + SSE_MAX_PROXY_ATTEMPTS * SSE_PROXY_TIMEOUT_MS)
);

const REQUEST_HEADERS = Object.freeze({
  sse: Object.freeze({
    Accept: 'application/json',
    Referer: 'https://www.sse.com.cn/',
    'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)',
  }),
  szse: Object.freeze({
    Accept: 'application/json',
    Referer: 'https://www.szse.cn/',
    'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)',
  }),
});

/* ------------------------------------------------------------------ parsing */

// SSE and SZSE both render numerics as grouped strings ("1,354.49"); SSE's
// margin endpoint is the one that returns real JSON numbers. Reject anything
// else rather than coercing, so a changed field type surfaces as missing data.
// The grouping is validated BEFORE the separators are stripped. Stripping
// first would turn a malformed "1,2," into a confident 12 -- a wrong number is
// far worse here than a missing one, because a missing one degrades visibly.
const GROUPED_NUMBER_RE = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/u;

export function parseExchangeNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!GROUPED_NUMBER_RE.test(trimmed)) return null;
  const parsed = Number(trimmed.replace(/,/gu, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

// Rounded because the exchanges publish two decimals of 亿/万 -- 617.56万笔
// times 1e4 lands on 6175599.999999999 in binary floating point, and a trade
// count is an integer. Source precision is 1e6 CNY, so the rounding is exact
// relative to what was actually published.
function scaled(value, factor) {
  const parsed = parseExchangeNumber(value);
  return parsed === null ? null : Math.round(parsed * factor);
}

export function isoDayFromCompact(value) {
  const compact = String(value ?? '').trim();
  if (!/^\d{8}$/u.test(compact)) return null;
  const day = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  return isoDay(day);
}

export function isoDay(value) {
  const day = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return null;
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === day
    ? day
    : null;
}

export function beijingDay(now) {
  return new Date(now + BEIJING_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/* -------------------------------------------------------------- normalisers */

export function normalizeSseNorthbound(payload) {
  const row = Array.isArray(payload?.result) ? payload.result[0] : null;
  if (!row) return null;
  const tradeDate = isoDayFromCompact(row.tradeDate);
  const turnoverCny = scaled(row.totalAmount, YI);
  if (!tradeDate || turnoverCny === null) return null;
  return {
    tradeDate,
    turnoverCny,
    // totalVolume is 总成交笔数 in 万笔 -- a trade count, not a share count.
    tradeCount: scaled(row.totalVolume, WAN),
    etfTurnoverCny: scaled(row.etfTotalAmount, YI),
  };
}

export function normalizeSseMargin(payload) {
  const rows = Array.isArray(payload?.pageHelp?.data) ? payload.pageHelp.data : [];
  const normalized = [];
  for (const row of rows) {
    const tradeDate = isoDayFromCompact(row?.opDate);
    // SSE quotes margin in yuan already, unlike every other figure here.
    const financingBalanceCny = parseExchangeNumber(row?.rzye);
    if (!tradeDate || financingBalanceCny === null) continue;
    normalized.push({
      tradeDate,
      financingBalanceCny,
      securitiesLendingBalanceCny: parseExchangeNumber(row?.rqylje),
      totalBalanceCny: parseExchangeNumber(row?.rzrqjyzl),
      financingBuyCny: parseExchangeNumber(row?.rzmre),
    });
  }
  normalized.sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1));
  return normalized;
}

// Throws rather than returning null when the payload is not a report envelope
// at all. The probe loop reads null as "that session is not published yet" and
// walks to the next date, so collapsing the two would report an upstream schema
// change as NO_PUBLISHED_TRADE_DATE -- indistinguishable from a market holiday.
function szseReportTab(payload) {
  if (!Array.isArray(payload) || payload.length === 0) throw sourceError('MALFORMED_RESPONSE');
  const tab = payload[0];
  if (!tab || typeof tab !== 'object' || !Array.isArray(tab.data)) {
    throw sourceError('MALFORMED_RESPONSE');
  }
  return tab;
}

export function normalizeSzseNorthbound(payload) {
  const tab = szseReportTab(payload);
  if (!tab) return null;
  const tradeDate = isoDay(tab.metadata?.subname);
  if (!tradeDate || tab.data.length === 0) return null;
  let turnoverCny = null;
  let etfTurnoverCny = null;
  let tradeCount = null;
  for (const entry of tab.data) {
    const label = String(entry?.label ?? '');
    // 当日ETF交易总额 is a strict superset of the 交易总额 substring, so the
    // ETF arm has to be tested first or the headline turnover reads the ETF row.
    if (label.includes('ETF')) {
      etfTurnoverCny = scaled(entry?.total, YI);
    } else if (label.includes('交易总笔数')) {
      tradeCount = scaled(entry?.total, WAN);
    } else if (label.includes('交易总额')) {
      turnoverCny = scaled(entry?.total, YI);
    }
  }
  if (turnoverCny === null) return null;
  return { tradeDate, turnoverCny, tradeCount, etfTurnoverCny };
}

export function normalizeSzseMargin(payload) {
  const tab = szseReportTab(payload);
  if (!tab) return null;
  const tradeDate = isoDay(tab.metadata?.subname);
  const row = tab.data[0];
  if (!tradeDate || !row) return null;
  const financingBalanceCny = scaled(row.jrrzye, YI);
  if (financingBalanceCny === null) return null;
  return {
    tradeDate,
    financingBalanceCny,
    securitiesLendingBalanceCny: scaled(row.jrrjye, YI),
    totalBalanceCny: scaled(row.jrrzrjye, YI),
    financingBuyCny: scaled(row.jrrzmr, YI),
  };
}

export function normalizeSzseTradingCalendar(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const days = [];
  for (const row of rows) {
    // jybz: "1" trading day, "0" closed.
    if (String(row?.jybz) !== '1') continue;
    const day = isoDay(row?.jyrq);
    if (day) days.push(day);
  }
  return days;
}

/* ------------------------------------------------------------ date probing */

function previousMonth(month) {
  const [year, index] = month.split('-').map(Number);
  return index === 1
    ? `${year - 1}-12`
    : `${year}-${String(index - 1).padStart(2, '0')}`;
}

// Used when the exchange calendar itself cannot be fetched. Weekdays cover every
// closure except mainland public holidays, so the probe still lands on a real
// trading day outside holiday weeks and the source degrades visibly inside them.
export function weekdayCandidates(today, limit) {
  const days = [];
  let cursor = Date.parse(`${today}T00:00:00.000Z`);
  while (days.length < limit) {
    const date = new Date(cursor);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(date.toISOString().slice(0, 10));
    cursor -= DAY_MS;
  }
  return days;
}

export function tradingDayCandidates(calendarDays, today, limit = SZSE_MAX_DATE_PROBES) {
  const eligible = [...new Set(calendarDays)]
    .filter((day) => day <= today)
    .sort()
    .reverse();
  return eligible.slice(0, limit);
}

/* --------------------------------------------------------------- transport */

function sseRequestUrl(contract, { tradeDate = '' } = {}) {
  const url = new URL(contract.metadataEndpoint);
  if (contract.queryId) {
    url.searchParams.set('sqlId', contract.queryId);
    url.searchParams.set('tradeDate', tradeDate);
    return url;
  }
  // queryMargin.do returns the newest trading days first; one page is the
  // headline value plus enough backfill to rebuild history after an outage.
  url.searchParams.set('isPagination', 'true');
  url.searchParams.set('tabType', '');
  url.searchParams.set('beginDate', '');
  url.searchParams.set('endDate', '');
  url.searchParams.set('pageHelp.pageSize', String(SSE_MARGIN_PAGE_SIZE));
  url.searchParams.set('pageHelp.pageNo', '1');
  url.searchParams.set('pageHelp.beginPage', '1');
  url.searchParams.set('pageHelp.endPage', '1');
  url.searchParams.set('pageHelp.cacheSize', '1');
  return url;
}

function szseReportUrl(contract, tradeDate) {
  const url = new URL(contract.metadataEndpoint);
  url.searchParams.set('SHOWTYPE', 'JSON');
  url.searchParams.set('CATALOGID', contract.queryId);
  url.searchParams.set('TABKEY', 'tab1');
  // Never omit txtDate: without it the same endpoint returns the full series
  // since 2010 and blows the response ceiling.
  url.searchParams.set('txtDate', tradeDate);
  return url;
}

function szseCalendarUrl(month) {
  const url = new URL(SZSE_TRADING_CALENDAR_ENDPOINT);
  url.searchParams.set('month', month);
  return url;
}

function requestInit(headers, contract, timeoutMs) {
  return {
    headers,
    redirect: contract.redirectPolicy,
    signal: AbortSignal.timeout(timeoutMs),
  };
}

// One bounded direct -> proxy attempt for a single URL. Returns the
// parsed payload plus the routing metadata the decision log needs.
//
// `sticky` makes a multi-probe source pay the escalation once. Without it, a
// source that only works over the proxy would re-walk the whole ladder on
// every date probe -- SZSE_MAX_DATE_PROBES times the full timeout budget, which
// overruns the bundle's per-section allowance. The first hop that works is
// remembered and subsequent probes start there.
async function fetchThroughLadder(url, contract, {
  fetchFn,
  proxyFetchFn,
  headers,
  directTimeoutMs,
  proxyTimeoutMs,
  proxyRetryDelayMs,
  budget,
  sticky = null,
}) {
  const routing = {
    transportPath: 'direct',
    fallbackReason: null,
    proxyFailureReason: null,
    stickyFailureReason: null,
    proxyExitPorts: [],
  };
  const attempt = async (requestFn, timeoutMs) => {
    budget.spend();
    const response = await requestFn(url, requestInit(headers, contract, timeoutMs));
    assertMetadataResponse(response, contract);
    return readBoundedJsonResponse(response, contract.maxResponseBytes);
  };
  const remember = (path) => {
    if (sticky) sticky.preferred = path;
  };

  // The remembered hop is tried first, but a failure here DEMOTES it and falls
  // through to the full ladder rather than aborting: sticky is a latency
  // optimisation, and letting one blip on the remembered hop kill the source
  // would turn it into a single point of failure while other transports work.
  if (sticky?.preferred === 'proxy' && proxyFetchFn) {
    routing.transportPath = 'proxy';
    try {
      const payload = await attempt(
        (input, init) => proxyFetchFn(
          input,
          init,
          0,
          (port) => { routing.proxyExitPorts.push(port); },
        ),
        proxyTimeoutMs,
      );
      return { payload, routing };
    } catch (proxyError) {
      if (errorCodeFor(proxyError) === 'TRANSPORT_BUDGET_EXCEEDED') throw proxyError;
      routing.stickyFailureReason = transportFailureReason(proxyError);
      sticky.preferred = null;
      routing.transportPath = 'direct';
    }
  }

  try {
    const payload = await attempt(fetchFn, directTimeoutMs);
    remember('direct');
    return { payload, routing };
  } catch (directError) {
    routing.fallbackReason = transportFailureReason(directError);
    if (!shouldProxyExchangeFailure(directError)) throw withRouting(directError, routing);

    let proxyError = null;
    if (proxyFetchFn) {
      routing.transportPath = 'proxy';
      for (let index = 0; index < contract.maxProxyRequestsPerRun; index += 1) {
        try {
          const payload = await attempt(
            (input, init) => proxyFetchFn(
              input,
              init,
              index,
              (port) => { routing.proxyExitPorts.push(port); },
            ),
            proxyTimeoutMs,
          );
          remember('proxy');
          return { payload, routing };
        } catch (error) {
          proxyError = error;
          if (
            index + 1 < contract.maxProxyRequestsPerRun
            && shouldRetryExchangeProxyFailure(error)
          ) {
            await new Promise((resolve) => setTimeout(resolve, proxyRetryDelayMs));
            continue;
          }
          break;
        }
      }
      routing.proxyFailureReason = proxyError ? transportFailureReason(proxyError) : null;
    }

    throw withRouting(proxyError ?? directError, routing);
  }
}

function withRouting(error, routing) {
  const failure = sourceError(errorCodeFor(error), error);
  failure.transportPath = routing.transportPath;
  if (routing.fallbackReason) failure.fallbackReason = routing.fallbackReason;
  if (routing.proxyFailureReason) failure.proxyFailureReason = routing.proxyFailureReason;
  if (routing.proxyExitPorts.length) failure.proxyExitPorts = [...routing.proxyExitPorts];
  return failure;
}

// A run deadline is a shared, mutable object so the calendar fetch and both
// SZSE report sources draw down the same wall-clock allowance.
export function createRunDeadline(budgetMs, clock = () => Date.now()) {
  const expiresAt = clock() + budgetMs;
  return {
    expired() {
      return clock() >= expiresAt;
    },
  };
}

function requestBudget(contract, deadline = null) {
  let spent = 0;
  return {
    spend() {
      if (deadline?.expired()) throw sourceError('TRANSPORT_BUDGET_EXCEEDED');
      spent += 1;
      if (spent > contract.maxRequestsPerRun) throw sourceError('REQUEST_BUDGET_EXCEEDED');
    },
    get count() {
      return spent;
    },
  };
}

function outcomeFrom(contract, { observations, routing, requestCount, probedDates = [] }) {
  return {
    sourceId: contract.id,
    ok: true,
    requestCount,
    observations,
    errorCode: null,
    transportPath: routing.transportPath,
    ...(probedDates.length ? { probedDates } : {}),
    ...(routing.fallbackReason ? { fallbackReason: routing.fallbackReason } : {}),
    ...(routing.proxyFailureReason
      ? { proxyFailureReason: routing.proxyFailureReason }
      : {}),
    ...(routing.stickyFailureReason
      ? { stickyFailureReason: routing.stickyFailureReason }
      : {}),
    ...(routing.proxyExitPorts.length
      ? { proxyExitPorts: [...routing.proxyExitPorts] }
      : {}),
  };
}

/* ---------------------------------------------------------------- fetchers */

async function fetchSseSource(contract, { fetchFn, proxyFetchFn, normalize }) {
  const budget = requestBudget(contract);
  const { payload, routing } = await fetchThroughLadder(
    sseRequestUrl(contract),
    contract,
    {
      fetchFn,
      proxyFetchFn,
      headers: REQUEST_HEADERS.sse,
      directTimeoutMs: SSE_DIRECT_TIMEOUT_MS,
      proxyTimeoutMs: SSE_PROXY_TIMEOUT_MS,
      proxyRetryDelayMs: SZSE_PROXY_RETRY_DELAY_MS,
      budget,
    },
  );
  const normalized = normalize(payload);
  const observations = normalized === null
    ? []
    : Array.isArray(normalized) ? normalized : [normalized];
  if (observations.length === 0) throw sourceError('EMPTY_RESULT');
  return outcomeFrom(contract, { observations, routing, requestCount: budget.count });
}

async function withSourceContext(run, budget, probedDates) {
  try {
    return await run();
  } catch (error) {
    error.requestCount ??= budget.count;
    error.probedDates ??= [...probedDates];
    throw error;
  }
}

async function fetchSzseSource(contract, {
  fetchFn,
  proxyFetchFn,
  candidateDates,
  normalize,
  sticky = { preferred: null },
  deadline = null,
}) {
  const budget = requestBudget(contract, deadline);
  const probedDates = [];
  let lastRouting = null;
  for (const tradeDate of candidateDates) {
    probedDates.push(tradeDate);
    // A throw here aborts the whole source deliberately: once a request fails
    // through the full ladder the transport is down, and walking further dates
    // would report NO_PUBLISHED_TRADE_DATE for what is really a network fault.
    // The dial count and probed dates are attached on the way out, or the
    // decision log claims 0 requests for a source that really did try.
    const { payload, routing } = await withSourceContext(() => fetchThroughLadder(
      szseReportUrl(contract, tradeDate),
      contract,
      {
        fetchFn,
        proxyFetchFn,
        headers: REQUEST_HEADERS.szse,
        directTimeoutMs: SZSE_DIRECT_TIMEOUT_MS,
        proxyTimeoutMs: SZSE_PROXY_TIMEOUT_MS,
        proxyRetryDelayMs: SZSE_PROXY_RETRY_DELAY_MS,
        budget,
        sticky,
      },
    ), budget, probedDates);
    lastRouting = routing;
    const normalized = normalize(payload);
    // An empty tab is how SZSE says "that date has not been published yet",
    // which is the normal state for margin before the T+1 release.
    if (normalized) {
      return outcomeFrom(contract, {
        observations: [normalized],
        routing,
        requestCount: budget.count,
        probedDates,
      });
    }
  }
  const error = sourceError('NO_PUBLISHED_TRADE_DATE');
  error.transportPath = lastRouting?.transportPath ?? 'direct';
  error.requestCount = budget.count;
  error.probedDates = probedDates;
  throw error;
}

async function fetchSzseTradingDays(contract, {
  fetchFn,
  proxyFetchFn,
  today,
  sticky,
  deadline = null,
}) {
  // One full escalation is direct + SZSE_MAX_PROXY_ATTEMPTS, and the second
  // month costs one more request through the hop that just worked. Sizing this
  // to exactly one escalation made a degraded-but-working transport abandon the
  // calendar and fall back to weekdays, losing holiday awareness precisely when
  // the run was already struggling.
  const calendarRequestBudget = (1 + SZSE_MAX_PROXY_ATTEMPTS) + CALENDAR_MAX_MONTHS;
  const calendarContract = { ...contract, maxRequestsPerRun: calendarRequestBudget };
  const budget = requestBudget(calendarContract, deadline);
  const months = [today.slice(0, 7)];
  const days = [];
  for (const month of months) {
    const { payload } = await fetchThroughLadder(
      szseCalendarUrl(month),
      calendarContract,
      {
        fetchFn,
        proxyFetchFn,
        headers: REQUEST_HEADERS.szse,
        directTimeoutMs: SZSE_DIRECT_TIMEOUT_MS,
        proxyTimeoutMs: SZSE_PROXY_TIMEOUT_MS,
        proxyRetryDelayMs: SZSE_PROXY_RETRY_DELAY_MS,
        budget,
        sticky,
      },
    );
    days.push(...normalizeSzseTradingCalendar(payload));
    // Early in a month there may not be SZSE_MAX_DATE_PROBES trading days yet,
    // so reach back one month rather than probing days that cannot exist.
    if (
      months.length < CALENDAR_MAX_MONTHS
      && tradingDayCandidates(days, today).length < SZSE_MAX_DATE_PROBES
    ) {
      months.push(previousMonth(month));
    }
  }
  return { days, requestCount: budget.count };
}

/* ----------------------------------------------------------- snapshot build */

function known(value) {
  return { status: 'known', value };
}

function unavailable(reason) {
  return { status: 'unavailable', reason };
}

function valueOrUnavailable(value, reason) {
  return value === null || value === undefined ? unavailable(reason) : known(value);
}

// Every derived metric carries the reason from ITS OWN combine. Reusing the
// headline's reason made a single absent field report EXCHANGE_UNAVAILABLE even
// though both exchanges had answered, pointing the reader at the wrong problem.
function combinedValue(combined) {
  return valueOrUnavailable(combined.value, combined.reason ?? 'EXCHANGE_UNAVAILABLE');
}

function latestObservation(outcome) {
  return outcome?.ok && outcome.observations?.length ? outcome.observations[0] : null;
}

// SSE's margin endpoint returns a page of dated rows while SZSE returns exactly
// one. When SZSE lags by a session, the matching SSE row is already in hand --
// pairing by position would report TRADE_DATE_MISMATCH and throw away a
// perfectly good combined figure we could compute for the older date.
function observationForDate(outcome, tradeDate) {
  if (!outcome?.ok || !Array.isArray(outcome.observations)) return null;
  return outcome.observations.find((row) => row?.tradeDate === tradeDate) ?? null;
}

function alignedPair(sseOutcome, szseOutcome) {
  const sse = latestObservation(sseOutcome);
  const szse = latestObservation(szseOutcome);
  if (!sse || !szse || sse.tradeDate === szse.tradeDate) return [sse, szse];
  // Fall back to the newest session both sides actually published.
  const older = sse.tradeDate < szse.tradeDate ? sse.tradeDate : szse.tradeDate;
  return [
    observationForDate(sseOutcome, older) ?? sse,
    observationForDate(szseOutcome, older) ?? szse,
  ];
}

// The combined figure is only meaningful when both exchanges report the same
// session. Publishing SSE from Tuesday plus SZSE from Monday as one number would
// be silently wrong, so a date mismatch downgrades the combined value instead.
function combineByTradeDate(sse, szse, combiner) {
  if (!sse || !szse) return { value: null, reason: 'EXCHANGE_UNAVAILABLE' };
  if (sse.tradeDate !== szse.tradeDate) {
    return { value: null, reason: 'TRADE_DATE_MISMATCH' };
  }
  const value = combiner(sse, szse);
  // Both exchanges answered for the same session; a null here means one of them
  // omitted the field, which is a different diagnosis from a missing exchange.
  return {
    value,
    tradeDate: sse.tradeDate,
    reason: value === null ? 'INCOMPLETE_EXCHANGE_FIELDS' : null,
  };
}

function sumOrNull(...values) {
  if (values.some((value) => value === null || value === undefined)) return null;
  return values.reduce((total, value) => total + value, 0);
}

// Deliberately raw, unlike the combined figures above. The {status,reason}
// envelope exists because a combined value has several distinct ways to be
// absent -- TRADE_DATE_MISMATCH, EXCHANGE_UNAVAILABLE, INCOMPLETE_EXCHANGE_FIELDS
// -- and a consumer cannot tell them apart from a bare null. A per-exchange
// field has exactly one: the block itself is null when that exchange did not
// answer, so a null INSIDE a present block can only mean the exchange did not
// publish that field. Wrapping it would add no information.
function exchangeBlock(observation) {
  if (!observation) return null;
  return { ...observation };
}

function mergeHistory(previous, additions) {
  const byDay = new Map();
  for (const entry of Array.isArray(previous) ? previous : []) {
    const day = isoDay(entry?.day);
    if (day) byDay.set(day, { ...entry, day });
  }
  for (const entry of additions) {
    const day = isoDay(entry?.day);
    if (!day) continue;
    byDay.set(day, { ...(byDay.get(day) ?? {}), ...entry, day });
  }
  return [...byDay.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, HISTORY_LIMIT);
}

function sourceState(contract, outcome, previousSource, generatedAt) {
  const ok = Boolean(outcome?.ok);
  const lastSuccessAt = ok ? generatedAt : previousSource?.lastSuccessAt ?? null;
  return {
    id: contract.id,
    exchange: contract.exchange,
    series: contract.series,
    label: contract.label,
    publisherId: contract.publisherId,
    publisherName: contract.publisherName,
    endpoint: contract.metadataEndpoint,
    queryId: contract.queryId,
    launchStatus: contract.launchStatus,
    admissionDecision: contract.admissionDecision,
    termsUrl: contract.termsUrl,
    termsNote: contract.termsNote,
    transportStatus: ok ? 'ok' : 'error',
    transportPath: outcome?.transportPath ?? 'direct',
    requestCount: outcome?.requestCount ?? 0,
    errorCode: ok ? null : outcome?.errorCode ?? 'FETCH_FAILED',
    tradeDate: ok ? outcome.observations[0]?.tradeDate ?? null : null,
    checkedAt: generatedAt,
    lastSuccessAt,
    ...(outcome?.probedDates?.length ? { probedDates: outcome.probedDates } : {}),
    ...(outcome?.fallbackReason ? { fallbackReason: outcome.fallbackReason } : {}),
    ...(outcome?.proxyFailureReason
      ? { proxyFailureReason: outcome.proxyFailureReason }
      : {}),
    ...(outcome?.proxyExitPorts?.length
      ? { proxyExitPorts: outcome.proxyExitPorts }
      : {}),
  };
}

export function buildChinaStockConnectSnapshot({
  outcomes,
  previousSnapshot = null,
  calendarStatus = 'exchange',
  generatedAt = new Date().toISOString(),
}) {
  const outcomeMap = new Map(
    (Array.isArray(outcomes) ? outcomes : []).map((outcome) => [outcome.sourceId, outcome]),
  );
  const previousSources = new Map(
    (Array.isArray(previousSnapshot?.sources) ? previousSnapshot.sources : [])
      .map((source) => [source.id, source]),
  );

  const sseNorthbound = latestObservation(outcomeMap.get('sse-northbound'));
  const szseNorthbound = latestObservation(outcomeMap.get('szse-northbound'));
  const [sseMargin, szseMargin] = alignedPair(
    outcomeMap.get('sse-margin'),
    outcomeMap.get('szse-margin'),
  );

  const northboundTurnover = combineByTradeDate(
    sseNorthbound,
    szseNorthbound,
    (sse, szse) => sse.turnoverCny + szse.turnoverCny,
  );
  const marginTotal = combineByTradeDate(
    sseMargin,
    szseMargin,
    (sse, szse) => sumOrNull(sse.totalBalanceCny, szse.totalBalanceCny),
  );
  const marginFinancing = combineByTradeDate(
    sseMargin,
    szseMargin,
    (sse, szse) => sumOrNull(sse.financingBalanceCny, szse.financingBalanceCny),
  );

  const northbound = {
    tradeDate: northboundTurnover.tradeDate ?? null,
    turnoverCny: combinedValue(northboundTurnover),
    etfTurnoverCny: combinedValue(combineByTradeDate(
      sseNorthbound,
      szseNorthbound,
      (sse, szse) => sumOrNull(sse.etfTurnoverCny, szse.etfTurnoverCny),
    )),
    tradeCount: combinedValue(combineByTradeDate(
      sseNorthbound,
      szseNorthbound,
      (sse, szse) => sumOrNull(sse.tradeCount, szse.tradeCount),
    )),
    // Stated on every payload: turnover is gross two-way activity, never a flow.
    netFlow: unavailable(NORTHBOUND_NET_FLOW_UNAVAILABLE_REASON),
    netFlowDiscontinuedOn: NORTHBOUND_NET_FLOW_DISCONTINUED_ON,
    exchanges: {
      sse: exchangeBlock(sseNorthbound),
      szse: exchangeBlock(szseNorthbound),
    },
  };

  const margin = {
    tradeDate: marginTotal.tradeDate ?? null,
    totalBalanceCny: combinedValue(marginTotal),
    financingBalanceCny: combinedValue(marginFinancing),
    securitiesLendingBalanceCny: combinedValue(combineByTradeDate(
      sseMargin,
      szseMargin,
      (sse, szse) => sumOrNull(
        sse.securitiesLendingBalanceCny,
        szse.securitiesLendingBalanceCny,
      ),
    )),
    exchanges: {
      sse: exchangeBlock(sseMargin),
      szse: exchangeBlock(szseMargin),
    },
  };

  const additions = [];
  if (northbound.tradeDate && northboundTurnover.value !== null) {
    additions.push({
      day: northbound.tradeDate,
      northboundTurnoverCny: northboundTurnover.value,
    });
  }
  if (margin.tradeDate && marginTotal.value !== null) {
    additions.push({
      day: margin.tradeDate,
      marginTotalBalanceCny: marginTotal.value,
      ...(marginFinancing.value !== null
        ? { marginFinancingBalanceCny: marginFinancing.value }
        : {}),
    });
  }
  const history = mergeHistory(previousSnapshot?.history, additions);

  const sources = Object.values(STOCK_CONNECT_SOURCE_CONTRACTS).map((contract) =>
    sourceState(
      contract,
      outcomeMap.get(contract.id),
      previousSources.get(contract.id),
      generatedAt,
    ));

  const allSourcesOk = sources.every((source) => source.transportStatus === 'ok');
  const headlinesKnown = northbound.turnoverCny.status === 'known'
    && margin.totalBalanceCny.status === 'known';

  return {
    schemaVersion: 1,
    countryCode: 'CN',
    status: allSourcesOk && headlinesKnown ? 'healthy' : 'degraded',
    generatedAt,
    calendarStatus,
    northbound,
    margin,
    history,
    sources,
  };
}

/* -------------------------------------------------------------- entry point */

export async function fetchChinaStockConnectSnapshot({
  fetchFn = globalThis.fetch,
  proxyUrl = process.env.SZSE_PROXY_URL || process.env.PROXY_URL || '',
  sseProxyUrl = process.env.SSE_PROXY_URL || proxyUrl,
  proxyRequestFn = proxyFetch,
  now = Date.now(),
  // Separate from `now`: `now` stamps the snapshot and may be pinned by a test,
  // while the run budget has to read a real advancing clock.
  clock = () => Date.now(),
  previousSnapshot = null,
  onDecision = (entry) => console.log(JSON.stringify({ event: 'china_stock_connect_source', ...entry })),
} = {}) {
  const proxyFetchFor = (url, contract, timeoutMs) => url
    ? (input, init, attempt = 0, onExitPort = undefined) => fetchViaConfiguredProxy(input, init, {
        proxyUrl: url,
        attempt,
        maxBytes: contract.maxResponseBytes,
        timeoutMs,
        proxyRequestFn,
        onExitPort,
      })
    : null;

  const today = beijingDay(now);
  const szseContract = STOCK_CONNECT_SOURCE_CONTRACTS['szse-northbound'];
  const szseProxyFetchFn = proxyFetchFor(proxyUrl, szseContract, SZSE_PROXY_TIMEOUT_MS);
  // One sticky slot for every www.szse.cn request in the run -- calendar and
  // both report sources share a host, so whichever hop reaches it once reaches
  // it for the rest of the run.
  const szseSticky = { preferred: null };
  const szseCalendarDeadline = createRunDeadline(SZSE_CALENDAR_BUDGET_MS, clock);

  let calendarStatus = 'exchange';
  let candidateDates;
  try {
    const calendar = await fetchSzseTradingDays(szseContract, {
      fetchFn,
      proxyFetchFn: szseProxyFetchFn,
      today,
      sticky: szseSticky,
      deadline: szseCalendarDeadline,
    });
    candidateDates = tradingDayCandidates(calendar.days, today);
    if (candidateDates.length === 0) throw sourceError('EMPTY_TRADING_CALENDAR');
  } catch {
    calendarStatus = 'weekday_fallback';
    candidateDates = weekdayCandidates(today, SZSE_MAX_DATE_PROBES);
  }

  // SZSE first, and contiguously: every szse.cn request draws on one shared
  // wall-clock budget that starts with the calendar fetch, so interleaving the
  // SSE calls would let SSE latency spend SZSE's allowance.
  const plan = [
    ['szse-northbound', (contract) => fetchSzseSource(contract, {
      fetchFn,
      proxyFetchFn: proxyFetchFor(proxyUrl, contract, SZSE_PROXY_TIMEOUT_MS),
      candidateDates,
      sticky: szseSticky,
      deadline: createRunDeadline(SZSE_REPORT_BUDGET_MS, clock),
      normalize: normalizeSzseNorthbound,
    })],
    ['szse-margin', (contract) => fetchSzseSource(contract, {
      fetchFn,
      proxyFetchFn: proxyFetchFor(proxyUrl, contract, SZSE_PROXY_TIMEOUT_MS),
      candidateDates,
      sticky: szseSticky,
      deadline: createRunDeadline(SZSE_REPORT_BUDGET_MS, clock),
      normalize: normalizeSzseMargin,
    })],
    ['sse-northbound', (contract) => fetchSseSource(contract, {
      fetchFn,
      proxyFetchFn: proxyFetchFor(sseProxyUrl, contract, SSE_PROXY_TIMEOUT_MS),
      normalize: normalizeSseNorthbound,
    })],
    ['sse-margin', (contract) => fetchSseSource(contract, {
      fetchFn,
      proxyFetchFn: proxyFetchFor(sseProxyUrl, contract, SSE_PROXY_TIMEOUT_MS),
      normalize: normalizeSseMargin,
    })],
  ];

  const outcomes = [];
  for (const [sourceId, run] of plan) {
    const contract = STOCK_CONNECT_SOURCE_CONTRACTS[sourceId];
    try {
      outcomes.push(await run(contract));
    } catch (error) {
      outcomes.push({
        sourceId,
        ok: false,
        requestCount: error?.requestCount ?? 0,
        errorCode: errorCodeFor(error),
        transportPath: error?.transportPath ?? 'direct',
        ...(error?.probedDates?.length ? { probedDates: error.probedDates } : {}),
        ...(error?.fallbackReason ? { fallbackReason: error.fallbackReason } : {}),
        ...(error?.proxyFailureReason
          ? { proxyFailureReason: error.proxyFailureReason }
          : {}),
        ...(error?.proxyExitPorts?.length
          ? { proxyExitPorts: error.proxyExitPorts }
          : {}),
      });
    }
  }

  const snapshot = buildChinaStockConnectSnapshot({
    outcomes,
    previousSnapshot,
    calendarStatus,
    generatedAt: new Date(now).toISOString(),
  });

  // Emitted BEFORE the per-source entries and separately from them, because the
  // two degradations are independent. A frozen exchange still answers: every
  // source reports ok while the combined value degrades to TRADE_DATE_MISMATCH.
  // Without this entry the log reads "4/4 accepted" during exactly the failure
  // the trade-date agreement check exists to catch, and the only other place
  // that verdict appears is the published Redis key.
  onDecision({
    scope: 'snapshot',
    status: snapshot.status,
    calendarStatus,
    ...(snapshot.northbound.turnoverCny.reason
      ? { northboundReason: snapshot.northbound.turnoverCny.reason }
      : {}),
    ...(snapshot.margin.totalBalanceCny.reason
      ? { marginReason: snapshot.margin.totalBalanceCny.reason }
      : {}),
    ...(snapshot.northbound.tradeDate
      ? { northboundTradeDate: snapshot.northbound.tradeDate }
      : {}),
    ...(snapshot.margin.tradeDate ? { marginTradeDate: snapshot.margin.tradeDate } : {}),
    historyDays: snapshot.history.length,
    generatedAt: snapshot.generatedAt,
  });

  const outcomeMap = new Map(outcomes.map((outcome) => [outcome.sourceId, outcome]));
  for (const source of snapshot.sources) {
    const outcome = outcomeMap.get(source.id);
    onDecision({
      scope: 'source',
      sourceId: source.id,
      status: source.transportStatus === 'ok' ? 'accepted' : 'degraded',
      requestCount: source.requestCount,
      calendarStatus,
      ...(source.errorCode ? { reason: source.errorCode } : {}),
      ...(source.tradeDate ? { tradeDate: source.tradeDate } : {}),
      transportPath: source.transportPath,
      ...(source.probedDates ? { probedDates: source.probedDates } : {}),
      ...(source.fallbackReason ? { fallbackReason: source.fallbackReason } : {}),
      ...(source.proxyFailureReason
        ? { proxyFailureReason: source.proxyFailureReason }
        : {}),
      ...(outcome?.proxyExitPorts?.length
        ? {
            proxyExitPorts: outcome.proxyExitPorts,
            proxyExitRotated: new Set(outcome.proxyExitPorts).size > 1,
          }
        : {}),
      checkedAt: source.checkedAt,
    });
  }
  return snapshot;
}
