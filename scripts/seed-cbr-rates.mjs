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
import { DAY_MIN, periodTokenToMs, tokensToContentMeta } from './_content-age-helpers.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:cbr-rates:v1';

// Durable activation marker (no TTL, #4927). Written after the first successful
// publish; until it exists, /api/health softens a missing key from EMPTY/CRIT to
// the on-demand warn. Without it, merging this PR reddens the every-15-minute
// freshness monitor from the moment Vercel ships the reader until
// seed-bundle-macro's next 08:00 UTC tick — up to ~24h of unactionable CRIT.
export const CBR_ACTIVATION_KEY = 'seed-activated:economic:cbr-rates';

// 4 days. Must outlive maxStaleMin (4320min = 3d) so a stale-but-present key is
// still readable when health flags it, and must be >= 3x the bundle's daily
// interval so two missed cron ticks cannot expire the key.
const TTL = 4 * 86400;

// Content-age budget, measured rather than assumed. Across two years of live
// KeyRate rows (509 observations, 2024-08-05..2026-08-04) the largest real
// publication gap is 6 days — the New Year non-working period, 2025-12-30 to
// 2026-01-05 — with the May and February holiday clusters at 4. 14 days is
// therefore a little over 2x the observed maximum: enough that a holiday plus a
// missed cron cannot false-alarm, while still flipping /api/health to
// STALE_CONTENT about a week into a genuine freeze. See cbrContentMeta for which
// clock this is measured against (both of them — the older wins).
const CBR_MAX_CONTENT_AGE_MIN = 14 * DAY_MIN;

const DAILY_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
const KEY_RATE_URL = 'https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx';

// How much key-rate history to request. The path is the point of this series —
// CBR moves the key rate in response to sanctions pressure and capital flight,
// so the sequence carries information the spot value does not. ~2 years covers
// several full tightening/easing cycles in a ~3KB response.
const KEY_RATE_HISTORY_DAYS = 730;

const FETCH_TIMEOUT_MS = 15_000;

// Worst-case fetch ladder, kept provably inside the bundle section budget:
// withRetry(fn, 1, 2000) is 2 attempts, so the daily table costs 2x15s + 2s = 32s,
// the best-effort prior day 15s, and the key rate another 32s — 79s total. runSeed
// wraps fetchFn in its OWN default withRetry (3 retries), so the ladder is only
// bounded by fetchPhaseTimeoutMs; 90s caps it above the 79s design worst case and
// well below the section's timeoutMs, which means a slow cbr.ru aborts through
// runSeed's graceful last-good path instead of being SIGTERM'd mid-fetch by the
// bundle runner (which counts the section as a hard failure).
const FETCH_RETRIES = 1;
const FETCH_PHASE_TIMEOUT_MS = 90_000;

// Bound an untrusted body before it is buffered. The live XML_daily document is
// ~9.5KB and the SOAP history ~3.5KB; 2MB is three orders of magnitude of
// headroom. Without a cap, an oversized or bombed response is buffered whole
// (arrayBuffer -> decoded string -> parsed tree) inside a container shared with
// 16 other bundle sections, so an OOM takes all of them down instead of failing
// this one seeder.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// Minimum currencies for a publishable table. CBR has quoted 54 for years, and a
// body truncated by ddos-guard, a proxy, or a reset connection still parses — a
// 10% truncation of the live document yields 4 well-formed rows. A floor of 3
// would let that overwrite last-good with every monitoring surface green; 30
// tolerates CBR retiring a handful of currencies but not a severed response.
export const MIN_RATE_COUNT = 30;

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
      // Named for what it is, not `value`: for the ~third of the table quoted
      // per 100 or per 10 000 units, a consumer that reaches for a field called
      // `value` over one called `rate` is off by that factor. The name has to
      // carry the distinction, because nothing else in the payload does.
      valuePerNominal: value,
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
 *
 * The series is run-length encoded: CBR repeats the same rate on every business
 * day between decisions, so ~500 daily observations collapse to ~20 steps
 * carrying identical information at a twentieth of the payload. That encoding is
 * split in two — `windowStart` is where the lookback opened (NOT a decision) and
 * `changes` holds only transitions actually observed, so `changes` is
 * legitimately empty for a window with no move.
 *
 * `observedAt` is the newest OBSERVATION date, not the newest step: it is what
 * cbrContentMeta clocks freshness against, and a rate on hold for six months
 * must not read as six-month-old content.
 */
function summariseKeyRate(observations) {
  if (!Array.isArray(observations) || observations.length === 0) return null;

  const latest = observations.at(-1);
  let runStart = observations.length - 1;
  while (runStart > 0 && observations[runStart - 1].value === latest.value) runStart--;

  const changed = runStart > 0;
  const previous = changed ? observations[runStart - 1] : null;

  // Run-length encode, then split the window's left edge away from the real
  // transitions. The oldest observation is where our query window opened, NOT a
  // policy decision — CBR may have been holding that rate for years before it.
  // Emitting it inside the same list as genuine cuts and hikes invites any
  // consumer (a chart, an LLM narrating "the CBR moved on X") to report the
  // lookback boundary as a decision date. `changes` therefore contains only
  // transitions actually observed, and is legitimately empty for a flat window.
  const levels = [];
  for (const obs of observations) {
    if (levels.length === 0 || levels.at(-1).rate !== obs.value) {
      levels.push({ date: obs.date, rate: obs.value });
    }
  }

  return {
    rate: latest.value,
    observedAt: latest.date,
    previousRate: previous ? previous.value : null,
    previousObservedAt: previous ? previous.date : null,
    changedAt: changed ? observations[runStart].date : null,
    change: previous ? cleanFloat(latest.value - previous.value) : null,
    observationCount: observations.length,
    windowStart: levels[0],
    changes: levels.slice(1),
  };
}

/**
 * Assemble the canonical payload.
 *
 * `change1d` is null — never 0 — when the previous business day's document was
 * unavailable: the prior-day fetch is best-effort, and a failed fetch rendering
 * as "flat" would be indistinguishable from a genuinely unchanged rate.
 *
 * The quote direction is stated in the payload rather than left to convention.
 * `base: 'RUB'` would read, under the usual base/quote reading, as "units of X
 * per 1 RUB" — the exact inverse of these numbers (81.13 RUB buys 1 USD). An
 * agent or client that guesses wrong inverts every rate by ~6600x on USD, so
 * `quoteCurrency` + `rateUnit` say it outright.
 *
 * `previousDate` is the calendar day that was REQUESTED for the comparison;
 * `previousEffectiveDate` is the day CBR stamped on the table it returned for it.
 * They differ after a weekend or holiday — `date_req=03/08/2026` answers with the
 * table in force since 01.08.2026 — so reporting only the latter makes a genuine
 * one-day delta look like a three-day move.
 *
 * @param {{daily: {date: string|null, rates: Record<string, object>}, previousDaily: {date: string|null, rates: Record<string, object>}|null, previousRequestedDate?: string|null, keyRateObservations: Array<{date:string,value:number}>, seededAtMs: number}} input
 */
export function buildCbrPayload({
  daily,
  previousDaily,
  previousRequestedDate = null,
  keyRateObservations,
  seededAtMs = Date.now(),
}) {
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
    quoteCurrency: 'RUB',
    rateUnit: 'RUB per 1 unit of the listed currency',
    // `effectiveDate`, not `date`: CBR sets the official rate for the NEXT
    // calendar day, so this is routinely tomorrow. A field called `date` reads
    // as "as of", and a consumer narrating it that way is a day off on every
    // single call — the steady state, not an edge case.
    effectiveDate: daily?.date ?? null,
    previousDate: previousRates
      ? (previousRequestedDate ?? previousIsoDate(daily?.date) ?? null)
      : null,
    previousEffectiveDate: previousRates ? (previousDaily?.date ?? null) : null,
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
 * This payload has TWO independent upstreams — XML_daily.asp and the KeyRate SOAP
 * service — and either can freeze while the other keeps publishing. Handing both
 * sets of dates to one tokensToContentMeta call would reduce them with max(), so
 * the live series would hide the frozen one and the alarm could only ever fire
 * when BOTH died at once. The clocks are therefore derived separately and the
 * contract reports the OLDER of them: both halves must be current for the payload
 * to read as fresh.
 *
 * FX clock: the effective date, clamped to `nowMs`. CBR publishes TOMORROW's
 * official rate, so on 2026-08-04 the document is dated 2026-08-05. An unclamped
 * token is future-dated for part of every day, and tokensToContentMeta drops
 * tokens more than an hour ahead — an FX-date-only contract would collapse to
 * null (instant, permanent STALE_CONTENT) on every evening run. Clamping keeps a
 * live table reading as fresh while a frozen one still ages honestly.
 *
 * Key-rate clock: the newest OBSERVATION date (`observedAt`), never the newest
 * `changes` step — the series is run-length encoded, so a rate on hold for six
 * months has a six-month-old newest step while it is still publishing daily. The
 * step dates only widen the reported span (oldestItemAt).
 *
 * @param {object} data canonical payload
 * @param {number} [nowMs] injectable clock for deterministic tests
 */
export function cbrContentMeta(data, nowMs = Date.now()) {
  const fxMs = periodTokenToMs(data?.effectiveDate);
  const fxClock = Number.isFinite(fxMs) && fxMs > 0 ? Math.min(fxMs, nowMs) : null;

  const keyRateMeta = tokensToContentMeta([
    data?.keyRate?.observedAt,
    data?.keyRate?.windowStart?.date,
    ...(data?.keyRate?.changes ?? []).map((step) => step?.date),
  ], nowMs);

  // Fail closed: a missing clock on either side is "we cannot date this half",
  // which runSeed reads as STALE_CONTENT. That is the correct verdict — it is
  // exactly the state a half-dead payload produces.
  if (fxClock == null || keyRateMeta == null) return null;

  return {
    newestItemAt: Math.min(fxClock, keyRateMeta.newestItemAt),
    oldestItemAt: Math.min(fxClock, keyRateMeta.oldestItemAt),
  };
}

/**
 * Fail closed on a half-empty document.
 *
 * The key rate is half of what this seeder publishes, and MIN_RATE_COUNT is the
 * floor for the other half — a truncated response still parses cleanly into a
 * handful of well-formed rows. Neither may overwrite last-good: runSeed preserves
 * the existing key's TTL when validation rejects, whereas publishing would leave
 * /api/health green over a silently truncated document.
 */
export function validateCbrPayload(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.effectiveDate !== 'string' || data.effectiveDate === '') return false;
  if (!Number.isFinite(data.keyRate?.rate)) return false;

  const codes = Object.keys(data.rates ?? {});
  if (codes.length < MIN_RATE_COUNT) return false;
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

  const declared = Number(resp.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`CBR response too large: ${declared} bytes > ${MAX_RESPONSE_BYTES} for ${url}`);
  }
  const bytes = await resp.arrayBuffer();
  // Re-check after the read: content-length is absent under chunked encoding, so
  // the declared check above is an early-out, not the guarantee.
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error(`CBR response too large: ${bytes.byteLength} bytes > ${MAX_RESPONSE_BYTES} for ${url}`);
  }
  return bytes;
}

/**
 * CBR's `date_req` wants DD/MM/YYYY — the exact inverse of cbrDateToIso.
 *
 * Exported for the same reason cbrDateToIso is tested: a day/month swap here is
 * invisible for the first twelve days of every month, and it would silently
 * request the wrong reference day and publish a plausible-but-wrong change1d.
 *
 * @param {unknown} iso
 * @returns {string|null}
 */
export function isoToCbrDateReq(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * The calendar day before an ISO date, in UTC.
 *
 * @param {unknown} iso
 * @returns {string|null}
 */
export function previousIsoDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
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

/**
 * Orchestrate the three cbr.ru calls into one publishable payload.
 *
 * Exported for tests: the encoding fix lives in the WIRING (arrayBuffer() +
 * decodeCbrXml, not text()), not in any single pure function, so a regression
 * that swapped them back would leave every parser test green.
 */
export async function fetchCbrRates() {
  const seededAtMs = Date.now();

  const daily = await withRetry(() => fetchDailyRates(null), FETCH_RETRIES, 2000);
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

  const keyRateObservations = await withRetry(
    () => fetchKeyRateObservations(seededAtMs), FETCH_RETRIES, 2000,
  );
  if (keyRateObservations.length === 0) {
    // Fail closed: publishing the FX table without the key rate would overwrite
    // last-good with a half-empty document while health stayed green.
    throw new Error('CBR KeyRate returned no observations');
  }
  const latestKeyRate = keyRateObservations.at(-1);
  console.log(`  CBR key rate: ${latestKeyRate.value}% as of ${latestKeyRate.date} (${keyRateObservations.length} observations)`);

  return buildCbrPayload({
    daily,
    previousDaily,
    previousRequestedDate: previousIso,
    keyRateObservations,
    seededAtMs,
  });
}

/**
 * Durable activation marker, written only after a successful publish.
 *
 * Best-effort by design: failing to write the marker must not fail a run that
 * already published good data. The cost of a miss is one more cycle of on-demand
 * softening, not a wrong verdict.
 */
async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', CBR_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: activation marker write failed: ${err?.message || err}`);
  }
}

if (process.argv[1]?.endsWith('seed-cbr-rates.mjs')) {
  runSeed('economic', 'cbr-rates', CANONICAL_KEY, fetchCbrRates, {
    validateFn: validateCbrPayload,
    ttlSeconds: TTL,
    sourceVersion: 'cbr-xml-daily+keyrate-soap',
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 4320,
    contentMeta: cbrContentMeta,
    maxContentAgeMin: CBR_MAX_CONTENT_AGE_MIN,
    fetchPhaseTimeoutMs: FETCH_PHASE_TIMEOUT_MS,
    afterPublish: markActivated,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
