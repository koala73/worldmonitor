import { timingSafeEqualSecret } from '../_crypto.js';
import { jsonResponse } from '../_json-response.js';

export const config = { runtime: 'edge' };

const SZSE_METADATA_URL = 'https://www.szse.cn/api/disc/announcement/annList?random=0.5';
const SZSE_REPORT_URL = 'https://www.szse.cn/api/report/ShowReport/data';
const SZSE_CALENDAR_URL = 'https://www.szse.cn/api/report/exchange/onepersistenthour/monthList';
const SZSE_REQUEST_TIMEOUT_MS = 12_000;
const MAX_REQUEST_BYTES = 2_048;
const MAX_WINDOW_DAYS = 92;
const DAY_MS = 86_400_000;
const EXPECTED_BODY_KEYS = Object.freeze([
  'channelCode',
  'pageNum',
  'pageSize',
  'seDate',
  'stock',
]);

// #6155 routes. The disclosure body above is POSTed verbatim upstream; these two
// are GETs, so the caller sends a description of WHICH allowlisted report it
// wants and this handler builds the URL. A caller-supplied URL is never honoured
// -- that is the whole point of the allowlist.
const SZSE_REPORT_BODY_KEYS = Object.freeze(['catalogId', 'route', 'tabKey', 'txtDate']);
const SZSE_CALENDAR_BODY_KEYS = Object.freeze(['month', 'route']);
const SZSE_REPORT_CATALOG_IDS = Object.freeze([
  'SGT_SGTJYRB', // 深股通交易日报 -- northbound turnover
  '1837_xxpl', // 融资融券交易总量 -- margin balance
]);
// The published series only reach back so far, and a request for a date far in
// the past or the future is a caller bug, not a query.
const MAX_REPORT_AGE_DAYS = 400;
const MAX_REPORT_LEAD_DAYS = 2;

export const SZSE_EGRESS_MAX_RESPONSE_BYTES = 131_072;

function isPlainObject(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function parseIsoDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ''))) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null;
}

function isValidSzseEgressRequest(body) {
  if (!isPlainObject(body)) return false;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(EXPECTED_BODY_KEYS)) return false;
  if (
    !Array.isArray(body.seDate)
    || body.seDate.length !== 2
    || !Array.isArray(body.channelCode)
    || body.channelCode.length !== 1
    || body.channelCode[0] !== 'listedNotice_disc'
    || !Array.isArray(body.stock)
    || body.stock.length !== 1
    || body.stock[0] !== '300750'
    || body.pageSize !== 50
    || body.pageNum !== 1
  ) {
    return false;
  }

  const begin = parseIsoDay(body.seDate[0]);
  const end = parseIsoDay(body.seDate[1]);
  return begin != null
    && end != null
    && begin <= end
    && end - begin <= MAX_WINDOW_DAYS * DAY_MS;
}

function hasExactKeys(body, keys) {
  return JSON.stringify(Object.keys(body).sort()) === JSON.stringify(keys);
}

function withinReportWindow(timestamp, now) {
  return timestamp >= now - MAX_REPORT_AGE_DAYS * DAY_MS
    && timestamp <= now + MAX_REPORT_LEAD_DAYS * DAY_MS;
}

// Returns the upstream URL for an allowlisted #6155 route, or null when the
// body is not one. Every field is validated to an exact literal or a bounded
// pattern; nothing from the caller reaches the URL unchecked.
export function resolveSzseReportRoute(body, now = Date.now()) {
  if (!isPlainObject(body)) return null;

  if (body.route === 'szse-report') {
    if (!hasExactKeys(body, SZSE_REPORT_BODY_KEYS)) return null;
    if (!SZSE_REPORT_CATALOG_IDS.includes(body.catalogId)) return null;
    if (body.tabKey !== 'tab1') return null;
    const day = parseIsoDay(body.txtDate);
    if (day == null || !withinReportWindow(day, now)) return null;
    const url = new URL(SZSE_REPORT_URL);
    url.searchParams.set('SHOWTYPE', 'JSON');
    url.searchParams.set('CATALOGID', body.catalogId);
    url.searchParams.set('TABKEY', body.tabKey);
    // Never relayed without a date: SZSE answers a dateless request with the
    // entire series since 2010, which is neither wanted nor bounded here.
    url.searchParams.set('txtDate', body.txtDate);
    return url;
  }

  if (body.route === 'szse-calendar') {
    if (!hasExactKeys(body, SZSE_CALENDAR_BODY_KEYS)) return null;
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(String(body.month ?? ''))) return null;
    const firstOfMonth = parseIsoDay(`${body.month}-01`);
    if (firstOfMonth == null || !withinReportWindow(firstOfMonth, now)) return null;
    const url = new URL(SZSE_CALENDAR_URL);
    url.searchParams.set('month', body.month);
    return url;
  }

  return null;
}

async function readBoundedBody(message, maxBytes) {
  const contentLength = Number(message.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;

  if (!message.body?.getReader) {
    const bytes = new Uint8Array(await message.arrayBuffer());
    return bytes.byteLength <= maxBytes ? bytes : null;
  }

  const reader = message.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function internalHeaders(contentType = 'application/json') {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  };
}

function upstreamFailureResponse(error) {
  const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
  return jsonResponse(
    { error: timeout ? 'upstream_timeout' : 'upstream_fetch_failed' },
    timeout ? 504 : 502,
    internalHeaders(),
  );
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonResponse(
      { error: 'method_not_allowed' },
      405,
      { ...internalHeaders(), Allow: 'POST' },
    );
  }

  const expected = process.env.RELAY_SHARED_SECRET ?? '';
  const authorization = req.headers.get('authorization') ?? '';
  if (!expected || !(await timingSafeEqualSecret(authorization, `Bearer ${expected}`))) {
    return jsonResponse({ error: 'unauthorized' }, 401, internalHeaders());
  }

  const declaredLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: 'invalid_request' }, 400, internalHeaders());
  }

  let body;
  try {
    const bytes = await readBoundedBody(req, MAX_REQUEST_BYTES);
    if (!bytes) {
      return jsonResponse({ error: 'invalid_request' }, 400, internalHeaders());
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonResponse({ error: 'invalid_request' }, 400, internalHeaders());
  }
  // The disclosure body is checked first so its exact-shape contract is
  // unchanged by the routes added in #6155.
  const isDisclosureRequest = isValidSzseEgressRequest(body);
  const reportUrl = isDisclosureRequest ? null : resolveSzseReportRoute(body);
  if (!isDisclosureRequest && !reportUrl) {
    return jsonResponse({ error: 'invalid_request' }, 400, internalHeaders());
  }

  let upstream;
  try {
    upstream = reportUrl
      ? await fetch(reportUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Referer: 'https://www.szse.cn/',
            'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(SZSE_REQUEST_TIMEOUT_MS),
        })
      : await fetch(SZSE_METADATA_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Referer: 'https://www.szse.cn/',
            'Content-Type': 'application/json',
            'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)',
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(SZSE_REQUEST_TIMEOUT_MS),
        });
  } catch (error) {
    return upstreamFailureResponse(error);
  }

  let bytes;
  try {
    bytes = await readBoundedBody(upstream, SZSE_EGRESS_MAX_RESPONSE_BYTES);
  } catch (error) {
    return upstreamFailureResponse(error);
  }
  if (!bytes) {
    return jsonResponse(
      { error: 'upstream_response_too_large' },
      502,
      internalHeaders(),
    );
  }

  return new Response(bytes, {
    status: upstream.status,
    headers: internalHeaders(upstream.headers.get('content-type') || 'application/json'),
  });
}
