#!/usr/bin/env node

/**
 * Bank of Russia (cbr.ru) official rates — issue #6154.
 *
 * RUB had no exchange rate anywhere in the product: seed-fx-rates.mjs quotes 45
 * currencies via Yahoo and seed-ecb-fx-rates.mjs quotes 7 ECB pairs, neither
 * including RUB, and no Russian policy rate was published at all. CBR is the
 * authoritative source for both and needs no key or registration.
 *
 * Two upstream properties silently corrupt this feed if parsed with the defaults
 * every other seeder here uses — both produce a plausible wrong answer rather
 * than an error, so nothing downstream would catch either:
 *
 *   1. `Content-Type: application/xml; charset=windows-1251`. `Response.text()`
 *      assumes UTF-8, turning every Cyrillic currency name into U+FFFD mojibake
 *      while the ASCII numbers survive — the payload looks healthy. Hence
 *      `arrayBuffer()` + an explicit `TextDecoder('windows-1251')`.
 *   2. `<Value>81,1291</Value>` uses a decimal COMMA. `parseFloat('81,1291')`
 *      returns 81, dropping the fraction. Hence `parseCbrDecimal`.
 *
 * And a third: rates are quoted per `<Nominal>` units (JPY per 100, UZS per
 * 10 000), so the per-unit rate is Value / Nominal.
 *
 * All three are locked by tests/seed-cbr-rates.test.mjs against comma-decimal,
 * cp1251-byte, Nominal > 1 fixtures — a dot-decimal or UTF-8 fixture would make
 * those tests vacuous.
 */

import { XMLParser } from 'fast-xml-parser';

import { CHROME_UA, loadEnvFile, runSeed, withRetry } from './_seed-utils.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:cbr-rates:v1';

// 4 days. Must outlive maxStaleMin (4320min = 3d) so a stale-but-present key is
// still readable when health flags it, and must be >= 3x the bundle's daily
// interval so two missed cron ticks cannot expire the key.
const TTL = 4 * 86400;

// Content-age budget. CBR publishes on Russian business days only, and the key
// rate series (this contract's clock — see cbrContentMeta) skips them all. The
// widest routine gap is the New Year non-working period, 1-8 January, which with
// the weekends on either side reaches ~11 calendar days. 14 days clears that
// with margin while still flipping /api/health to STALE_CONTENT roughly a week
// into a genuine freeze.
const CBR_MAX_CONTENT_AGE_MIN = 14 * DAY_MIN;

const DAILY_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
const KEY_RATE_URL = 'https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx';

// How much key-rate history to request. The path is the point of this series —
// CBR moves the key rate in response to sanctions pressure and capital flight,
// so the sequence carries information the spot value does not. ~2 years covers
// several full tightening/easing cycles in a ~3KB response.
const KEY_RATE_HISTORY_DAYS = 730;

const FETCH_TIMEOUT_MS = 20_000;

// `parseTagValue: false` is load-bearing: it keeps every element body a raw
// string so number conversion goes through parseCbrDecimal. Letting the parser
// coerce would hand back 81 for "81,1291" before this file ever sees it.
const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

// ─── Pure parsers (exported for tests) ─────────────────────────────────────────

/**
 * Decode a CBR response body from windows-1251.
 *
 * @param {ArrayBuffer|Uint8Array|Buffer} bytes raw response body
 * @returns {string}
 */
export function decodeCbrXml(bytes) {
  return new TextDecoder('windows-1251').decode(bytes);
}

/**
 * Parse one CBR numeric token. CBR's XML endpoints use a decimal comma; its
 * SOAP endpoint uses a decimal point. Anything else — blanks, `n/a`, thousands
 * separators, trailing junk — is rejected rather than silently truncated.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseCbrDecimal(raw) {
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  if (!/^-?\d+(?:[.,]\d+)?$/.test(token)) return null;
  const value = Number(token.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/**
 * Convert CBR's DD.MM.YYYY to ISO YYYY-MM-DD.
 *
 * Deliberately not `Date.parse` / `new Date(token)`: those read `05.08.2026` as
 * a US-style month-first date in some runtimes, and the day/month swap is
 * invisible for the first twelve days of every month.
 *
 * @param {unknown} token
 * @returns {string|null}
 */
export function cbrDateToIso(token) {
  if (typeof token !== 'string') return null;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(token.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd);
  const month = Number(mm);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/** Strip float noise introduced by division/subtraction without truncating small rates. */
function cleanFloat(value) {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(12));
}

function asArray(node) {
  if (node == null) return [];
  return Array.isArray(node) ? node : [node];
}

/**
 * Parse an `XML_daily.asp` document into the official RUB rate table.
 *
 * Rates are RUB per one unit of the foreign currency: `Value` is quoted per
 * `Nominal` units, so the per-unit rate is Value / Nominal. Rows whose value or
 * nominal is unusable are dropped rather than published as zero or NaN.
 *
 * @param {string} xml windows-1251-decoded document
 * @returns {{date: string|null, rates: Record<string, {rate:number,value:number,nominal:number,name:string,numCode:string,id:string}>}}
 */
export function parseDailyRates(xml) {
  let doc;
  try {
    doc = XML_PARSER.parse(xml);
  } catch {
    return { date: null, rates: {} };
  }

  const valCurs = doc?.ValCurs;
  const date = cbrDateToIso(valCurs?.['@_Date']);
  const rates = {};

  for (const row of asArray(valCurs?.Valute)) {
    const code = typeof row?.CharCode === 'string' ? row.CharCode.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(code)) continue;

    const value = parseCbrDecimal(row?.Value);
    const nominal = parseCbrDecimal(row?.Nominal);
    if (value == null || nominal == null || nominal <= 0) continue;

    const rate = cleanFloat(value / nominal);
    if (!Number.isFinite(rate) || rate <= 0) continue;

    rates[code] = {
      rate,
      value,
      nominal,
      name: typeof row?.Name === 'string' ? row.Name : '',
      numCode: typeof row?.NumCode === 'string' ? row.NumCode : '',
      id: typeof row?.['@_ID'] === 'string' ? row['@_ID'] : '',
    };
  }

  return { date, rates };
}

/**
 * Collect every `{DT, Rate}` row anywhere in a parsed SOAP envelope.
 *
 * The KeyRate response nests the rows under an inline XSD schema plus a
 * `diffgr:diffgram` wrapper. Walking for the shape instead of that exact path
 * keeps the parser working if the .NET serialiser rearranges its envelope.
 */
function collectRateRows(node, out) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectRateRows(child, out);
    return;
  }
  if (typeof node.DT === 'string' && node.Rate != null) {
    out.push(node);
    return;
  }
  for (const child of Object.values(node)) collectRateRows(child, out);
}

/**
 * Parse the `KeyRate` SOAP response into ascending observations.
 *
 * `DT` is midnight Moscow time (`2026-08-04T00:00:00+03:00`), so the calendar
 * date is the leading ten characters — converting to UTC first would shift every
 * observation back a day. This endpoint is UTF-8 with decimal points, unlike the
 * XML endpoints.
 *
 * @param {string} xml
 * @returns {Array<{date: string, value: number}>}
 */
export function parseKeyRateSoap(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') return [];
  let doc;
  try {
    doc = XML_PARSER.parse(xml);
  } catch {
    return [];
  }

  const rows = [];
  collectRateRows(doc, rows);

  const observations = [];
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(row.DT)) continue;
    const value = parseCbrDecimal(row.Rate);
    if (value == null || value < 0) continue;
    observations.push({ date: row.DT.slice(0, 10), value });
  }

  observations.sort((a, b) => a.date.localeCompare(b.date));
  return observations;
}

/**
 * Summarise the key-rate path: the current rate, the previous DIFFERENT rate,
 * and the first date the current rate took effect.
 *
 * `changedAt` is the start of the trailing run at the current value, not the
 * last day at the old one. When the whole window is flat the cut predates the
 * window, so previousRate/change/changedAt are null rather than claiming the
 * oldest observation as a policy move.
 */
function summariseKeyRate(observations) {
  if (!Array.isArray(observations) || observations.length === 0) return null;

  const latest = observations.at(-1);
  let runStart = observations.length - 1;
  while (runStart > 0 && observations[runStart - 1].value === latest.value) runStart--;

  const changed = runStart > 0;
  const previous = changed ? observations[runStart - 1] : null;

  return {
    rate: latest.value,
    date: latest.date,
    previousRate: previous ? previous.value : null,
    previousDate: previous ? previous.date : null,
    changedAt: changed ? observations[runStart].date : null,
    change: previous ? cleanFloat(latest.value - previous.value) : null,
    observations,
  };
}

/**
 * Assemble the canonical payload.
 *
 * `change1d` is null — never 0 — when the previous business day's document was
 * unavailable: the prior-day fetch is best-effort, and a failed fetch rendering
 * as "flat" would be indistinguishable from a genuinely unchanged rate.
 *
 * @param {{daily: {date: string|null, rates: Record<string, object>}, previousDaily: {date: string|null, rates: Record<string, object>}|null, keyRateObservations: Array<{date:string,value:number}>, seededAtMs: number}} input
 */
export function buildCbrPayload({ daily, previousDaily, keyRateObservations, seededAtMs = Date.now() }) {
  const previousRates = previousDaily?.rates ?? null;
  const rates = {};

  for (const [code, entry] of Object.entries(daily?.rates ?? {})) {
    const prior = previousRates?.[code];
    rates[code] = {
      ...entry,
      change1d: prior && Number.isFinite(prior.rate) ? cleanFloat(entry.rate - prior.rate) : null,
    };
  }

  return {
    base: 'RUB',
    date: daily?.date ?? null,
    previousDate: previousRates ? (previousDaily?.date ?? null) : null,
    rates,
    keyRate: summariseKeyRate(keyRateObservations),
    updatedAt: new Date(seededAtMs).toISOString(),
    seededAt: seededAtMs,
  };
}

/**
 * Content-age contract: detect an upstream FREEZE (HTTP 200 forever with the
 * same numbers), which seeder liveness cannot see.
 *
 * The key-rate observation dates are the primary clock, and the FX date is
 * offered alongside them. That ordering matters: CBR publishes TOMORROW's
 * official rate, so on 2026-08-04 the FX document is dated 2026-08-05.
 * tokensToContentMeta drops tokens more than an hour in the future, so an
 * FX-date-only contract would collapse to null — an instant, permanent
 * STALE_CONTENT — on every evening run. Key-rate rows are always dated in the
 * past and stop advancing the moment cbr.ru freezes.
 *
 * @param {object} data canonical payload
 * @param {number} [nowMs] injectable clock for deterministic tests
 */
export function cbrContentMeta(data, nowMs = Date.now()) {
  const tokens = (data?.keyRate?.observations ?? []).map((o) => o?.date);
  tokens.push(data?.date);
  return tokensToContentMeta(tokens, nowMs);
}

/**
 * Fail closed on a half-empty document.
 *
 * The key rate is half of what this seeder publishes, so a keyRate-less payload
 * must not overwrite last-good: runSeed preserves the existing key's TTL when
 * validation rejects, whereas publishing would leave /api/health green over a
 * silently truncated document.
 */
export function validateCbrPayload(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.date !== 'string' || data.date === '') return false;
  if (!Number.isFinite(data.keyRate?.rate)) return false;

  const codes = Object.keys(data.rates ?? {});
  if (codes.length < 3) return false;
  return codes.every((code) => {
    const entry = data.rates[code];
    return Number.isFinite(entry?.rate) && entry.rate > 0;
  });
}

export function declareRecords(data) {
  const rateCount = Object.keys(data?.rates ?? {}).length;
  return rateCount + (Number.isFinite(data?.keyRate?.rate) ? 1 : 0);
}

// ─── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchCbrBytes(url, init = {}) {
  const resp = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/xml, text/xml, */*',
      'User-Agent': CHROME_UA,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`CBR HTTP ${resp.status} for ${url}`);
  return resp.arrayBuffer();
}

/** CBR's `date_req` wants DD/MM/YYYY. */
function isoToCbrDateReq(iso) {
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}/${mm}/${yyyy}`;
}

function previousIsoDate(iso) {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}

async function fetchDailyRates(dateIso) {
  const url = dateIso ? `${DAILY_URL}?date_req=${isoToCbrDateReq(dateIso)}` : DAILY_URL;
  return parseDailyRates(decodeCbrXml(await fetchCbrBytes(url)));
}

async function fetchKeyRateObservations(nowMs) {
  const toDate = new Date(nowMs).toISOString().slice(0, 10);
  const fromDate = new Date(nowMs - KEY_RATE_HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const envelope = '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
    + ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
    + ' xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
    + `<KeyRate xmlns="http://web.cbr.ru/"><fromDate>${fromDate}</fromDate><ToDate>${toDate}</ToDate></KeyRate>`
    + '</soap:Body></soap:Envelope>';

  const bytes = await fetchCbrBytes(KEY_RATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: 'http://web.cbr.ru/KeyRate',
    },
    body: envelope,
  });
  // This endpoint declares (and honours) UTF-8, unlike the XML_*.asp pair.
  return parseKeyRateSoap(new TextDecoder().decode(bytes));
}

async function fetchCbrRates() {
  const seededAtMs = Date.now();

  const daily = await withRetry(() => fetchDailyRates(null), 2, 2000);
  if (!daily.date || Object.keys(daily.rates).length === 0) {
    throw new Error('CBR XML_daily returned no usable rate rows');
  }
  console.log(`  CBR official rates: ${Object.keys(daily.rates).length} currencies effective ${daily.date}`);

  // Best-effort: change1d is a convenience, not the contract. A failure here
  // leaves every change1d null instead of failing the run.
  let previousDaily = null;
  const previousIso = previousIsoDate(daily.date);
  if (previousIso) {
    try {
      const candidate = await fetchDailyRates(previousIso);
      if (candidate.date && Object.keys(candidate.rates).length > 0) previousDaily = candidate;
    } catch (err) {
      console.warn(`  WARN: prior-day rates (${previousIso}) unavailable — change1d will be null: ${err.message || err}`);
    }
  }

  const keyRateObservations = await withRetry(() => fetchKeyRateObservations(seededAtMs), 2, 2000);
  if (keyRateObservations.length === 0) {
    // Fail closed: publishing the FX table without the key rate would overwrite
    // last-good with a half-empty document while health stayed green.
    throw new Error('CBR KeyRate returned no observations');
  }
  const latestKeyRate = keyRateObservations.at(-1);
  console.log(`  CBR key rate: ${latestKeyRate.value}% as of ${latestKeyRate.date} (${keyRateObservations.length} observations)`);

  return buildCbrPayload({ daily, previousDaily, keyRateObservations, seededAtMs });
}

if (process.argv[1]?.endsWith('seed-cbr-rates.mjs')) {
  runSeed('economic', 'cbr-rates', CANONICAL_KEY, fetchCbrRates, {
    validateFn: validateCbrPayload,
    ttlSeconds: TTL,
    sourceVersion: 'cbr-xml-daily+keyrate-soap',
    recordCount: declareRecords,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 4320,
    contentMeta: cbrContentMeta,
    maxContentAgeMin: CBR_MAX_CONTENT_AGE_MIN,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
