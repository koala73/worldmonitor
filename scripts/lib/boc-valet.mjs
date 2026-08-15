// Bank of Canada Valet parsers + approved HTTPS fetch.
// Tests import this module, not scripts/seed-boc-valet.mjs.

import { CHROME_UA } from '../_seed-utils.mjs';
import { tokensToContentMeta, DAY_MIN } from '../_content-age-helpers.mjs';

export const BOC_VALET_HOST = 'www.bankofcanada.ca';
export const BOC_VALET_TERMS_URL = 'https://www.bankofcanada.ca/terms/';
export const FX_RATES_DAILY_URL =
  'https://www.bankofcanada.ca/valet/observations/group/FX_RATES_DAILY/json?recent=1';
export const POLICY_RATE_URL =
  'https://www.bankofcanada.ca/valet/observations/V39079/json?recent=5';
export const BOND_YIELDS_URL =
  'https://www.bankofcanada.ca/valet/observations/BD.CDN.2YR.DQ.YLD,BD.CDN.5YR.DQ.YLD,BD.CDN.10YR.DQ.YLD/json?recent=1';
export const POLICY_RATE_SERIES_ID = 'V39079';
export const MAX_BOC_VALET_BYTES = 2 * 1024 * 1024;
export const MIN_FX_RATE_COUNT = 15;
export const BOC_MAX_CONTENT_AGE_MIN = 14 * DAY_MIN;
export const FETCH_TIMEOUT_MS = 15_000;

const YIELD_LABELS = Object.freeze({
  'BD.CDN.2YR.DQ.YLD': '2y',
  'BD.CDN.5YR.DQ.YLD': '5y',
  'BD.CDN.10YR.DQ.YLD': '10y',
});

export function bocValetCacheKey(url) {
  return `boc-valet:${url}`;
}

function cleanFloat(value) {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(12));
}

function parseValetNumber(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  if (token === '' || token === '.') return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

function seriesValue(entry) {
  if (entry == null) return null;
  if (typeof entry === 'object' && !Array.isArray(entry)) return parseValetNumber(entry.v);
  return parseValetNumber(entry);
}

/**
 * Collapse a Valet observations document to the newest row per series.
 * Discontinued relics (VND 2019, RUB/SAR last print on a prior close) keep
 * their last published date here; buildBocFxRates drops them from `rates`
 * so they are not published as current.
 */
export function parseValetObservations(doc) {
  const seriesDetail = doc?.seriesDetail && typeof doc.seriesDetail === 'object' ? doc.seriesDetail : {};
  const observations = Array.isArray(doc?.observations) ? doc.observations : [];
  const latestBySeries = new Map();

  for (const row of observations) {
    const date = typeof row?.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.d) ? row.d : null;
    if (!date) continue;
    for (const [seriesId, cell] of Object.entries(row)) {
      if (seriesId === 'd') continue;
      const value = seriesValue(cell);
      if (value == null) continue;
      const prev = latestBySeries.get(seriesId);
      if (!prev || date > prev.date) {
        const detail = seriesDetail[seriesId];
        latestBySeries.set(seriesId, {
          seriesId,
          date,
          value: cleanFloat(value),
          label: typeof detail?.label === 'string' ? detail.label : seriesId,
        });
      }
    }
  }

  return {
    termsUrl: typeof doc?.terms?.url === 'string' ? doc.terms.url : null,
    series: [...latestBySeries.values()].sort((a, b) => a.seriesId.localeCompare(b.seriesId)),
  };
}

function fxCodeFromSeriesId(seriesId) {
  const match = /^FX([A-Z]{3})CAD$/.exec(seriesId);
  return match ? match[1] : null;
}

export function buildBocFxRates(parsed) {
  const candidates = [];
  let effectiveDate = null;
  for (const series of parsed?.series ?? []) {
    const code = fxCodeFromSeriesId(series.seriesId);
    if (!code || !(series.value > 0)) continue;
    candidates.push({ code, series });
    if (effectiveDate == null || series.date > effectiveDate) effectiveDate = series.date;
  }
  const rates = {};
  for (const { code, series } of candidates) {
    // Relics (VND 2019-12-31, RUB/SAR 2026-04-30) are not the live close.
    if (series.date !== effectiveDate) continue;
    rates[code] = {
      rate: series.value,
      date: series.date,
      label: series.label,
      seriesId: series.seriesId,
    };
  }
  return { rates, effectiveDate };
}

export function summarisePolicyRate(parsed) {
  const observations = (parsed?.series ?? [])
    .filter((row) => row.seriesId === POLICY_RATE_SERIES_ID && Number.isFinite(row.value) && row.value >= 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  // parseValetObservations already keeps the newest row per series. When the
  // caller passes the raw multi-obs document through parseValetObservations,
  // only the latest remains. Re-parse observations for the path when present.
  return observations.at(-1)
    ? {
        rate: observations.at(-1).value,
        observedAt: observations.at(-1).date,
        seriesId: POLICY_RATE_SERIES_ID,
        label: observations.at(-1).label,
      }
    : null;
}

/**
 * Policy-rate history is a time series of the same series id. Reconstruct it
 * from the raw Valet document (not the collapsed latest-by-series view).
 */
export function parsePolicyRateHistory(doc) {
  const observations = [];
  for (const row of Array.isArray(doc?.observations) ? doc.observations : []) {
    const date = typeof row?.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.d) ? row.d : null;
    const value = seriesValue(row?.[POLICY_RATE_SERIES_ID]);
    if (!date || value == null || value < 0) continue;
    observations.push({ date, value: cleanFloat(value) });
  }
  observations.sort((a, b) => a.date.localeCompare(b.date));
  if (observations.length === 0) return null;
  const latest = observations.at(-1);
  let runStart = observations.length - 1;
  while (runStart > 0 && observations[runStart - 1].value === latest.value) runStart -= 1;
  const previous = runStart > 0 ? observations[runStart - 1] : null;
  return {
    rate: latest.value,
    observedAt: latest.date,
    previousRate: previous ? previous.value : null,
    changedAt: runStart > 0 ? observations[runStart].date : null,
    change: previous ? cleanFloat(latest.value - previous.value) : null,
    observationCount: observations.length,
    seriesId: POLICY_RATE_SERIES_ID,
  };
}

export function buildBocYields(parsed) {
  const yields = {};
  let observedAt = null;
  for (const series of parsed?.series ?? []) {
    const key = YIELD_LABELS[series.seriesId];
    if (!key || !(series.value >= 0)) continue;
    yields[key] = {
      rate: series.value,
      date: series.date,
      seriesId: series.seriesId,
      label: series.label,
    };
    if (observedAt == null || series.date > observedAt) observedAt = series.date;
  }
  return Object.keys(yields).length > 0 ? { ...yields, observedAt } : null;
}

export function buildBocPayload({
  fxDoc,
  policyDoc,
  yieldsDoc,
  seededAtMs = Date.now(),
}) {
  const fx = buildBocFxRates(parseValetObservations(fxDoc));
  const policyRate = parsePolicyRateHistory(policyDoc);
  const bondYields = buildBocYields(parseValetObservations(yieldsDoc));
  return {
    quoteCurrency: 'CAD',
    rateUnit: 'CAD per 1 unit of the listed currency',
    effectiveDate: fx.effectiveDate,
    rates: fx.rates,
    policyRate,
    bondYields,
    updatedAt: new Date(seededAtMs).toISOString(),
    seededAt: seededAtMs,
  };
}

export function validateBocPayload(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.effectiveDate !== 'string' || data.effectiveDate === '') return false;
  if (!Number.isFinite(data.policyRate?.rate)) return false;
  const codes = Object.keys(data.rates ?? {});
  if (codes.length < MIN_FX_RATE_COUNT) return false;
  return codes.every((code) => {
    const entry = data.rates[code];
    return Number.isFinite(entry?.rate) && entry.rate > 0;
  });
}

export function declareBocRecords(data) {
  const rateCount = Object.keys(data?.rates ?? {}).length;
  const policy = Number.isFinite(data?.policyRate?.rate) ? 1 : 0;
  const yields = ['2y', '5y', '10y'].filter((key) => Number.isFinite(data?.bondYields?.[key]?.rate)).length;
  return rateCount + policy + yields;
}

export function bocContentMeta(data, nowMs = Date.now()) {
  const fxDates = Object.values(data?.rates ?? {}).map((row) => row?.date);
  const tokens = [
    ...fxDates,
    data?.policyRate?.observedAt,
    data?.bondYields?.observedAt,
    data?.bondYields?.['2y']?.date,
    data?.bondYields?.['5y']?.date,
    data?.bondYields?.['10y']?.date,
  ];
  return tokensToContentMeta(tokens, nowMs);
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

export async function fetchApprovedValetJson(url, {
  allowedHosts = [BOC_VALET_HOST],
  maxBytes = MAX_BOC_VALET_BYTES,
  fetchFn = globalThis.fetch,
  cache,
} = {}) {
  const parsed = new URL(url);
  const allowed = new Set((allowedHosts || []).map((host) => String(host).toLowerCase()));
  if (parsed.protocol !== 'https:' || !allowed.has(parsed.hostname.toLowerCase())) {
    throw new Error('UNTRUSTED_SOURCE_HOST');
  }
  const cacheKey = bocValetCacheKey(parsed.toString());
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const response = await fetchFn(parsed.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP_${response.status}`), { status: response.status });
  const text = await readBoundedText(response, maxBytes);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('VALET_JSON_INVALID');
  }
  cache?.set(cacheKey, doc);
  return doc;
}

export async function fetchBocValet({
  fetchFn = globalThis.fetch,
  cache = new Map(),
  nowMs = Date.now(),
} = {}) {
  const [fxDoc, policyDoc, yieldsDoc] = await Promise.all([
    fetchApprovedValetJson(FX_RATES_DAILY_URL, { fetchFn, cache }),
    fetchApprovedValetJson(POLICY_RATE_URL, { fetchFn, cache }),
    fetchApprovedValetJson(BOND_YIELDS_URL, { fetchFn, cache }),
  ]);
  const payload = buildBocPayload({ fxDoc, policyDoc, yieldsDoc, seededAtMs: nowMs });
  if (!validateBocPayload(payload)) {
    throw new Error('BoC Valet returned no usable FX table or policy rate');
  }
  const rateCount = Object.keys(payload.rates).length;
  console.log(
    `  BoC Valet: ${rateCount} FX pairs effective ${payload.effectiveDate}; policy rate ${payload.policyRate.rate}% as of ${payload.policyRate.observedAt}`,
  );
  return payload;
}
