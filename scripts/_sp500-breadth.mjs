import { CHROME_UA } from './_seed-utils.mjs';

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
const COLUMNS = ['name', 'close', ...WINDOWS.map((w) => w.column)];
const CLOSE_INDEX = 1;
const FIRST_SMA_INDEX = 2;

// The index holds ~503 tickers (dual share classes included). A window with
// fewer valid rows than this is a partial scan, and a percentage of a partial
// universe is not S&P 500 breadth.
export const MIN_VALID_CONSTITUENTS = 450;

/**
 * @param {Array<{ s: string, d: Array<string|number|null> }>} rows scanner rows, d = [name, close, SMA20, SMA50, SMA200]
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

export async function fetchSp500Breadth({ fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const resp = await fetchImpl(SCANNER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify({ symbols: { symbolset: [SP500_SYMBOLSET] }, columns: COLUMNS }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Strict 200: a bot-challenge interstitial arrives as 202 and passes resp.ok.
  if (resp.status !== 200) throw new Error(`TradingView scan HTTP ${resp.status}`);
  const text = await resp.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`TradingView scan returned not a scan payload: ${text.slice(0, 80)}`);
  }
  if (!Array.isArray(body?.data)) throw new Error('TradingView scan returned not a scan payload: missing data rows');
  return computeBreadth(body.data);
}
