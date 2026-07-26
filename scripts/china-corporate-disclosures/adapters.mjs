import { createRequire } from 'node:module';

import {
  CHINA_CORPORATE_DISCLOSURE_TYPES,
  CHINA_DISCLOSURE_DOCUMENT_HOSTS,
} from '../shared/china-corporate-disclosure-policy.js';

const {
  parseProxyConfig,
  proxyFetch,
} = createRequire(import.meta.url)('../_proxy-utils.cjs');

export const CHINA_CORPORATE_DISCLOSURE_KEY = 'market:china:corporate-disclosures:v1';

export const DISCLOSURE_TYPES = CHINA_CORPORATE_DISCLOSURE_TYPES;
export const EMPTY_RESULT_DEGRADE_AFTER = 3;

export const REVIEWED_DISCLOSURE_ISSUERS = Object.freeze([
  { id: 'issuer:sse:600519', exchange: 'SSE', securityCode: '600519', symbol: '600519.SS', name: 'Kweichow Moutai', nameOriginal: '贵州茅台', mappingConfidence: 1 },
  { id: 'issuer:sse:601318', exchange: 'SSE', securityCode: '601318', symbol: '601318.SS', name: 'Ping An Insurance', nameOriginal: '中国平安', mappingConfidence: 1 },
  { id: 'issuer:sse:600900', exchange: 'SSE', securityCode: '600900', symbol: '600900.SS', name: 'China Yangtze Power', nameOriginal: '长江电力', mappingConfidence: 1 },
  { id: 'issuer:sse:688981', exchange: 'SSE', securityCode: '688981', symbol: '688981.SS', name: 'SMIC', nameOriginal: '中芯国际', mappingConfidence: 1 },
  { id: 'issuer:szse:300750', exchange: 'SZSE', securityCode: '300750', symbol: '300750.SZ', name: 'CATL', nameOriginal: '宁德时代', mappingConfidence: 1 },
  { id: 'issuer:hkex:0700', exchange: 'HKEX', securityCode: '0700', symbol: '0700.HK', name: 'Tencent', nameOriginal: '腾讯控股', mappingConfidence: 1 },
  { id: 'issuer:hkex:1211', exchange: 'HKEX', securityCode: '1211', symbol: '1211.HK', name: 'BYD', nameOriginal: '比亚迪股份', mappingConfidence: 1 },
  { id: 'issuer:hkex:0939', exchange: 'HKEX', securityCode: '0939', symbol: '0939.HK', name: 'China Construction Bank', nameOriginal: '建设银行', mappingConfidence: 1 },
  { id: 'issuer:hkex:0857', exchange: 'HKEX', securityCode: '0857', symbol: '0857.HK', name: 'PetroChina', nameOriginal: '中国石油股份', mappingConfidence: 1 },
].map((issuer) => Object.freeze(issuer)));

export const OFFICIAL_EXCHANGE_SOURCE_CONTRACTS = Object.freeze({
  sse: Object.freeze({
    id: 'sse',
    exchange: 'SSE',
    publisherId: 'publisher:sse-cn',
    publisherName: 'Shanghai Stock Exchange',
    registrySourceName: 'Shanghai Stock Exchange',
    metadataEndpoint: 'https://query.sse.com.cn/security/stock/queryCompanyBulletin.do',
    metadataHost: 'query.sse.com.cn',
    documentHosts: CHINA_DISCLOSURE_DOCUMENT_HOSTS.SSE,
    maxRequestsPerRun: 4,
    maxConcurrentRequests: 2,
    maxResponseBytes: 262_144,
    redirectPolicy: 'error',
    documentRetrieval: 'lazy-link-only',
    // Intentionally do not chase additional pages: the issue contract keeps
    // metadata polling bounded. A saturated first page stays visibly degraded
    // through PAGE_LIMIT_REACHED until the 90-day query window falls below it.
    paginationPolicy: 'bounded_first_page',
    saturationBehavior: 'degraded_on_page_limit',
    emptyResultPolicy: Object.freeze({
      degradeAfterConsecutive: EMPTY_RESULT_DEGRADE_AFTER,
      reason: 'COVERAGE_GAP',
    }),
    launchStatus: 'launched',
    admissionDecision: 'admitted_metadata_only',
    termsUrl: 'https://www.sse.com.cn/home/legal/',
    termsNote: 'Public metadata only; do not ingest or redistribute document bodies. Commercial reuse may require written permission.',
    robots: Object.freeze({ status: 'not_published', httpStatus: 404 }),
    preflight: Object.freeze({
      environment: 'railway-production',
      checkedOn: '2026-07-26',
      reachable: true,
      metadataHttpStatus: 200,
      observedResponseBytes: 143_020,
      documentRedirects: 1,
    }),
  }),
  szse: Object.freeze({
    id: 'szse',
    exchange: 'SZSE',
    publisherId: 'publisher:szse-cn',
    publisherName: 'Shenzhen Stock Exchange',
    registrySourceName: 'Shenzhen Stock Exchange',
    metadataEndpoint: 'https://www.szse.cn/api/disc/announcement/annList',
    metadataHost: 'www.szse.cn',
    documentHosts: CHINA_DISCLOSURE_DOCUMENT_HOSTS.SZSE,
    maxRequestsPerRun: 2,
    maxDirectRequestsPerRun: 1,
    maxProxyRequestsPerRun: 1,
    fallbackPolicy: 'direct_then_proxy_on_transport_failure',
    // Railway registers PROXY_URL as required config for this service: without
    // it the source still runs direct-only (no hard failure), but it loses
    // the one capability this contract exists to provide, so an unset
    // PROXY_URL in production is a deployment gap worth alerting on.
    proxyEnvironmentVariable: 'PROXY_URL',
    maxResponseBytes: 131_072,
    redirectPolicy: 'error',
    documentRetrieval: 'lazy-link-only',
    // Same bounded-first-page policy as SSE; saturation is an explicit health
    // state, not permission to expand the source request budget automatically.
    paginationPolicy: 'bounded_first_page',
    saturationBehavior: 'degraded_on_page_limit',
    emptyResultPolicy: Object.freeze({
      degradeAfterConsecutive: EMPTY_RESULT_DEGRADE_AFTER,
      reason: 'COVERAGE_GAP',
    }),
    launchStatus: 'launched',
    admissionDecision: 'admitted_metadata_only',
    termsUrl: 'https://www.szse.cn/application/laws/',
    termsNote: 'Public metadata only; do not ingest or redistribute document bodies. Commercial reuse may require written permission.',
    robots: Object.freeze({ status: 'empty', httpStatus: 200 }),
    preflight: Object.freeze({
      environment: 'railway-production',
      checkedOn: '2026-07-25',
      reachable: true,
      metadataHttpStatus: 200,
      observedResponseBytes: 2_582,
      documentRedirects: 0,
    }),
  }),
  hkex: Object.freeze({
    id: 'hkex',
    exchange: 'HKEX',
    publisherId: 'publisher:hkex',
    publisherName: 'Hong Kong Exchanges and Clearing',
    registrySourceName: null,
    metadataEndpoint: null,
    metadataHost: null,
    documentHosts: CHINA_DISCLOSURE_DOCUMENT_HOSTS.HKEX,
    maxRequestsPerRun: 0,
    maxResponseBytes: 0,
    redirectPolicy: 'error',
    documentRetrieval: 'blocked',
    launchStatus: 'blocked',
    admissionDecision: 'rejected',
    blockedReason: 'TERMS_PROHIBIT_AUTOMATED_ACCESS',
    termsUrl: 'https://www2.hkexnews.hk/Global/Exchange/Terms-of-Use?sc_lang=en',
    termsNote: 'Terms explicitly prohibit robots, scrapers, programmatic access, and systematic retrieval without written permission.',
    robots: Object.freeze({ status: 'not_published', httpStatus: 404 }),
    preflight: Object.freeze({
      environment: 'railway-production',
      checkedOn: '2026-07-25',
      reachable: true,
      metadataHttpStatus: 200,
      observedResponseBytes: null,
      documentRedirects: null,
    }),
  }),
});

const CLASSIFICATION_PATTERNS = Object.freeze([
  ['resumption', /复牌/u],
  ['halt', /停牌/u],
  ['share_pledge', /质押/u],
  ['investigation', /立案调查|立案告知书|调查通知书/u],
  ['exchange_risk_alert', /风险提示|异常波动|退市风险警示|实施.*风险警示/u],
  ['earnings_warning', /业绩预告|预亏|预增|预减|扭亏/u],
  ['restructuring', /重大资产重组|资产重组/u],
]);

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EVENTS = 100;
const MAX_REVISIONS_PER_EVENT = 20;
const MAX_UNCLASSIFIED_REVISIONS = 100;
// The exchange accepts 100 rows in the same bounded first-page request. The
// reviewed 90-day basket currently reaches 50-55 rows for active issuers, so
// the former 25-row page permanently reported PAGE_LIMIT_REACHED even though
// the complete response remains comfortably below the 256 KiB byte ceiling
// (largest live response observed 2026-07-26: 143,020 bytes).
const SSE_PAGE_SIZE = 100;
const SSE_REQUEST_TIMEOUT_MS = 30_000;
const SZSE_PAGE_SIZE = 50;
// Worst case (direct attempt times out, then the proxy retry also times out)
// this source can take up to SZSE_DIRECT_TIMEOUT_MS + SZSE_PROXY_TIMEOUT_MS
// (~35s) before the bundle moves on. Keep this comfortably inside the
// per-section timeoutMs configured for it in seed-bundle-market-backup.mjs.
const SZSE_DIRECT_TIMEOUT_MS = 15_000;
const SZSE_PROXY_TIMEOUT_MS = 20_000;
const LAUNCHED_SOURCE_FETCHERS = Object.freeze([
  Object.freeze(['sse', fetchSseAnnouncements]),
  Object.freeze(['szse', fetchSzseAnnouncements]),
]);

export function findReviewedDisclosureIssuer(exchange, securityCode) {
  return REVIEWED_DISCLOSURE_ISSUERS.find(
    (issuer) => issuer.exchange === exchange && issuer.securityCode === String(securityCode),
  ) ?? null;
}

export function classifyDisclosureTitle(title) {
  const normalized = String(title ?? '').normalize('NFKC');
  if (!normalized || /业绩说明会/u.test(normalized)) return null;
  for (const [type, pattern] of CLASSIFICATION_PATTERNS) {
    if (pattern.test(normalized)) return type;
  }
  return null;
}

function revisionStateForTitle(title) {
  const normalized = String(title ?? '').normalize('NFKC');
  if (/撤回|取消公告|作废/u.test(normalized)) return 'cancelled';
  if (/更正|修订|补充/u.test(normalized)) return 'corrected';
  return 'original';
}

function subjectKeyForTitle(title, issuer) {
  let normalized = String(title ?? '').normalize('NFKC').trim();
  const quotedOriginal = /[《「『]([^》」』]+)[》」』]/u.exec(normalized);
  if (quotedOriginal && /更正|修订|补充|撤回|取消|作废/u.test(normalized)) {
    normalized = quotedOriginal[1];
  }
  for (const prefix of [issuer.nameOriginal, issuer.name]) {
    if (prefix && normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length);
  }
  normalized = normalized
    .replace(/^[：:\s]+/u, '')
    .replace(/[（(][^）)]*(?:更正|修订|补充|撤回|取消|作废)[^）)]*[）)]/gu, '')
    .replace(/(?:更正|修订|补充|撤回|取消|作废)(?:公告)?$/u, '')
    .replace(/^关于/u, '')
    .replace(/的?公告$/u, '')
    .replace(/[\s：:，,。．、\-—_（）()【】[\]]+/gu, '')
    .toLowerCase();
  return normalized || String(title ?? '').trim();
}

function sourceError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function ensureIsoInstant(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !String(value).includes('T')) throw sourceError(`INVALID_${label}`);
  return new Date(parsed).toISOString();
}

function publicationDay(value) {
  const day = String(value ?? '').slice(0, 10);
  return ISO_DAY_RE.test(day) ? day : null;
}

function sseAnnouncementId(urlPath) {
  const match = /\/([^/]+)\.pdf$/iu.exec(String(urlPath ?? ''));
  return match?.[1] ?? null;
}

function safeSseDocumentUrl(path) {
  const value = String(path ?? '');
  if (!/^\/disclosure\/listedinfo\/announcement\/[a-z0-9/_-]+\.pdf$/iu.test(value)) return null;
  return `https://www.sse.com.cn${value}`;
}

function safeSzseDocumentUrl(path) {
  const value = String(path ?? '');
  if (!/^\/disc\/[a-z0-9/_-]+\.pdf$/iu.test(value)) return null;
  return `https://disc.static.szse.cn/download${value}`;
}

function normalizedAnnouncement({
  sourceId,
  exchange,
  issuer,
  announcementId,
  titleOriginal,
  documentUrl,
  publicationTime,
  retrievalTime,
  metadataUrl,
}) {
  return {
    sourceId,
    exchange,
    issuer,
    announcementId,
    titleOriginal,
    disclosureType: classifyDisclosureTitle(titleOriginal),
    subjectKey: subjectKeyForTitle(titleOriginal, issuer),
    revisionState: revisionStateForTitle(titleOriginal),
    originalLanguage: 'zh-CN',
    translation: { state: 'not_translated' },
    documentUrl,
    metadataUrl,
    publicationTime: { value: publicationTime, precision: 'day' },
    retrievalTime,
    effectiveTime: null,
    confidence: { issuer: 1, classification: 0.98, extraction: 1 },
  };
}

function assertSsePayload(payload) {
  if (
    !Array.isArray(payload?.result)
    || !payload?.pageHelp
    || payload.pageHelp.total == null
    || !Number.isFinite(Number(payload.pageHelp.total))
  ) {
    throw sourceError('MALFORMED_RESPONSE');
  }
  if (payload.result.some((row) => (
    !row
    || !String(row.SECURITY_CODE ?? '').trim()
    || !String(row.TITLE ?? '').trim()
    || !String(row.URL ?? '').trim()
    || !publicationDay(row.SSEDATE)
  ))) {
    throw sourceError('MALFORMED_RESPONSE');
  }
  return Number(payload.pageHelp.total);
}

function assertSzsePayload(payload) {
  if (
    !Array.isArray(payload?.data)
    || payload.announceCount == null
    || !Number.isFinite(Number(payload.announceCount))
  ) {
    throw sourceError('MALFORMED_RESPONSE');
  }
  if (payload.data.some((row) => (
    !row
    || !Array.isArray(row.secCode)
    || row.secCode.length === 0
    || row.annId == null
    || !String(row.title ?? '').trim()
    || !String(row.attachPath ?? '').trim()
    || !publicationDay(row.publishTime)
  ))) {
    throw sourceError('MALFORMED_RESPONSE');
  }
  return Number(payload.announceCount);
}

export function normalizeSseAnnouncements(payload, { retrievedAt = new Date().toISOString() } = {}) {
  assertSsePayload(payload);
  const retrievalTime = ensureIsoInstant(retrievedAt, 'RETRIEVAL_TIME');
  const rows = payload.result;
  const normalized = [];
  for (const row of rows) {
    const issuer = findReviewedDisclosureIssuer('SSE', row?.SECURITY_CODE);
    const announcementId = sseAnnouncementId(row?.URL);
    const documentUrl = safeSseDocumentUrl(row?.URL);
    const published = publicationDay(row?.SSEDATE);
    if (!issuer || !announcementId || !documentUrl || !published || !String(row?.TITLE ?? '').trim()) continue;
    normalized.push(normalizedAnnouncement({
      sourceId: 'sse',
      exchange: 'SSE',
      issuer,
      announcementId,
      titleOriginal: String(row.TITLE).trim(),
      documentUrl,
      publicationTime: published,
      retrievalTime,
      metadataUrl: OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.sse.metadataEndpoint,
    }));
  }
  return normalized;
}

export function normalizeSzseAnnouncements(payload, { retrievedAt = new Date().toISOString() } = {}) {
  assertSzsePayload(payload);
  const retrievalTime = ensureIsoInstant(retrievedAt, 'RETRIEVAL_TIME');
  const rows = payload.data;
  const normalized = [];
  for (const row of rows) {
    const codes = Array.isArray(row?.secCode) ? row.secCode.map(String) : [];
    const issuer = codes
      .map((code) => findReviewedDisclosureIssuer('SZSE', code))
      .find(Boolean) ?? null;
    const announcementId = row?.annId == null ? null : String(row.annId);
    const documentUrl = safeSzseDocumentUrl(row?.attachPath);
    const published = publicationDay(row?.publishTime);
    if (!issuer || !announcementId || !documentUrl || !published || !String(row?.title ?? '').trim()) continue;
    normalized.push(normalizedAnnouncement({
      sourceId: 'szse',
      exchange: 'SZSE',
      issuer,
      announcementId,
      titleOriginal: String(row.title).trim(),
      documentUrl,
      publicationTime: published,
      retrievalTime,
      metadataUrl: OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.metadataEndpoint,
    }));
  }
  return normalized;
}

export async function readBoundedJsonResponse(response, maxBytes) {
  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw sourceError('RESPONSE_TOO_LARGE');
  }
  if (!response?.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw sourceError('RESPONSE_TOO_LARGE');
    try {
      return JSON.parse(text);
    } catch (error) {
      throw sourceError('MALFORMED_RESPONSE', error);
    }
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw sourceError('RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw sourceError('MALFORMED_RESPONSE', error);
  }
}

function assertMetadataResponse(response, contract) {
  if (!response?.ok) throw sourceError(`HTTP_${Number(response?.status) || 0}`);
  if (response.redirected) throw sourceError('REDIRECT_BLOCKED');
  if (response.url) {
    const resolved = new URL(response.url);
    if (resolved.protocol !== 'https:' || resolved.hostname !== contract.metadataHost) {
      throw sourceError('REDIRECT_BLOCKED');
    }
  }
}

function dateWindow(now, days = 90) {
  const end = new Date(now);
  const begin = new Date(now - days * 86_400_000);
  return {
    begin: begin.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function errorCodeFor(error) {
  if (typeof error?.code === 'string') return error.code;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'TIMEOUT';
  if (/timeout/i.test(String(error?.message))) return 'TIMEOUT';
  return 'FETCH_FAILED';
}

function transportFailureReason(error) {
  const causeCode = String(error?.cause?.code ?? '');
  return /^[A-Z][A-Z0-9_]+$/u.test(causeCode)
    ? causeCode
    : errorCodeFor(error);
}

function shouldProxySzseFailure(error) {
  const code = errorCodeFor(error);
  if (code === 'FETCH_FAILED' || code === 'TIMEOUT') return true;
  const status = Number(/^HTTP_(\d{3})$/u.exec(code)?.[1]);
  return status === 403
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

async function fetchViaConfiguredProxy(input, init, {
  proxyUrl,
  maxBytes,
  proxyRequestFn,
}) {
  const proxyConfig = parseProxyConfig(proxyUrl);
  if (!proxyConfig) throw sourceError('PROXY_NOT_CONFIGURED');
  // init.headers carries the same Referer/User-Agent/Content-Type the direct
  // request used (requestInit() below), deliberately: we're routing the exact
  // same declared client through a different egress point, not masquerading
  // as a browser, which matches the source's terms-of-use posture.
  const result = await proxyRequestFn(String(input), proxyConfig, {
    accept: 'application/json',
    headers: init?.headers,
    method: init?.method,
    body: init?.body,
    maxResponseBytes: maxBytes,
    // signal already enforces requestInit()'s timeoutMs; timeoutMs here is a
    // second, independent backstop inside proxyFetch's own socket/tunnel
    // handling in case the AbortSignal doesn't propagate through a stalled
    // CONNECT tunnel. Both are pinned to SZSE_PROXY_TIMEOUT_MS on purpose.
    timeoutMs: SZSE_PROXY_TIMEOUT_MS,
    signal: init?.signal,
  });
  if (result.buffer.byteLength > maxBytes) throw sourceError('RESPONSE_TOO_LARGE');
  return new Response(result.buffer, {
    status: result.status,
    headers: {
      'Content-Length': String(result.buffer.byteLength),
      'Content-Type': result.contentType || 'application/octet-stream',
    },
  });
}

async function fetchSseAnnouncements(fetchFn, now) {
  const contract = OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.sse;
  const issuers = REVIEWED_DISCLOSURE_ISSUERS.filter((issuer) => issuer.exchange === 'SSE');
  const { begin, end } = dateWindow(now);
  const retrievedAt = new Date(now).toISOString();
  const announcements = [];
  const errors = [];
  let contentTruncated = false;
  let successfulRequests = 0;
  let requestCount = 0;
  for (let offset = 0; offset < issuers.length; offset += contract.maxConcurrentRequests) {
    const batch = issuers.slice(offset, offset + contract.maxConcurrentRequests);
    if (requestCount + batch.length > contract.maxRequestsPerRun) {
      throw sourceError('REQUEST_BUDGET_EXCEEDED');
    }
    requestCount += batch.length;
    const outcomes = await Promise.all(batch.map(async (issuer) => {
      const url = new URL(contract.metadataEndpoint);
      const params = {
        isPagination: 'true',
        productId: issuer.securityCode,
        securityType: '0101,120100,020100,020200,120200',
        beginDate: begin,
        endDate: end,
        'pageHelp.pageSize': String(SSE_PAGE_SIZE),
        'pageHelp.pageNo': '1',
        'pageHelp.beginPage': '1',
        'pageHelp.endPage': '1',
      };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      try {
        const response = await fetchFn(url, {
          headers: {
            Accept: 'application/json',
            Referer: 'https://www.sse.com.cn/',
            'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)',
          },
          redirect: contract.redirectPolicy,
          signal: AbortSignal.timeout(SSE_REQUEST_TIMEOUT_MS),
        });
        assertMetadataResponse(response, contract);
        const payload = await readBoundedJsonResponse(response, contract.maxResponseBytes);
        return {
          announcements: normalizeSseAnnouncements(payload, { retrievedAt }),
          contentTruncated: Number(payload.pageHelp.total) > SSE_PAGE_SIZE,
        };
      } catch (error) {
        return { errorCode: errorCodeFor(error) };
      }
    }));

    for (const outcome of outcomes) {
      if (outcome.errorCode) {
        errors.push(outcome.errorCode);
        continue;
      }
      announcements.push(...outcome.announcements);
      if (outcome.contentTruncated) contentTruncated = true;
      successfulRequests += 1;
    }
  }
  const transportOk = errors.length === 0;
  return {
    sourceId: 'sse',
    ok: transportOk && !contentTruncated,
    partial: successfulRequests > 0 && (!transportOk || contentTruncated),
    transportOk,
    requestCount,
    announcements,
    errorCode: errors[0] ?? (contentTruncated ? 'PAGE_LIMIT_REACHED' : null),
  };
}

async function fetchSzseAnnouncements(fetchFn, now, {
  proxyFetchFn = null,
} = {}) {
  const contract = OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse;
  const { begin, end } = dateWindow(now);
  const retrievedAt = new Date(now).toISOString();
  const issuers = REVIEWED_DISCLOSURE_ISSUERS.filter((issuer) => issuer.exchange === 'SZSE');
  const url = new URL(contract.metadataEndpoint);
  url.searchParams.set('random', '0.5');
  const body = JSON.stringify({
    seDate: [begin, end],
    channelCode: ['listedNotice_disc'],
    stock: issuers.map((issuer) => issuer.securityCode),
    pageSize: SZSE_PAGE_SIZE,
    pageNum: 1,
  });
  const requestInit = (timeoutMs) => ({
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Referer: 'https://www.szse.cn/',
      'Content-Type': 'application/json',
      'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)',
    },
    body,
    redirect: contract.redirectPolicy,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const request = async (requestFn, timeoutMs) => {
    const response = await requestFn(url, requestInit(timeoutMs));
    assertMetadataResponse(response, contract);
    const payload = await readBoundedJsonResponse(response, contract.maxResponseBytes);
    return {
      payload,
      announcements: normalizeSzseAnnouncements(payload, { retrievedAt }),
    };
  };

  let fetched;
  let requestCount = 1;
  let transportPath = 'direct';
  let fallbackReason = null;
  try {
    fetched = await request(fetchFn, SZSE_DIRECT_TIMEOUT_MS);
  } catch (directError) {
    fallbackReason = transportFailureReason(directError);
    if (!proxyFetchFn || !shouldProxySzseFailure(directError)) throw directError;
    requestCount += 1;
    transportPath = 'proxy';
    try {
      fetched = await request(proxyFetchFn, SZSE_PROXY_TIMEOUT_MS);
    } catch (proxyError) {
      const failure = sourceError(errorCodeFor(proxyError), proxyError);
      failure.requestCount = requestCount;
      failure.transportPath = transportPath;
      failure.fallbackReason = fallbackReason;
      failure.proxyFailureReason = transportFailureReason(proxyError);
      throw failure;
    }
  }

  const contentTruncated = Number(fetched.payload.announceCount) > SZSE_PAGE_SIZE;
  return {
    sourceId: 'szse',
    ok: !contentTruncated,
    partial: contentTruncated,
    transportOk: true,
    requestCount,
    announcements: fetched.announcements,
    errorCode: contentTruncated ? 'PAGE_LIMIT_REACHED' : null,
    transportPath,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function previousAnnouncements(snapshot) {
  const announcements = [];
  for (const event of Array.isArray(snapshot?.events) ? snapshot.events : []) {
    for (const revision of Array.isArray(event?.history) ? event.history : []) {
      const revisionSequence = Number(revision?.provenance?.claims?.revision?.value?.sequence);
      const classification = revision?.provenance?.claims?.classification_confidence?.value;
      const extraction = revision?.provenance?.claims?.extraction_confidence?.value;
      announcements.push({
        eventGroupId: event.id,
        historyTruncated: event.historyTruncated === true,
        sourceId: String(event.exchange).toLowerCase(),
        exchange: event.exchange,
        issuer: event.issuer,
        announcementId: revision.announcementId,
        titleOriginal: revision.titleOriginal,
        disclosureType: event.disclosureType,
        subjectKey: event.subjectKey,
        revisionState: revision.revisionState,
        originalLanguage: event.originalLanguage,
        translation: event.translation,
        documentUrl: revision.documentUrl,
        metadataUrl: revision.metadataUrl,
        publicationTime: revision.publicationTime,
        retrievalTime: revision.retrievalTime,
        effectiveTime: event.effectiveTime,
        confidence: {
          ...event.confidence,
          ...(Number.isFinite(classification?.score)
            ? { classification: classification.score }
            : {}),
          ...(Number.isFinite(extraction?.score)
            ? { extraction: extraction.score }
            : {}),
        },
        ...(typeof classification?.method === 'string'
          ? { classificationMethod: classification.method }
          : {}),
        ...(Number.isInteger(revisionSequence) && revisionSequence > 0
          ? { revisionSequence }
          : {}),
      });
    }
  }
  for (const revision of Array.isArray(snapshot?.unclassifiedRevisions)
    ? snapshot.unclassifiedRevisions
    : []) {
    announcements.push({
      ...revision,
      disclosureType: null,
    });
  }
  return announcements;
}

function nextEmptyResultCount(outcome, previous) {
  const previousCount = Number.isInteger(previous?.emptyResultCount)
    ? Math.max(0, previous.emptyResultCount)
    : 0;
  const transportSucceeded = outcome?.ok === true
    || (outcome?.partial === true && outcome?.transportOk === true);
  if (!transportSucceeded) return previousCount;
  return Array.isArray(outcome.announcements) && outcome.announcements.length > 0
    ? 0
    : previousCount + 1;
}

function sourceStates(outcomes, previousSnapshot, generatedAt) {
  const outcomeMap = new Map(outcomes.map((outcome) => [outcome.sourceId, outcome]));
  const previousMap = new Map(
    (Array.isArray(previousSnapshot?.sources) ? previousSnapshot.sources : [])
      .map((source) => [source.id, source]),
  );
  return Object.values(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS).map((contract) => {
    const { id } = contract;
    if (contract.launchStatus === 'blocked') {
      return {
        id,
        exchange: contract.exchange,
        launchStatus: 'blocked',
        transportStatus: 'not_applicable',
        contentStatus: 'not_applicable',
        checkedAt: generatedAt,
        lastSuccessAt: null,
        requestCount: 0,
        transportPath: 'not_applicable',
        emptyResultCount: 0,
        errorCode: contract.blockedReason,
      };
    }
    const outcome = outcomeMap.get(id);
    const previous = previousMap.get(id);
    const emptyResultCount = nextEmptyResultCount(outcome, previous);
    const coverageGap = emptyResultCount >= EMPTY_RESULT_DEGRADE_AFTER;
    if (outcome?.ok) {
      return {
        id,
        exchange: contract.exchange,
        launchStatus: 'launched',
        transportStatus: 'fresh',
        contentStatus: coverageGap ? 'partial' : 'current',
        checkedAt: generatedAt,
        lastSuccessAt: generatedAt,
        requestCount: outcome.requestCount,
        transportPath: outcome.transportPath ?? 'direct',
        ...(outcome.fallbackReason ? { fallbackReason: outcome.fallbackReason } : {}),
        emptyResultCount,
        errorCode: coverageGap ? 'COVERAGE_GAP' : null,
      };
    }
    if (outcome?.partial) {
      const transportSucceeded = outcome.transportOk === true;
      return {
        id,
        exchange: contract.exchange,
        launchStatus: 'launched',
        transportStatus: outcome.transportOk ? 'fresh' : 'error',
        contentStatus: 'partial',
        checkedAt: generatedAt,
        lastSuccessAt: transportSucceeded ? generatedAt : previous?.lastSuccessAt ?? null,
        requestCount: outcome.requestCount,
        transportPath: outcome.transportPath ?? 'direct',
        ...(outcome.fallbackReason ? { fallbackReason: outcome.fallbackReason } : {}),
        emptyResultCount,
        errorCode: outcome.errorCode ?? (coverageGap ? 'COVERAGE_GAP' : 'PARTIAL_FETCH'),
      };
    }
    return {
      id,
      exchange: contract.exchange,
      launchStatus: 'launched',
      transportStatus: 'error',
      contentStatus: previous?.lastSuccessAt ? 'stale' : 'unavailable',
      checkedAt: generatedAt,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      requestCount: outcome?.requestCount ?? 0,
      transportPath: outcome?.transportPath ?? 'direct',
      ...(outcome?.fallbackReason ? { fallbackReason: outcome.fallbackReason } : {}),
      ...(outcome?.proxyFailureReason
        ? { proxyFailureReason: outcome.proxyFailureReason }
        : {}),
      emptyResultCount,
      errorCode: outcome?.errorCode ?? 'NOT_ATTEMPTED',
    };
  });
}

function known(value) {
  return { status: 'known', value };
}

function unavailable(status, reason) {
  return { status, reason };
}

function publisherForSource(sourceId) {
  const contract = OFFICIAL_EXCHANGE_SOURCE_CONTRACTS[sourceId];
  return {
    id: contract.publisherId,
    name: contract.publisherName,
    type: 'official_exchange',
    registryReference: {
      sourceName: contract.registrySourceName,
      sourceType: 'market',
      propagandaRisk: 'high',
    },
  };
}

function buildProvenance(
  revision,
  sequence,
  nextRevision,
  sourceState,
  generatedAt,
) {
  const signalId = `signal:china-disclosure:${revision.exchange.toLowerCase()}:${revision.issuer.securityCode}:${revision.announcementId}`;
  const nextSignalId = nextRevision
    ? `signal:china-disclosure:${nextRevision.exchange.toLowerCase()}:${nextRevision.issuer.securityCode}:${nextRevision.announcementId}`
    : null;
  const isCancelled = !nextRevision && revision.revisionState === 'cancelled';
  const supersession = nextRevision
    ? { state: 'superseded', relatedSignalId: nextSignalId }
    : isCancelled
      ? { state: 'cancelled', reason: 'The official exchange published a cancellation or withdrawal notice.' }
      : { state: 'current' };
  const revisionState = sequence === 1
    ? 'original'
    : revision.revisionState === 'corrected'
      ? 'corrected'
      : 'revised';
  const transportValue = {
    state: sourceState.transportStatus === 'fresh' ? 'fresh' : 'error',
    assessedAt: generatedAt,
    ...(sourceState.lastSuccessAt ? { lastSuccessAt: sourceState.lastSuccessAt } : {}),
  };
  const contentState = sourceState.contentStatus === 'current'
    ? 'current'
    : sourceState.contentStatus === 'partial'
      ? 'partial'
      : 'stale';
  return {
    contractVersion: 'decision-signal-provenance/v1',
    signalId,
    familyId: 'exchange_disclosure',
    claims: {
      publisher: known(publisherForSource(revision.sourceId)),
      source_url: known(revision.documentUrl),
      original_reference: known({
        kind: 'document',
        id: `${revision.sourceId}:${revision.announcementId}`,
      }),
      original_language: known('zh-CN'),
      translation: known({ state: 'not_translated' }),
      observation_time: unavailable('not_applicable', 'An exchange disclosure is a published document, not an observation.'),
      effective_time: unavailable('unknown', 'The metadata does not declare a separate effective time.'),
      publication_time: known({
        role: 'publication',
        value: revision.publicationTime.value,
        precision: revision.publicationTime.precision,
      }),
      retrieval_time: known({
        role: 'retrieval',
        value: revision.retrievalTime,
        precision: 'instant',
      }),
      revision: known({
        vintageId: `${revision.sourceId}:${revision.announcementId}`,
        sequence,
        state: revisionState,
      }),
      supersession: known(supersession),
      extraction_confidence: known({
        score: revision.confidence.extraction,
        method: 'official-exchange-metadata-parser/v1',
      }),
      classification_confidence: known({
        score: revision.confidence.classification,
        method: revision.classificationMethod
          ?? 'china-exchange-disclosure-title-taxonomy/v1',
      }),
      corroboration: unavailable('unknown', 'News may corroborate this event but never substitutes for the official exchange record.'),
      transport_freshness: known(transportValue),
      content_freshness: known({
        state: contentState,
        assessedAt: generatedAt,
        contentAsOf: revision.publicationTime.value,
      }),
      derivation: unavailable('not_applicable', 'This signal is normalized directly from official exchange metadata.'),
    },
  };
}

function buildEvents(announcements, sources, generatedAt) {
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const deduped = new Map();
  for (const announcement of announcements) {
    if (!announcement?.announcementId) continue;
    if (!announcement.disclosureType && announcement.revisionState === 'original') continue;
    const key = `${announcement.exchange}:${announcement.announcementId}`;
    const existing = deduped.get(key);
    deduped.set(key, existing
      ? {
          ...announcement,
          disclosureType: announcement.disclosureType ?? existing.disclosureType ?? null,
          ...(!announcement.eventGroupId && existing.eventGroupId
            ? { eventGroupId: existing.eventGroupId }
            : {}),
          ...(!announcement.revisionSequence && existing.revisionSequence
            ? { revisionSequence: existing.revisionSequence }
            : {}),
          ...(existing.historyTruncated ? { historyTruncated: true } : {}),
        }
      : announcement);
  }

  const ordered = [...deduped.values()].sort((left, right) => (
    left.publicationTime.value.localeCompare(right.publicationTime.value)
    || left.retrievalTime.localeCompare(right.retrievalTime)
    || left.announcementId.localeCompare(right.announcementId)
  ));
  const groups = new Map();
  const unclassifiedRevisions = [];
  for (const announcement of ordered) {
    let revision = announcement;
    let key = revision.eventGroupId;
    if (!key && revision.revisionState !== 'original') {
      const candidateKeys = [];
      for (const [candidateKey, revisions] of groups) {
        const latest = revisions.at(-1);
        if (
          latest.exchange === revision.exchange
          && latest.issuer.id === revision.issuer.id
          && (!revision.disclosureType || latest.disclosureType === revision.disclosureType)
          && latest.subjectKey === revision.subjectKey
        ) {
          candidateKeys.push(candidateKey);
        }
      }
      if (candidateKeys.length === 1) {
        key = candidateKeys[0];
        if (!revision.disclosureType) {
          const inheritedType = groups.get(key).at(-1).disclosureType;
          revision = {
            ...revision,
            disclosureType: inheritedType,
            confidence: {
              ...revision.confidence,
              classification: Math.min(revision.confidence.classification, 0.75),
            },
            classificationMethod: 'issuer-subject-lineage/v1',
          };
        }
      }
    }
    if (!revision.disclosureType) {
      unclassifiedRevisions.push({
        sourceId: revision.sourceId,
        exchange: revision.exchange,
        issuer: revision.issuer,
        announcementId: revision.announcementId,
        titleOriginal: revision.titleOriginal,
        subjectKey: revision.subjectKey,
        revisionState: revision.revisionState,
        originalLanguage: revision.originalLanguage,
        translation: revision.translation,
        documentUrl: revision.documentUrl,
        metadataUrl: revision.metadataUrl,
        publicationTime: revision.publicationTime,
        retrievalTime: revision.retrievalTime,
        confidence: {
          ...revision.confidence,
          classification: 0,
        },
        lineage: {
          status: 'partial',
          reason: 'No unique owned-category filing matched this official revision.',
        },
        decisionCode: 'UNCLASSIFIED_REVISION',
      });
      continue;
    }
    key ??= `china-disclosure:${revision.exchange.toLowerCase()}:${revision.issuer.securityCode}:${revision.announcementId}`;
    const group = groups.get(key) ?? [];
    group.push(revision);
    groups.set(key, group);
  }

  const events = [];
  for (const allRevisions of groups.values()) {
    const sequences = [];
    let previousSequence = 0;
    for (const revision of allRevisions) {
      const declaredSequence = Number(revision.revisionSequence);
      const minimumSequence = previousSequence > 0
        ? previousSequence + 1
        : revision.revisionState === 'original'
          ? 1
          : 2;
      const sequence = Number.isInteger(declaredSequence) && declaredSequence >= minimumSequence
        ? declaredSequence
        : minimumSequence;
      sequences.push(sequence);
      previousSequence = sequence;
    }
    const historyTruncated = allRevisions.some((revision) => revision.historyTruncated)
      || allRevisions.length > MAX_REVISIONS_PER_EVENT;
    const retainedIndexes = allRevisions.length <= MAX_REVISIONS_PER_EVENT
      ? allRevisions.map((_, index) => index)
      : [
          0,
          ...allRevisions
            .slice(-(MAX_REVISIONS_PER_EVENT - 1))
            .map((_, index) => allRevisions.length - (MAX_REVISIONS_PER_EVENT - 1) + index),
        ];
    const revisions = retainedIndexes.map((index) => allRevisions[index]);
    const retainedSequences = retainedIndexes.map((index) => sequences[index]);
    const hasOriginalRevision = revisions[0].revisionState === 'original';
    const history = revisions.map((revision, index) => {
      const provenance = buildProvenance(
        revision,
        retainedSequences[index],
        revisions[index + 1],
        sourceMap.get(revision.sourceId),
        generatedAt,
      );
      return {
        announcementId: revision.announcementId,
        titleOriginal: revision.titleOriginal,
        documentUrl: revision.documentUrl,
        metadataUrl: revision.metadataUrl,
        publicationTime: revision.publicationTime,
        retrievalTime: revision.retrievalTime,
        revisionState: index === 0 && revision.revisionState === 'original'
          ? 'original'
          : revision.revisionState,
        provenance,
      };
    });
    const latest = revisions.at(-1);
    const latestHistory = history.at(-1);
    const status = latest.revisionState === 'cancelled'
      ? 'cancelled'
      : latest.revisionState === 'corrected'
        ? 'corrected'
        : 'current';
    events.push({
      id: `china-disclosure:${latest.exchange.toLowerCase()}:${latest.issuer.securityCode}:${revisions[0].announcementId}`,
      exchange: latest.exchange,
      issuer: latest.issuer,
      announcementId: latest.announcementId,
      disclosureType: latest.disclosureType,
      subjectKey: latest.subjectKey,
      titleOriginal: latest.titleOriginal,
      originalLanguage: latest.originalLanguage,
      translation: latest.translation,
      documentUrl: latest.documentUrl,
      publicationTime: latest.publicationTime,
      retrievalTime: latest.retrievalTime,
      effectiveTime: null,
      status,
      lineage: hasOriginalRevision
        ? { status: 'complete' }
        : {
            status: 'partial',
            reason: 'The referenced original filing is outside retained official metadata.',
          },
      confidence: latest.confidence,
      history,
      historyTruncated,
      provenance: latestHistory.provenance,
    });
  }
  return {
    events: events
      .sort((left, right) => (
        right.publicationTime.value.localeCompare(left.publicationTime.value)
        || right.announcementId.localeCompare(left.announcementId)
      ))
      .slice(0, MAX_EVENTS),
    unclassifiedRevisions: unclassifiedRevisions
      .sort((left, right) => (
        right.publicationTime.value.localeCompare(left.publicationTime.value)
        || right.announcementId.localeCompare(left.announcementId)
      ))
      .slice(0, MAX_UNCLASSIFIED_REVISIONS),
  };
}

export function buildChinaCorporateDisclosureSnapshot({
  outcomes,
  previousSnapshot = null,
  generatedAt = new Date().toISOString(),
}) {
  const checkedAt = ensureIsoInstant(generatedAt, 'GENERATED_AT');
  const sources = sourceStates(outcomes, previousSnapshot, checkedAt);
  const announcements = previousAnnouncements(previousSnapshot);
  for (const outcome of outcomes) {
    if ((outcome?.ok || outcome?.partial) && Array.isArray(outcome.announcements)) {
      announcements.push(...outcome.announcements);
    }
  }
  const { events, unclassifiedRevisions } = buildEvents(announcements, sources, checkedAt);
  const launched = sources.filter((source) => source.launchStatus === 'launched');
  const usable = launched.filter(
    (source) => source.contentStatus === 'current' || source.contentStatus === 'partial',
  );
  const status = launched.every(
    (source) => source.transportStatus === 'fresh' && source.contentStatus === 'current',
  )
    ? 'healthy'
    : usable.length > 0
      ? 'degraded'
      : 'unavailable';
  return {
    schemaVersion: 1,
    countryCode: 'CN',
    generatedAt: checkedAt,
    coverageThrough: status === 'healthy' ? checkedAt.slice(0, 10) : null,
    status,
    sources,
    sourceDecisions: Object.values(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS).map((contract) => ({
      id: contract.id,
      exchange: contract.exchange,
      launchStatus: contract.launchStatus,
      admissionDecision: contract.admissionDecision,
      termsUrl: contract.termsUrl,
      termsNote: contract.termsNote,
      robots: contract.robots,
      preflight: contract.preflight,
      metadataEndpoint: contract.metadataEndpoint,
      documentHosts: contract.documentHosts,
      maxRequestsPerRun: contract.maxRequestsPerRun,
      ...(contract.maxDirectRequestsPerRun
        ? { maxDirectRequestsPerRun: contract.maxDirectRequestsPerRun }
        : {}),
      ...(contract.maxProxyRequestsPerRun
        ? { maxProxyRequestsPerRun: contract.maxProxyRequestsPerRun }
        : {}),
      maxResponseBytes: contract.maxResponseBytes,
      redirectPolicy: contract.redirectPolicy,
      documentRetrieval: contract.documentRetrieval,
      ...(contract.fallbackPolicy ? { fallbackPolicy: contract.fallbackPolicy } : {}),
      ...(contract.proxyEnvironmentVariable
        ? { proxyEnvironmentVariable: contract.proxyEnvironmentVariable }
        : {}),
      ...(contract.paginationPolicy ? { paginationPolicy: contract.paginationPolicy } : {}),
      ...(contract.saturationBehavior ? { saturationBehavior: contract.saturationBehavior } : {}),
      ...(contract.emptyResultPolicy ? { emptyResultPolicy: contract.emptyResultPolicy } : {}),
      ...(contract.blockedReason ? { blockedReason: contract.blockedReason } : {}),
    })),
    events,
    unclassifiedRevisions,
  };
}

export async function fetchChinaCorporateDisclosureSnapshot({
  fetchFn = globalThis.fetch,
  proxyUrl = process.env.PROXY_URL ?? '',
  proxyRequestFn = proxyFetch,
  now = Date.now(),
  previousSnapshot = null,
  onDecision = (entry) => console.log(JSON.stringify({ event: 'china_corporate_disclosure_source', ...entry })),
} = {}) {
  const resolvedProxyFetchFn = proxyUrl
    ? (input, init) => fetchViaConfiguredProxy(input, init, {
        proxyUrl,
        maxBytes: OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxResponseBytes,
        proxyRequestFn,
      })
    : null;
  const outcomes = [];
  for (const [sourceId, fetchSource] of LAUNCHED_SOURCE_FETCHERS) {
    let requestCount = 0;
    try {
      const outcome = await fetchSource(async (input, init) => {
        requestCount += 1;
        return fetchFn(input, init);
      }, now, {
        proxyFetchFn: sourceId === 'szse' ? resolvedProxyFetchFn : null,
      });
      outcomes.push(outcome);
    } catch (error) {
      const outcome = {
        sourceId,
        ok: false,
        requestCount: error?.requestCount ?? requestCount,
        errorCode: errorCodeFor(error),
        transportPath: error?.transportPath ?? 'direct',
        ...(error?.fallbackReason ? { fallbackReason: error.fallbackReason } : {}),
        ...(error?.proxyFailureReason
          ? { proxyFailureReason: error.proxyFailureReason }
          : {}),
      };
      outcomes.push(outcome);
    }
  }
  const snapshot = buildChinaCorporateDisclosureSnapshot({
    outcomes,
    previousSnapshot,
    generatedAt: new Date(now).toISOString(),
  });
  for (const source of snapshot.sources) {
    onDecision({
      sourceId: source.id,
      status: source.launchStatus === 'blocked'
        ? 'blocked'
        : source.transportStatus === 'fresh' && source.contentStatus === 'current'
          ? 'accepted'
          : 'degraded',
      requestCount: source.requestCount,
      ...(source.errorCode ? { reason: source.errorCode } : {}),
      ...(source.launchStatus === 'launched'
        ? { emptyResultCount: source.emptyResultCount }
        : {}),
      ...(source.transportPath ? { transportPath: source.transportPath } : {}),
      ...(source.fallbackReason ? { fallbackReason: source.fallbackReason } : {}),
      ...(source.proxyFailureReason
        ? { proxyFailureReason: source.proxyFailureReason }
        : {}),
      checkedAt: source.checkedAt,
    });
  }
  return snapshot;
}
