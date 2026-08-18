import { decodeHtmlEntities } from '../_html-entities.mjs';

export const NBS_CALENDAR_INDEX_URL = 'https://www.stats.gov.cn/english/PressRelease/ReleaseCalendar/';
// NBS is a REQUIRED source: any failure aborts the whole run, so a single
// transient socket error costs a full 36h refresh interval against a 4,320min
// (= exactly 2 intervals) freshness budget. Its sibling fetcher for the same
// host — china-macro/source-runtime.mjs `fetchText` — already retries transient
// throws once, which is why seed-china-macro stayed healthy through the same
// window that took this calendar stale.
//
// The retry spend is bounded by a WALL-CLOCK budget across both NBS URLs, not
// by attempt count alone. Attempts x per-request timeout would put the ceiling
// at 2 x 3 x 20s = 120s, which leaves too little of the seeder's 180s lockTtlMs
// for the publish phase. In practice a transient failure fails fast (a DNS or
// connection-refused round trip is ~500ms, so 3 attempts cost ~1.7s including
// backoff) — the 20s ceiling only binds when the host hangs, and that is
// exactly the case the budget caps.
export const NBS_TRANSIENT_FETCH_ATTEMPTS = 3;
export const NBS_REQUEST_TIMEOUT_MS = 20_000;
export const NBS_TRANSIENT_RETRY_DELAY_MS = 500;
export const NBS_TOTAL_FETCH_BUDGET_MS = 75_000;
const NBS_MAX_REDIRECTS = 1;
const NBS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const NBS_ORIGIN = 'https://www.stats.gov.cn';
const NBS_CALENDAR_PATH_PREFIX = '/english/PressRelease/ReleaseCalendar/';
export const CHINAMONEY_LPR_URL = 'https://www.chinamoney.com.cn/chinese/bklpr/?tab=2';
export const CHINAMONEY_LPR_NOTICE_API = 'https://www.chinamoney.com.cn/ags/ms/cm-s-notice-query/contentsinshorttime';
// Official LPR market-notice channel resolved by ChinaMoney's public
// /chinese/cxsymb/index.html channel map (`bklprmkn2`).
const CHINAMONEY_LPR_CHANNEL_ID = '3686';

const HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
]);
const ADJUSTED_WORKDAYS_2026 = new Set(['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']);
const CHINA_BUSINESS_CALENDARS = new Map([
  [2026, { holidays: HOLIDAYS_2026, adjustedWorkdays: ADJUSTED_WORKDAYS_2026 }],
]);

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function stripHtml(value) {
  return decodeHtmlEntities(value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00A0]+/g, ' ')
    .trim();
}

function cellsFromRow(row) {
  return [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => stripHtml(match[1]));
}

export function parseNbsReleaseCalendar(html, year, sourceUrl = NBS_CALENDAR_INDEX_URL) {
  const events = [];
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => cellsFromRow(match[1]));
  for (const cells of rows) {
    if (cells.length < 14 || !/^\d+$/.test(cells[0])) continue;
    const event = cells[1];
    for (let month = 1; month <= 12; month++) {
      const cell = cells[month + 1] || '';
      if (!cell || /^(?:…+|\.{3,})$/.test(cell.replace(/\s/g, ''))) continue;
      const days = [...cell.matchAll(/(?:^|\s)(\d{1,2})\s*\/[A-Za-z]+/g)].map((match) => Number(match[1]));
      const releaseTime = cell.match(/\b(\d{1,2}:\d{2})\b/)?.[1] || '09:30';
      for (const day of days) {
        const releaseDate = isoDate(year, month, day);
        events.push({
          id: `nbs-${String(cells[0]).padStart(2, '0')}-${releaseDate}`,
          event,
          countryCode: 'CN',
          releaseDate,
          releaseTime,
          timezone: 'Asia/Shanghai',
          kind: 'nbs',
          status: 'scheduled',
          source: 'National Bureau of Statistics of China',
          sourceUrl,
        });
      }
    }
  }
  return events.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || a.event.localeCompare(b.event));
}

function businessCalendar(year) {
  const calendar = CHINA_BUSINESS_CALENDARS.get(year);
  if (calendar) return calendar;
  throw Object.assign(new Error(`CHINA_HOLIDAY_CALENDAR_UNAVAILABLE:${year}`), {
    reason: 'CHINA_HOLIDAY_CALENDAR_UNAVAILABLE',
  });
}

function isChinaBusinessDay(date, calendar) {
  const iso = date.toISOString().slice(0, 10);
  if (calendar.adjustedWorkdays.has(iso)) return true;
  if (calendar.holidays.has(iso)) return false;
  const weekday = date.getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

export function buildLprCandidates(year) {
  const calendar = businessCalendar(year);
  const events = [];
  for (let month = 0; month < 12; month++) {
    const date = new Date(Date.UTC(year, month, 20));
    while (!isChinaBusinessDay(date, calendar)) date.setUTCDate(date.getUTCDate() + 1);
    const releaseDate = date.toISOString().slice(0, 10);
    events.push({
      id: `pboc-lpr-${releaseDate.slice(0, 7)}`,
      event: 'Loan Prime Rate (LPR)',
      countryCode: 'CN',
      releaseDate,
      releaseTime: '09:00',
      timezone: 'Asia/Shanghai',
      kind: 'pboc_lpr',
      status: 'provisional',
      source: 'PBoC rule; realized date verified by ChinaMoney/CFETS',
      sourceUrl: CHINAMONEY_LPR_URL,
    });
  }
  return events;
}

export function parseChinaMoneyLprNotices(data) {
  const records = Array.isArray(data?.records) ? data.records : [];
  return [...new Set(records
    .filter((record) => /受权公布贷款市场报价利率.*LPR/i.test(String(record?.title || '')))
    .map((record) => String(record?.releaseDate || '').slice(0, 10))
    .filter((date) => /^20\d{2}-\d{2}-\d{2}$/.test(date)))]
    .sort();
}

export function mergeVerifiedLprDates(candidates, realizedDates) {
  const realizedByMonth = new Map(realizedDates.map((date) => [date.slice(0, 7), date]));
  return candidates.map((candidate) => {
    const realized = realizedByMonth.get(candidate.releaseDate.slice(0, 7));
    return realized ? { ...candidate, releaseDate: realized, status: 'verified', id: `pboc-lpr-${realized.slice(0, 7)}` } : candidate;
  });
}

function sourceDecision(source, host, status, reason, checkedAt, requestCount = 1) {
  return { source, host, status, reason, checkedAt, optional: false, requestCount };
}

function reasonFor(error) {
  if (typeof error?.reason === 'string' && error.reason) return error.reason;
  if (Number.isInteger(error?.status)) return `HTTP_${error.status}`;
  if (error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message))) return 'TIMEOUT';
  return 'FETCH_FAILED';
}

function requiredSourceError(prefix, reason) {
  return Object.assign(new Error(`${prefix}:${reason}`), { reason, nonRetryable: true });
}

function nbsTransportError(reason) {
  return requiredSourceError('NBS_TRANSPORT_REJECTED', reason);
}

function isTrustedNbsCalendarUrl(url) {
  if (url.origin !== NBS_ORIGIN || url.username !== '' || url.password !== '') return false;
  const { pathname } = url;
  // WHATWG leaves %2f / %2e / %5c in pathname, so a prefix check alone would
  // treat encoded traversal as still under the calendar directory.
  if (pathname.includes('%') || pathname.includes('\\') || pathname.split('/').includes('..')) {
    return false;
  }
  return pathname.startsWith(NBS_CALENDAR_PATH_PREFIX);
}

/** `Retry-After` is either delta-seconds or an HTTP date. Null when absent or unparseable. */
function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null;
}

async function fetchText(fetchFn, value, { onRequest, deadlineAt }) {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw nbsTransportError('INVALID_URL');
  }
  if (!isTrustedNbsCalendarUrl(target)) throw nbsTransportError('UNAPPROVED_URL');

  let redirects = 0;
  for (;;) {
    onRequest();
    const response = await fetchFn(target.toString(), {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(NBS_REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= NBS_MAX_REDIRECTS) throw nbsTransportError('REDIRECT_LIMIT_EXCEEDED');
      const location = response.headers?.get?.('Location');
      if (!location) throw nbsTransportError('REDIRECT_WITHOUT_LOCATION');

      let redirectedTarget;
      try {
        redirectedTarget = new URL(location, target);
      } catch {
        throw nbsTransportError('REDIRECT_REJECTED_INVALID_URL');
      }
      if (!isTrustedNbsCalendarUrl(redirectedTarget)) {
        throw nbsTransportError('REDIRECT_REJECTED_UNAPPROVED_URL');
      }
      // Redirects are extra HTTP hops inside one logical retry attempt. Reserve
      // the full per-hop timeout against the same deadline used by retries so
      // a chain cannot spend a fresh wall-clock budget of its own.
      if (Date.now() + NBS_REQUEST_TIMEOUT_MS > deadlineAt) {
        throw nbsTransportError(FETCH_BUDGET_EXHAUSTED_REASON);
      }
      target = redirectedTarget;
      redirects += 1;
      continue;
    }
    if (response.redirected) throw nbsTransportError('IMPLICIT_REDIRECT');
    if (!response.ok) {
      const error = Object.assign(new Error(`HTTP_${response.status}`), { status: response.status });
      // Carry the host's own backoff request out of the response, which is
      // otherwise discarded here — the retry loop cannot honor a hint it never
      // sees, and both sibling helpers (source-runtime.mjs, _seed-utils.mjs) do.
      const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('Retry-After'));
      if (retryAfterMs != null) error.retryAfterMs = retryAfterMs;
      throw error;
    }

    const declaredLength = Number(response.headers?.get?.('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > NBS_MAX_RESPONSE_BYTES) {
      throw nbsTransportError('RESPONSE_TOO_LARGE');
    }
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const chunks = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          received += chunk.byteLength;
          if (received > NBS_MAX_RESPONSE_BYTES) {
            await reader.cancel('response exceeds NBS calendar source limit');
            throw nbsTransportError('RESPONSE_TOO_LARGE');
          }
          chunks.push(decoder.decode(chunk, { stream: true }));
        }
        chunks.push(decoder.decode());
        return chunks.join('');
      } finally {
        reader.releaseLock();
      }
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > NBS_MAX_RESPONSE_BYTES) {
      throw nbsTransportError('RESPONSE_TOO_LARGE');
    }
    return text;
  }
}

// Certificate VALIDATION failures are permanent: they mean the peer is not who
// it claims to be (interception, or an expired/misissued cert), and retrying
// only repeats the request against that same untrusted peer. This is OpenSSL's
// verify-step family as Node surfaces it, plus Node's own altname code.
// Handshake/reset/timeout codes are deliberately absent — those are ordinary
// transport noise and are exactly what the retry exists for.
export const PERMANENT_TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'CERT_CHAIN_TOO_LONG',
  'CRL_SIGNATURE_FAILURE',
  'CRL_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'INVALID_CA',
  'INVALID_PURPOSE',
  'PATH_LENGTH_EXCEEDED',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Reason recorded when the peer's certificate failed validation. */
export const TLS_CERT_UNTRUSTED_REASON = 'TLS_CERT_UNTRUSTED';
/** Reason recorded when the shared NBS wall-clock budget ran out mid-retry. */
export const FETCH_BUDGET_EXHAUSTED_REASON = 'FETCH_BUDGET_EXHAUSTED';

function isCertificateValidationFailure(error) {
  if (PERMANENT_TLS_CODES.has(error?.code) || PERMANENT_TLS_CODES.has(error?.cause?.code)) return true;
  // Message backstop for runtimes that surface a cert failure without a code.
  // Anchored alternatives only — no nested quantifiers to backtrack on.
  const certMessage = `${String(error?.message)} ${String(error?.cause?.message)}`;
  return /self.signed certificate|certificate chain|certificate has expired|unable to verify|altname/i.test(certMessage);
}

/**
 * A fetch that never produced a response — DNS failure, TLS reset, socket
 * hang-up, AbortSignal timeout — is the transient class this retry exists for.
 * A response that arrived carries the verdict in its status: 408/429/5xx are
 * worth another attempt, every other status is a permanent client error and
 * retrying it would only triple the load on an official government host.
 */
function isTransientFetchFailure(error) {
  if (error?.nonRetryable) return false;
  if (Number.isInteger(error?.status)) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599);
  }
  return !isCertificateValidationFailure(error);
}

/**
 * Record WHY we stopped, so an operator can tell an intercepted connection or a
 * spent budget from an ordinary socket blip. `reasonFor` prefers `error.reason`
 * over its generic FETCH_FAILED fallback, and all three land in the audited
 * `china_calendar_source_preflight` decision record.
 */
function tagReason(error, reason) {
  try {
    if (error && !error.reason) error.reason = reason;
  } catch {
    // A frozen error keeps the generic reason; never mask the original failure.
  }
  return error;
}

async function fetchTextWithTransientRetry(fetchFn, url, { onRequest, deadlineAt, sleepFn }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchText(fetchFn, url, { onRequest, deadlineAt });
    } catch (error) {
      if (isCertificateValidationFailure(error)) throw tagReason(error, TLS_CERT_UNTRUSTED_REASON);
      if (attempt >= NBS_TRANSIENT_FETCH_ATTEMPTS || !isTransientFetchFailure(error)) throw error;
      // Grows with the attempt, but never undercuts an explicit Retry-After
      // from the host. An over-long hint is not slept off and is not silently
      // shortened either — honoring it would breach the budget, so the run
      // gives up and the next scheduled run tries again.
      const backoffMs = Math.max(NBS_TRANSIENT_RETRY_DELAY_MS * attempt, error?.retryAfterMs ?? 0);
      // Reserve the next attempt's full timeout. Gating on the sleep's END is
      // not enough: an attempt that merely STARTS before the deadline can run
      // NBS_REQUEST_TIMEOUT_MS past it, and if it succeeds there, the second
      // URL's first attempt (never gated) adds another. That path measured
      // 134s against a claimed 115s ceiling. Reserving the timeout makes every
      // gated attempt END inside the budget, so the ceiling is deadline + one
      // ungated first attempt per URL.
      if (Date.now() + backoffMs + NBS_REQUEST_TIMEOUT_MS > deadlineAt) {
        throw tagReason(error, FETCH_BUDGET_EXHAUSTED_REASON);
      }
      await sleepFn(backoffMs);
    }
  }
}

async function fetchChinaMoneyNotices(fetchFn) {
  const response = await fetchFn(CHINAMONEY_LPR_NOTICE_API, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)',
    },
    body: new URLSearchParams({ channelId: CHINAMONEY_LPR_CHANNEL_ID, pageSize: '24', pageNo: '1' }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP_${response.status}`), { status: response.status });
  return response.json();
}

export function currentCalendarLink(indexHtml, year) {
  const pattern = new RegExp(`href=["']([^"']+)["'][^>]*>[^<]*${year}[^<]*<`, 'i');
  const href = pattern.exec(indexHtml)?.[1];
  if (!href) return NBS_CALENDAR_INDEX_URL;

  let calendarUrl;
  try {
    calendarUrl = new URL(href, NBS_CALENDAR_INDEX_URL);
  } catch {
    throw requiredSourceError('NBS_CALENDAR_LINK_REJECTED', 'UNTRUSTED_NBS_CALENDAR_URL');
  }
  if (!isTrustedNbsCalendarUrl(calendarUrl)) {
    throw requiredSourceError('NBS_CALENDAR_LINK_REJECTED', 'UNTRUSTED_NBS_CALENDAR_URL');
  }
  return calendarUrl.toString();
}

export async function fetchChinaReleaseCalendar({
  now = Date.now(),
  fetchFn = globalThis.fetch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onDecision = (entry) => console.log(JSON.stringify({ event: 'china_calendar_source_preflight', ...entry })),
} = {}) {
  const checkedAt = new Date(now).toISOString();
  const year = new Date(now).getUTCFullYear();
  const sourceDecisions = [];
  const record = (entry) => { sourceDecisions.push(entry); onDecision(entry); };

  let nbsEvents = [];
  let nbsRequestCount = 0;
  // Counted per HTTP HOP, not per logical attempt or URL: redirects and retries
  // are all real requests against the official host and belong in the audit.
  const nbsDeadlineAt = Date.now() + NBS_TOTAL_FETCH_BUDGET_MS;
  const fetchNbsText = (url) => fetchTextWithTransientRetry(fetchFn, url, {
    onRequest: () => { nbsRequestCount += 1; },
    deadlineAt: nbsDeadlineAt,
    sleepFn,
  });
  try {
    const indexHtml = await fetchNbsText(NBS_CALENDAR_INDEX_URL);
    const calendarUrl = currentCalendarLink(indexHtml, year);
    const calendarHtml = calendarUrl === NBS_CALENDAR_INDEX_URL ? indexHtml : await fetchNbsText(calendarUrl);
    nbsEvents = parseNbsReleaseCalendar(calendarHtml, year, calendarUrl);
    if (nbsEvents.length === 0) {
      throw Object.assign(new Error('NO_NBS_EVENTS'), { reason: 'NO_NBS_EVENTS' });
    }
    record(sourceDecision('NBS release calendar', 'www.stats.gov.cn', 'accepted', 'OK', checkedAt, nbsRequestCount));
  } catch (error) {
    const reason = reasonFor(error);
    record(sourceDecision('NBS release calendar', 'www.stats.gov.cn', 'blocked', reason, checkedAt, nbsRequestCount));
    throw requiredSourceError('NBS_REQUIRED_SOURCE_UNAVAILABLE', reason);
  }

  let lprEvents = [];
  try {
    lprEvents = buildLprCandidates(year);
  } catch (error) {
    const reason = reasonFor(error);
    record(sourceDecision('PBoC/ChinaMoney LPR verification', 'www.chinamoney.com.cn', 'blocked', reason, checkedAt, 0));
    throw requiredSourceError('LPR_CALENDAR_SOURCE_UNAVAILABLE', reason);
  }
  try {
    const chinaMoneyNotices = await fetchChinaMoneyNotices(fetchFn);
    lprEvents = mergeVerifiedLprDates(lprEvents, parseChinaMoneyLprNotices(chinaMoneyNotices));
    record(sourceDecision('PBoC/ChinaMoney LPR verification', 'www.chinamoney.com.cn', 'accepted', 'OK', checkedAt));
  } catch (error) {
    record(sourceDecision('PBoC/ChinaMoney LPR verification', 'www.chinamoney.com.cn', 'blocked', reasonFor(error), checkedAt));
  }

  return {
    countryCode: 'CN',
    calendarYear: year,
    generatedAt: checkedAt,
    events: [...nbsEvents, ...lprEvents].sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || a.event.localeCompare(b.event)),
    sourceDecisions,
  };
}
