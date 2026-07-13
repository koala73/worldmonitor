export const NBS_CALENDAR_INDEX_URL = 'https://www.stats.gov.cn/english/PressRelease/ReleaseCalendar/';
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
  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
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

async function fetchText(fetchFn, url) {
  const response = await fetchFn(url, {
    headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP_${response.status}`), { status: response.status });
  return response.text();
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
  const trustedOrigin = calendarUrl.origin === 'https://www.stats.gov.cn';
  const trustedPath = calendarUrl.pathname.startsWith('/english/PressRelease/ReleaseCalendar/');
  if (!trustedOrigin || !trustedPath) {
    throw requiredSourceError('NBS_CALENDAR_LINK_REJECTED', 'UNTRUSTED_NBS_CALENDAR_URL');
  }
  return calendarUrl.toString();
}

export async function fetchChinaReleaseCalendar({
  now = Date.now(),
  fetchFn = globalThis.fetch,
  onDecision = (entry) => console.log(JSON.stringify({ event: 'china_calendar_source_preflight', ...entry })),
} = {}) {
  const checkedAt = new Date(now).toISOString();
  const year = new Date(now).getUTCFullYear();
  const sourceDecisions = [];
  const record = (entry) => { sourceDecisions.push(entry); onDecision(entry); };

  let nbsEvents = [];
  let nbsRequestCount = 0;
  try {
    nbsRequestCount += 1;
    const indexHtml = await fetchText(fetchFn, NBS_CALENDAR_INDEX_URL);
    const calendarUrl = currentCalendarLink(indexHtml, year);
    if (calendarUrl !== NBS_CALENDAR_INDEX_URL) nbsRequestCount += 1;
    const calendarHtml = calendarUrl === NBS_CALENDAR_INDEX_URL ? indexHtml : await fetchText(fetchFn, calendarUrl);
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
