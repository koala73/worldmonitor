import { CHROME_UA, httpRetryError } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

// S&P 500 breadth (% of constituents closing above their 20/50/200-day SMA),
// computed from one TradingView screener scan of the index symbol set.
// Barchart's $S5TW/$S5FI/$S5TH pages carried the same three series until
// 2026-09-02, when the site put an AWS WAF challenge (HTTP 202, no body data)
// in front of every quote page.

const SCANNER_URL = 'https://scanner.tradingview.com/america/scan';
const SP500_SYMBOLSET = 'SYML:SP;SPX';
const WINDOWS = [
  { field: 'pctAbove20d', column: 'SMA20' },
  { field: 'pctAbove50d', column: 'SMA50' },
  { field: 'pctAbove200d', column: 'SMA200' },
];
const COLUMNS = ['name', 'close', ...WINDOWS.map((w) => w.column), 'time'];
const TIME_INDEX = COLUMNS.indexOf('time');
const CLOSE_INDEX = 1;
const FIRST_SMA_INDEX = 2;
// Pin the page so a library-default [0, 50] cannot pass the 450-row floor as
// if it were the full index. The live set is ~503 names.
const SCAN_RANGE = [0, 1000];

export const BREADTH_HISTORY_KEY = 'market:breadth-history:v1';
export const HISTORY_LENGTH = 252;
// Daily bars start at the open, before the overnight seed. Allow that extra
// calendar day in the content budget; the existing seed-age budget stays 96h.
export const MAX_SESSION_AGE_MIN = 7200;
const SESSION_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const SESSION_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });

// The index holds ~503 tickers (dual share classes included). A window with
// fewer valid rows than this is a partial scan, and a percentage of a partial
// universe is not S&P 500 breadth.
export const MIN_VALID_CONSTITUENTS = 450;

function scanError(message, { status, nonRetryable = true, retryAfterMs } = {}) {
  const err = new Error(message);
  if (status != null) err.status = status;
  err.nonRetryable = nonRetryable;
  if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
  return err;
}

/**
 * @param {Array<{ s: string, d: Array<string|number|null> }>} rows scanner rows, d = [name, close, SMA20, SMA50, SMA200, time]
 * @returns {{ readings: Record<string, number|null>, constituents: number, valid: Record<string, number> }}
 */
export function computeBreadth(rows, minValid = MIN_VALID_CONSTITUENTS) {
  const readings = {};
  const valid = {};
  WINDOWS.forEach(({ field }, i) => {
    let counted = 0;
    let above = 0;
    for (const row of rows) {
      const close = row?.d?.[CLOSE_INDEX];
      const sma = row?.d?.[FIRST_SMA_INDEX + i];
      if (!Number.isFinite(close) || !Number.isFinite(sma)) continue;
      counted++;
      if (close > sma) above++;
    }
    valid[field] = counted;
    readings[field] = counted >= minValid ? Math.round((above / counted) * 10000) / 100 : null;
  });
  return { readings, constituents: rows.length, valid };
}

export function requireCompleteReadings(readings) {
  if (WINDOWS.some(({ field }) => readings?.[field] == null)) {
    throw scanError('S&P 500 breadth scan produced incomplete readings');
  }
}

export function mergeBreadthHistory(history, readings, today, maxLength = HISTORY_LENGTH) {
  const next = Array.isArray(history) ? history.map((entry) => ({ ...entry })) : [];
  const last = next.at(-1);
  if (last?.date > today) throw scanError(`Breadth session ${today} is older than published ${last.date}`);
  const updatedExisting = last?.date === today;
  if (updatedExisting) {
    last.pctAbove20d = readings.pctAbove20d;
    last.pctAbove50d = readings.pctAbove50d;
    last.pctAbove200d = readings.pctAbove200d;
  } else {
    next.push({
      date: today,
      pctAbove20d: readings.pctAbove20d,
      pctAbove50d: readings.pctAbove50d,
      pctAbove200d: readings.pctAbove200d,
    });
  }
  while (next.length > maxLength) next.shift();
  const currentRow = next.at(-1);
  return {
    history: next,
    current: {
      pctAbove20d: currentRow.pctAbove20d,
      pctAbove50d: currentRow.pctAbove50d,
      pctAbove200d: currentRow.pctAbove200d,
    },
    updatedExisting,
  };
}

export async function readBreadthHistory({
  fetchImpl = fetch,
  url,
  token,
  timeoutMs = 5_000,
} = {}) {
  if (!url || !token) {
    throw scanError('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  }
  const resp = await fetchImpl(`${url}/get/${encodeURIComponent(BREADTH_HISTORY_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (resp.status !== 200) {
    const err = httpRetryError(resp);
    err.message = `Breadth history GET HTTP ${resp.status}`;
    throw err;
  }
  let parsed;
  try {
    parsed = await resp.json();
  } catch {
    throw scanError('Breadth history GET returned not JSON');
  }
  const result = parsed?.result;
  if (!result) return null;
  try {
    return unwrapEnvelope(typeof result === 'string' ? JSON.parse(result) : result).data;
  } catch {
    throw scanError('Breadth history GET returned not an envelope');
  }
}

export async function readPublishedPctAbove200d(opts) {
  const data = await readBreadthHistory(opts);
  const value = data?.current?.pctAbove200d;
  return Number.isFinite(value) ? value : null;
}

export async function fetchSp500Breadth({ fetchImpl = fetch, timeoutMs = 15_000, now = Date.now() } = {}) {
  const resp = await fetchImpl(SCANNER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify({
      symbols: { symbolset: [SP500_SYMBOLSET] },
      columns: COLUMNS,
      range: SCAN_RANGE,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Strict 200: a bot-challenge interstitial arrives as 202 and passes resp.ok.
  if (resp.status !== 200) {
    const err = httpRetryError(resp);
    err.message = `TradingView scan HTTP ${resp.status}`;
    throw err;
  }
  const text = await resp.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw scanError(`TradingView scan returned not a scan payload: ${text.slice(0, 80)}`);
  }
  if (!Array.isArray(body?.data)) {
    throw scanError('TradingView scan returned not a scan payload: missing data rows');
  }
  if (Number.isFinite(body.totalCount) && body.totalCount !== body.data.length) {
    throw scanError(
      `TradingView scan truncated: totalCount=${body.totalCount} data=${body.data.length}`,
    );
  }
  // Score the session most rows share. A halted or delisted constituent keeps
  // its last bar (WBD stayed on 2026-10-05 the next day), so it is left out;
  // a scan split across sessions still fails the constituent floor.
  const bySession = new Map();
  for (const row of body.data) {
    const seconds = row?.d?.[TIME_INDEX];
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > now) continue;
    const date = SESSION_DATE.format(seconds * 1000);
    if (!bySession.has(date)) bySession.set(date, []);
    bySession.get(date).push(row);
  }
  let sessionRows = [];
  for (const rows of bySession.values()) if (rows.length > sessionRows.length) sessionRows = rows;
  if (sessionRows.length < MIN_VALID_CONSTITUENTS) {
    throw scanError('Breadth scan contains missing or mixed source sessions');
  }
  const sourceSessionAt = sessionRows[0].d[TIME_INDEX] * 1000;
  if (now - sourceSessionAt > MAX_SESSION_AGE_MIN * 60_000) {
    throw scanError('Breadth source session is stale');
  }
  const sessionDate = SESSION_DATE.format(sourceSessionAt);
  const breadth = computeBreadth(sessionRows);
  requireCompleteReadings(breadth.readings);
  const weekday = new Date(`${sessionDate}T12:00:00Z`).getUTCDay();
  // A daily bar's timestamp is its open. Wait until the regular close even
  // on early-close days; the twice-daily cron runs outside trading hours.
  if (weekday === 0 || weekday === 6
      || (sessionDate === SESSION_DATE.format(now) && Number(SESSION_HOUR.format(now)) < 16)) {
    throw scanError('Breadth source session has not closed or is not a weekday');
  }
  return { ...breadth, sessionDate, sourceSessionAt, otherSessions: body.data.length - sessionRows.length };
}
