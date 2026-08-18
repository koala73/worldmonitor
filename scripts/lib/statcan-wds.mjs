// Statistics Canada WDS parsers + approved HTTPS fetch.
// Tests import this module, not scripts/seed-statcan-wds.mjs.

import { CHROME_UA } from '../_seed-utils.mjs';
import { tokensToContentMeta, DAY_MIN } from '../_content-age-helpers.mjs';

export const STATCAN_WDS_HOST = 'www150.statcan.gc.ca';
export const WDS_VECTORS_URL =
  'https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorsAndLatestNPeriods';
export const MAX_STATCAN_WDS_BYTES = 2 * 1024 * 1024;
// 90 days, not 75. StatCan's WDS `refPer` is a normalized observation date and
// for a monthly series it is the FIRST of the reference month, so the clock
// starts a month before the data even exists. The retained release history in
// tests/fixtures/statcan-wds/cpi-lfs-vectors.json measures an 85-day maximum
// healthy-cycle peak. 90 clears that peak with 5 days of margin (#6799). The
// policy test in tests/statcan-wds.test.mjs derives both this healthy bound and
// the one-release-miss bound from the fixture.
//
// Note the start-dating is StatCan's own convention, not periodTokenToMs
// rounding a YYYY-MM token: normalizedStatcanRefPer only accepts YYYY-MM-DD, so
// the helper parses it exactly.
export const STATCAN_MAX_CONTENT_AGE_MIN = 90 * DAY_MIN;
export const FETCH_TIMEOUT_MS = 20_000;

// Cubes the Country Resilience Index actually consumes for CA:
//   18100004 / vector 41690973 — CPI all-items, Canada (monthly index → YoY)
//   14100287 / vector 2062815  — LFS unemployment rate, Canada SA
export const CPI_VECTOR_ID = 41690973;
export const CPI_PRODUCT_ID = 18100004;
export const LFS_UNEMPLOYMENT_VECTOR_ID = 2062815;
export const LFS_PRODUCT_ID = 14100287;
export const CPI_LATEST_N = 15;
export const LFS_LATEST_N = 3;

export function utcDateIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** StatCan WDS change-list dates are America/Toronto civil dates, not UTC. */
export function torontoDateIso(nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

export function shiftIsoDate(dateIso, dayDelta) {
  if (typeof dateIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    throw new Error('STATCAN_DATE_INVALID');
  }
  const [year, month, day] = dateIso.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + dayDelta));
  return shifted.toISOString().slice(0, 10);
}

export function isFutureStatcanDate(dateIso, nowMs = Date.now()) {
  return dateIso > torontoDateIso(nowMs);
}

export function changedCubeListUrl(dateIso) {
  if (typeof dateIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    throw new Error('STATCAN_DATE_INVALID');
  }
  return `https://www150.statcan.gc.ca/t1/wds/rest/getChangedCubeList/${dateIso}`;
}

export function statcanCacheKey(url) {
  return `statcan-wds:${url}`;
}

export function vectorsRequestCacheKey(url = WDS_VECTORS_URL, vectorIds = [CPI_VECTOR_ID, LFS_UNEMPLOYMENT_VECTOR_ID]) {
  return `statcan-wds:${url}#${vectorIds.join(',')}`;
}

/**
 * Same-day release radar. An empty object list is a valid quiet day, not an error.
 */
export function parseChangedCubeList(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
  if (typeof doc.status === 'string' && doc.status !== 'SUCCESS') return [];
  const rows = Array.isArray(doc.object) ? doc.object : [];
  const cubes = [];
  for (const row of rows) {
    const productId = Number(row?.productId);
    if (!Number.isInteger(productId) || productId <= 0) continue;
    cubes.push({
      productId,
      releaseTime: typeof row?.releaseTime === 'string' ? row.releaseTime : null,
    });
  }
  return cubes;
}

export function parseVectorSeries(doc, vectorId) {
  const rows = Array.isArray(doc) ? doc : [];
  for (const row of rows) {
    if (row?.status !== 'SUCCESS') continue;
    const object = row?.object;
    if (Number(object?.vectorId) !== vectorId) continue;
    const points = [];
    for (const pt of Array.isArray(object.vectorDataPoint) ? object.vectorDataPoint : []) {
      const refPer = typeof pt?.refPer === 'string' ? pt.refPer : null;
      const value = typeof pt?.value === 'number' ? pt.value : Number(pt?.value);
      if (!refPer || !/^\d{4}-\d{2}-\d{2}$/.test(refPer) || !Number.isFinite(value)) continue;
      points.push({
        refPer,
        value,
        releaseTime: typeof pt?.releaseTime === 'string' ? pt.releaseTime : null,
      });
    }
    points.sort((a, b) => a.refPer.localeCompare(b.refPer));
    return {
      productId: Number(object.productId) || null,
      vectorId,
      points,
    };
  }
  return { productId: null, vectorId, points: [] };
}

function priorYearRefPer(refPer) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(refPer);
  if (!match) return null;
  return `${Number(match[1]) - 1}-${match[2]}-${match[3]}`;
}

export function computeCpiYoy(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const latest = points.at(-1);
  const priorRef = priorYearRefPer(latest.refPer);
  const prior = priorRef ? points.find((pt) => pt.refPer === priorRef) : null;
  if (!prior || !(prior.value > 0) || !Number.isFinite(latest.value)) return null;
  const yoy = Number((((latest.value / prior.value) - 1) * 100).toPrecision(12));
  return {
    inflationPct: yoy,
    refPer: latest.refPer,
    index: latest.value,
    priorRefPer: prior.refPer,
    priorIndex: prior.value,
    releaseTime: latest.releaseTime,
  };
}

export function latestUnemployment(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const latest = points.at(-1);
  if (!Number.isFinite(latest.value) || latest.value < 0) return null;
  return {
    unemploymentPct: latest.value,
    refPer: latest.refPer,
    releaseTime: latest.releaseTime,
  };
}

export function buildStatcanPayload({
  asOfDate,
  changedCubes,
  cpiSeries,
  lfsSeries,
  seededAtMs = Date.now(),
}) {
  const inflation = computeCpiYoy(cpiSeries?.points);
  const unemployment = latestUnemployment(lfsSeries?.points);
  return {
    asOfDate,
    changedCubes: Array.isArray(changedCubes) ? changedCubes : [],
    changedCount: Array.isArray(changedCubes) ? changedCubes.length : 0,
    inflationPct: inflation?.inflationPct ?? null,
    inflationRefPer: inflation?.refPer ?? null,
    cpiIndex: inflation?.index ?? null,
    unemploymentPct: unemployment?.unemploymentPct ?? null,
    unemploymentRefPer: unemployment?.refPer ?? null,
    inflationReleaseTime: inflation?.releaseTime ?? null,
    unemploymentReleaseTime: unemployment?.releaseTime ?? null,
    cubes: {
      cpi: {
        productId: CPI_PRODUCT_ID,
        vectorId: CPI_VECTOR_ID,
        refPer: inflation?.refPer ?? null,
        releaseTime: inflation?.releaseTime ?? null,
      },
      lfsUnemployment: {
        productId: LFS_PRODUCT_ID,
        vectorId: LFS_UNEMPLOYMENT_VECTOR_ID,
        refPer: unemployment?.refPer ?? null,
        releaseTime: unemployment?.releaseTime ?? null,
      },
    },
    updatedAt: new Date(seededAtMs).toISOString(),
    seededAt: seededAtMs,
  };
}

export function validateStatcanPayload(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.asOfDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.asOfDate)) return false;
  if (!Array.isArray(data.changedCubes)) return false;
  if (!Number.isFinite(data.inflationPct)) return false;
  if (!Number.isFinite(data.unemploymentPct) || data.unemploymentPct < 0) return false;
  return true;
}

export function declareStatcanRecords(data) {
  // Floor is the two resilience cubes. Unrelated getChangedCubeList hits
  // must not pad recordCount past minRecordCount or mask a missing CPI/LFS.
  return (Number.isFinite(data?.inflationPct) ? 1 : 0)
    + (Number.isFinite(data?.unemploymentPct) ? 1 : 0);
}

function normalizedStatcanRefPer(token, nowMs) {
  // WDS documents refPer as a normalized YYYY-MM-DD observation date.
  // Keep that source contract local: releaseTime is a timezone-less Eastern
  // publication clock and must never enter scored content freshness.
  if (typeof token !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(token)) return null;
  const ts = Date.parse(`${token}T00:00:00Z`);
  if (!Number.isFinite(ts) || new Date(ts).toISOString().slice(0, 10) !== token || ts > nowMs) {
    return null;
  }
  return token;
}

export function statcanContentMeta(data, nowMs = Date.now()) {
  // CPI and LFS move independently. Derive one clock per required series,
  // fail closed when either is undatable, then expose the older observation.
  const inflation = tokensToContentMeta(normalizedStatcanRefPer(data?.inflationRefPer, nowMs), nowMs);
  const unemployment = tokensToContentMeta(normalizedStatcanRefPer(data?.unemploymentRefPer, nowMs), nowMs);
  if (inflation == null || unemployment == null) return null;
  return {
    newestItemAt: Math.min(inflation.newestItemAt, unemployment.newestItemAt),
    oldestItemAt: Math.min(inflation.oldestItemAt, unemployment.oldestItemAt),
  };
}

async function readBoundedText(response, maxBytes) {
  const advertisedLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new Error('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    return text;
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

export async function fetchApprovedWdsJson(url, {
  allowedHosts = [STATCAN_WDS_HOST],
  maxBytes = MAX_STATCAN_WDS_BYTES,
  fetchFn = globalThis.fetch,
  cache,
  cacheKey,
  method = 'GET',
  body,
} = {}) {
  const parsed = new URL(url);
  const allowed = new Set((allowedHosts || []).map((host) => String(host).toLowerCase()));
  if (parsed.protocol !== 'https:' || !allowed.has(parsed.hostname.toLowerCase())) {
    throw new Error('UNTRUSTED_SOURCE_HOST');
  }
  const key = cacheKey || statcanCacheKey(parsed.toString());
  if (cache?.has(key)) return cache.get(key);

  const headers = {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
  };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  const response = await fetchFn(parsed.toString(), {
    method,
    headers,
    body: method === 'POST' ? body : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    let body = '';
    try {
      body = await readBoundedText(response, Math.min(maxBytes, 64 * 1024));
    } catch {
      body = '';
    }
    throw Object.assign(new Error(`HTTP_${response.status}`), { status: response.status, body });
  }
  const text = await readBoundedText(response, maxBytes);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('WDS_JSON_INVALID');
  }
  cache?.set(key, doc);
  return doc;
}

/**
 * Live StatCan getChangedCubeList returns HTTP 409
 * {"message":"The product is not released yet"} for Toronto-today before
 * the ~08:30 ET release. That is a quiet miss, same as 404 / future-date.
 */
export function isUnreleasedStatcanProductError(err) {
  // Do not rethrow 409: live getChangedCubeList returns 409 +
  // "The product is not released yet" before ~08:30 ET, and a body-read
  // miss must not abort Promise.all / drop the vector POST.
  if (err?.status === 409) return true;
  const text = `${err?.message || ''} ${err?.body || ''}`;
  return /not released yet/i.test(text);
}

/**
 * Same-day release radar. A 404, a 409 "not released yet", or a Toronto-future
 * date is a quiet miss, not a hard failure — CPI/LFS vectors must still POST.
 */
export async function fetchChangedCubeListBestEffort({
  dateIso,
  fetchFn = globalThis.fetch,
  cache = new Map(),
  nowMs = Date.now(),
} = {}) {
  if (isFutureStatcanDate(dateIso, nowMs)) {
    return { cubes: [], reason: 'future-date' };
  }
  const url = changedCubeListUrl(dateIso);
  try {
    const doc = await fetchApprovedWdsJson(url, {
      fetchFn,
      cache,
      cacheKey: statcanCacheKey(url),
    });
    return { cubes: parseChangedCubeList(doc), reason: 'ok' };
  } catch (err) {
    if (err?.status === 404) return { cubes: [], reason: '404' };
    if (isUnreleasedStatcanProductError(err)) return { cubes: [], reason: '409-unreleased' };
    throw err;
  }
}

export async function fetchStatcanWds({
  fetchFn = globalThis.fetch,
  cache = new Map(),
  nowMs = Date.now(),
} = {}) {
  const asOfDate = torontoDateIso(nowMs);
  const vectorBody = JSON.stringify([
    { vectorId: CPI_VECTOR_ID, latestN: CPI_LATEST_N },
    { vectorId: LFS_UNEMPLOYMENT_VECTOR_ID, latestN: LFS_LATEST_N },
  ]);

  // Do not let a 404/409/future change-list reject Promise.all and discard CPI/LFS.
  const changePromise = fetchChangedCubeListBestEffort({
    dateIso: asOfDate,
    fetchFn,
    cache,
    nowMs,
  }).then(async (result) => {
    if (result.reason === 'ok') return result.cubes;
    const yesterday = shiftIsoDate(asOfDate, -1);
    const fallback = await fetchChangedCubeListBestEffort({
      dateIso: yesterday,
      fetchFn,
      cache,
      nowMs,
    });
    return fallback.reason === 'ok' ? fallback.cubes : [];
  });

  const [changedCubes, vectorDoc] = await Promise.all([
    changePromise,
    fetchApprovedWdsJson(WDS_VECTORS_URL, {
      fetchFn,
      cache,
      cacheKey: vectorsRequestCacheKey(WDS_VECTORS_URL),
      method: 'POST',
      body: vectorBody,
    }),
  ]);

  const payload = buildStatcanPayload({
    asOfDate,
    changedCubes,
    cpiSeries: parseVectorSeries(vectorDoc, CPI_VECTOR_ID),
    lfsSeries: parseVectorSeries(vectorDoc, LFS_UNEMPLOYMENT_VECTOR_ID),
    seededAtMs: nowMs,
  });
  if (!validateStatcanPayload(payload)) {
    throw new Error('StatCan WDS returned no usable CPI or LFS observations');
  }
  console.log(
    `  StatCan WDS: ${payload.changedCount} cubes changed on ${asOfDate}; CPI YoY ${payload.inflationPct}% (${payload.inflationRefPer}); unemployment ${payload.unemploymentPct}% (${payload.unemploymentRefPer})`,
  );
  return payload;
}
