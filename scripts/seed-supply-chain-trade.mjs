#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKey, writeExtraKeyWithMeta, writeSeedMeta, sleep, verifySeedKey, resolveProxyForConnect, fredFetchJson } from './_seed-utils.mjs';
import { tokensToContentMeta, DAY_MIN } from './_content-age-helpers.mjs';

loadEnvFile(import.meta.url);

// Content-age budget — the canonical key holds the merged shipping indices,
// whose freshest member (BDI) is daily. 28 days clears a degraded-to-weekly
// (SCFI/FRED-only) window plus holidays; STALE_CONTENT fires if the whole
// shipping feed stops advancing. A single-index freeze among many is not
// modelled — newestItemAt is the max across all indices. See issue #3845.
const SUPPLY_CHAIN_MAX_CONTENT_AGE_MIN = 28 * DAY_MIN;

const _proxyAuth = resolveProxyForConnect();

// ─── Keys (must match handler cache keys exactly) ───
const KEYS = {
  shipping: 'supply_chain:shipping:v2',
  barriers: 'trade:barriers:v1:tariff-gap:50',
  restrictions: 'trade:restrictions:v1:tariff-overview:50',
  customsRevenue: 'trade:customs-revenue:v1',
};

// NOTE (issue #4864): these TTLs are DELIBERATELY left at 8h. The data-loss fix
// ("manual seed required" — canonical key lapsed and could not be recreated) is the
// lockTtlMs bump in runSeed opts below, which lets slow-but-legit runs complete and
// reach atomicPublish again — restoring republishing every 6h so the key stays alive
// and, once lost, is RECOVERABLE on the next good run (before, it never republished).
// Widening these TTLs for extra gap-buffer is a valid follow-up but NOT free: each is
// co-pinned to a health-check maxStaleMin (see tests/trade-policy-tariffs.test.mjs —
// data-key TTL must satisfy maxStaleMin ∈ [TTL_min, TTL_min+120] or it opens a silent
// EMPTY / false-STALE window), so raising a TTL means moving its maxStaleMin in lockstep.
const SHIPPING_TTL = 28800; // 8h — 2h buffer over 6h cron cadence (was 1h = 5h expired gap)
// Exported so tests/trade-flows-health.test.mjs can assert the tradeFlows
// staleness budget against the REAL data TTL. A test that hardcoded 480 would
// stay green if this constant moved, re-opening the silent window where the
// flow keys have expired but health still reads OK.
export const TRADE_TTL = 28800; // 8h — 2h buffer over 6h cron cadence (was 6h = 0 buffer)
// Exported so tests can pin the tariffTrendsUs staleness budget against the
// real data TTL the same way tradeFlows pins TRADE_TTL.
export const TARIFF_TTL = 28800; // 8h — 2h buffer over 6h cron cadence (was TRADE_TTL=6h = 0 buffer)
const CUSTOMS_TTL = 86400; // 24h — monthly Treasury data, matches maxStaleMin:1440 (was TRADE_TTL=6h = 0 buffer)

// Reporter list fetched dynamically from WTO API at startup.
// WorldMonitor = WORLD coverage — use whatever the WTO API supports.
import { readFileSync as _readFileSync } from 'node:fs';
import { dirname as _dirname, join as _join } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';
const __dirname = _dirname(_fileURLToPath(import.meta.url));
const _un2iso2 = JSON.parse(_readFileSync(_join(__dirname, 'shared', 'un-to-iso2.json'), 'utf8'));

// Populated by fetchWtoReporters() before any data fetches
let ALL_REPORTERS = [];

// True when ALL_REPORTERS came from the local un-to-iso2.json fallback rather
// than from WTO. The fallback is a smaller, frozen list (239 codes against the
// 278 the /reporters endpoint advertised on 2026-08-07), so a run that used it
// does not know the real reporter universe — see publishTradeFlows, which
// refuses to publish a coverage manifest from such a run.
let REPORTER_LIST_IS_FALLBACK = false;

/** Test seam companion to _setAllReportersForTesting. */
export function _setReporterListIsFallbackForTesting(value) {
  REPORTER_LIST_IS_FALLBACK = Boolean(value);
}

// Test-only seam — lets regression tests for fetchTariffTrends /
// fetchTradeRestrictions exercise the real batch loop without first
// running fetchWtoReporters (which would also hit the network). Production
// code never calls this; the leading underscore + ForTesting suffix make
// the intent explicit.
export function _setAllReportersForTesting(reporters) {
  ALL_REPORTERS = Array.isArray(reporters) ? reporters : [];
}

async function fetchWtoReporters() {
  const apiKey = process.env.WTO_API_KEY;
  if (!apiKey) { console.warn('[WTO] WTO_API_KEY not set'); return; }
  try {
    const resp = await fetch('https://api.wto.org/timeseries/v1/reporters', {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    ALL_REPORTERS = data.map(r => String(r.code)).filter(c => /^\d+$/.test(c) && c !== '000');
    REPORTER_LIST_IS_FALLBACK = false;
    console.log(`  WTO reporters: ${ALL_REPORTERS.length} economies`);
  } catch (err) {
    console.warn(`[WTO] Failed to fetch reporter list: ${err.message}, using un-to-iso2.json fallback`);
    ALL_REPORTERS = Object.keys(_un2iso2);
    REPORTER_LIST_IS_FALLBACK = true;
  }
}

// ISO2 lookup for cache keys — derived from the same un-to-iso2.json
const WTO_CODE_TO_ISO2 = { ..._un2iso2 };

function getReporterIso2() {
  return ALL_REPORTERS.map(c => WTO_CODE_TO_ISO2[c]).filter(Boolean);
}

export function deriveWtoSeverityStatus(value) {
  return value > 10 ? 'high' : value > 5 ? 'moderate' : 'low';
}

// ─── Shipping Rates (FRED) ───

export const SHIPPING_SERIES = [
  { seriesId: 'PCU483111483111', name: 'Deep Sea Freight Producer Price Index', unit: 'index', frequency: 'm' },
  { seriesId: 'TSIFRGHT', name: 'Freight Transportation Services Index', unit: 'index', frequency: 'm' },
];

function detectSpike(history) {
  if (!history || history.length < 3) return false;
  const values = history.map(h => typeof h === 'number' ? h : h.value).filter(v => Number.isFinite(v));
  if (values.length < 3) return false;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return false;
  return values[values.length - 1] > mean + 2 * stdDev;
}

// Build one shipping-index entry from a FRED `series/observations` envelope, or
// null when the series carries no usable observation. Exported for the same
// reason as `parseBdiIndices` — the #6078 contract gate must diff the real
// published shape, not a re-implementation of it.
export function parseFredShippingIndex(cfg, data) {
  const observations = (data?.observations || [])
    .map(o => { const v = parseFloat(o.value); return Number.isNaN(v) || o.value === '.' ? null : { date: o.date, value: v }; })
    .filter(Boolean).reverse();
  if (observations.length === 0) return null;
  const current = observations[observations.length - 1].value;
  const previous = observations.length > 1 ? observations[observations.length - 2].value : current;
  const changePct = previous !== 0 ? ((current - previous) / previous) * 100 : 0;
  return {
    indexId: cfg.seriesId, name: cfg.name, currentValue: current, previousValue: previous,
    changePct, unit: cfg.unit, history: observations, spikeAlert: detectSpike(observations),
  };
}

async function fetchShippingRates() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('Missing FRED_API_KEY');

  const indices = [];
  for (const cfg of SHIPPING_SERIES) {
    try {
      const params = new URLSearchParams({
        series_id: cfg.seriesId, api_key: apiKey, file_type: 'json',
        frequency: cfg.frequency, sort_order: 'desc', limit: '24',
      });
      const data = await fredFetchJson(`https://api.stlouisfed.org/fred/series/observations?${params}`, _proxyAuth).catch((e) => {
        console.warn(`  FRED ${cfg.seriesId}: ${e.message}`);
        return null;
      });
      if (!data) continue;
      const index = parseFredShippingIndex(cfg, data);
      if (!index) continue;
      indices.push(index);
      await sleep(200);
    } catch (e) {
      console.warn(`  FRED ${cfg.seriesId}: ${e.message}`);
    }
  }
  console.log(`  Shipping rates: ${indices.length} indices`);
  return { indices, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

// ─── Container Indices (Shanghai Shipping Exchange) ───

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validSseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? value
    : null;
}

// Parse one Shanghai Shipping Exchange `currentIndex` envelope (issue #6066).
//
// `changePct` / `previousValue` are the legacy display fields, kept as-is so the
// supply-chain UI keeps rendering (it does unguarded arithmetic on them). They carry
// SSE's real percentage when it publishes one, but FABRICATE a flat 0 / the current
// level when it does not — so they cannot distinguish "SSE published an unchanged
// week" from "SSE published no prior at all" and must never be consumed as evidence
// of a period-over-period move.
//
// `periodChangePct` is the decision-grade field and fails CLOSED. It is null unless
// SSE published its own percentage, or a comparable prior-period level this function
// differences against — `periodChangeBasis` names which of the two it came from.
// A single index level never becomes a change. It is also null when SSE does not
// provide a real calendar date: an undateable change must not be stamped with a
// retrieval or synthetic date downstream and pass the freshness budget forever.
export function parseSseIndexResponse(json, indexId, dataItemType, displayName, unit) {
  const lines = json?.data?.lineDataList;
  if (!Array.isArray(lines)) return [];
  const composite = lines.find(l => l.dataItemTypeName === dataItemType);
  if (!composite) return [];
  const currentValue = composite.currentContent;
  const previousValue = composite.lastContent;
  if (typeof currentValue !== 'number' || !Number.isFinite(currentValue)) return [];
  const changePct = typeof composite.percentage === 'number' ? composite.percentage
    : (previousValue > 0 ? ((currentValue - previousValue) / previousValue) * 100 : 0);

  // An undated observation is not a dateable change. Keep the display record, but
  // preserve an explicit null marker so history accumulation cannot invent a date.
  const publishedDate = validSseDate(json.data?.currentDate);
  const publishedChangePct = finiteOrNull(composite.percentage);
  const priorPeriodValue = finiteOrNull(previousValue);
  const derivedChangePct = publishedChangePct === null && priorPeriodValue !== null
    && priorPeriodValue !== 0
    ? ((currentValue - priorPeriodValue) / Math.abs(priorPeriodValue)) * 100
    : null;
  const provenChangePct = publishedDate === null
    ? null
    : publishedChangePct ?? derivedChangePct;
  const periodChangeBasis = provenChangePct === null
    ? null
    : publishedChangePct !== null
      ? 'publisher_reported'
      : 'derived_from_prior_period_level';

  return [{
    indexId, name: displayName, currentValue, previousValue: previousValue ?? currentValue,
    changePct,
    periodChangePct: provenChangePct,
    periodChangeBasis,
    // Both prior-period facts describe the comparison the change was measured
    // against, so neither is published without a change to attach them to.
    priorPeriodValue: provenChangePct === null ? null : priorPeriodValue,
    priorPeriodDate: provenChangePct !== null
      ? validSseDate(json.data?.lastDate)
      : null,
    unit, history: [], spikeAlert: false,
    _observationDate: publishedDate,
  }];
}

async function fetchSSEIndex(indexName, indexId, dataItemType, displayName, unit) {
  try {
    const resp = await fetch(`https://en.sse.net.cn/currentIndex?indexName=${indexName}`, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) { console.warn(`  SSE ${indexName}: HTTP ${resp.status}`); return []; }
    const json = await resp.json();
    if (!Array.isArray(json?.data?.lineDataList)) {
      console.warn(`  SSE ${indexName}: no lineDataList`);
      return [];
    }
    const parsed = parseSseIndexResponse(json, indexId, dataItemType, displayName, unit);
    if (parsed.length === 0) console.warn(`  SSE ${indexName}: ${dataItemType} not usable`);
    return parsed;
  } catch (e) {
    console.warn(`  SSE ${indexName}: ${e.message}`);
    return [];
  }
}

async function fetchSCFI() {
  return fetchSSEIndex('scfi', 'SCFI', 'SCFI_T', 'SCFI - Shanghai Container Freight', 'index');
}

async function fetchCCFI() {
  return fetchSSEIndex('ccfi', 'CCFI', 'CCFI_T', 'CCFI - China Container Freight', 'index');
}

// ─── Baltic Dry Index (HandyBulk scrape) ───

const BDI_INDEX_MAP = [
  { label: 'Dry', id: 'BDI', name: 'BDI - Baltic Dry Index' },
  { label: 'Capesize', id: 'BCI', name: 'BCI - Baltic Capesize Index' },
  { label: 'Panamax', id: 'BPI', name: 'BPI - Baltic Panamax Index' },
  { label: 'Supramax', id: 'BSI', name: 'BSI - Baltic Supramax Index' },
  { label: 'Handysize', id: 'BHSI', name: 'BHSI - Baltic Handysize Index' },
];

// Parse the HandyBulk article body into shipping-index entries. Exported so the
// #6078 contract gate exercises the REAL producer — a mirrored copy in the test
// file drifts silently from production, which is exactly how the payload grew
// four fields `ShippingIndex` never declared (#6066/#6074).
export function parseBdiIndices(html) {
  // Parse article date from heading (e.g., "13-March-2026" or "13-Mar-2026").
  //
  // `new Date("March 13, 2026")` yields LOCAL midnight, so toISOString() shifts
  // it back a day everywhere east of UTC — the heading date and the fallback
  // below (which is UTC) would disagree by a day depending on where the seeder
  // runs. Re-read the parsed calendar components as UTC so the stamp is the date
  // the article states, in every timezone. This feeds accumulateHistory's
  // dedup key and supplyChainContentMeta's content-age, both of which are
  // date-keyed, so an off-by-one silently re-dates history points.
  const dateMatch = html.match(/(\d{1,2})-(\w+)-(\d{4})/);
  let articleDate = new Date().toISOString().slice(0, 10);
  if (dateMatch) {
    const parsed = new Date(`${dateMatch[2]} ${dateMatch[1]}, ${dateMatch[3]}`);
    if (!Number.isNaN(parsed.getTime())) {
      articleDate = new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()))
        .toISOString().slice(0, 10);
    }
  }

  const indices = [];
  for (const cfg of BDI_INDEX_MAP) {
    const patterns = [
      new RegExp(`Baltic ${cfg.label} Index \\(${cfg.id}\\)[^.]*?(?:reach|to|at)\\s+([\\d,]+)\\s*points`, 'i'),
      new RegExp(`${cfg.id}[^.]*?(?:reach|to|at)\\s+([\\d,]+)\\s*points`, 'i'),
      new RegExp(`Baltic ${cfg.label} Index \\(${cfg.id}\\)[^.]*?([\\d,]+)\\s*points`, 'i'),
    ];
    let currentValue = null;
    for (const re of patterns) {
      const m = html.match(re);
      if (m) { currentValue = parseFloat(m[1].replace(/,/g, '')); break; }
    }
    if (currentValue == null || !Number.isFinite(currentValue)) continue;

    let changePct = 0;
    let previousValue = currentValue;
    const deltaRe = new RegExp(`${cfg.id}\\)?[^.]*?(increased|decreased|gained|lost|dropped|rose)\\s+by\\s+([\\d,]+)\\s+points`, 'i');
    const deltaMatch = html.match(deltaRe);
    if (deltaMatch) {
      const delta = parseFloat(deltaMatch[2].replace(/,/g, ''));
      const isNeg = /decreased|lost|dropped/i.test(deltaMatch[1]);
      const signedDelta = isNeg ? -delta : delta;
      previousValue = currentValue - signedDelta;
      changePct = previousValue !== 0 ? (signedDelta / previousValue) * 100 : 0;
    }

    indices.push({
      indexId: cfg.id, name: cfg.name, currentValue, previousValue,
      changePct, unit: 'index', history: [], spikeAlert: false, _observationDate: articleDate,
    });
  }
  return indices;
}

async function fetchBDI() {
  try {
    const resp = await fetch('https://www.handybulk.com/baltic-dry-index/', {
      headers: { 'User-Agent': CHROME_UA, 'Accept-Encoding': 'gzip, deflate' },
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    if (!resp.ok && resp.status !== 301 && resp.status !== 302) {
      console.warn(`  BDI: HTTP ${resp.status}`);
      return [];
    }
    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
    if (contentLength > 1_000_000) { console.warn('  BDI: response too large'); return []; }
    const html = await resp.text();
    if (html.length > 1_000_000) { console.warn('  BDI: body too large'); return []; }

    const indices = parseBdiIndices(html);
    console.log(`  BDI: ${indices.length} indices parsed`);
    return indices;
  } catch (e) {
    console.warn(`  BDI: ${e.message}`);
    return [];
  }
}

// ─── History accumulation (inline in canonical payload) ───

export function accumulateHistory(newIndices, previousPayload) {
  if (!previousPayload?.indices?.length) {
    for (const idx of newIndices) {
      const hasObservationDate = Object.prototype.hasOwnProperty.call(idx, '_observationDate');
      if (idx.history?.length === 0 && typeof idx._observationDate === 'string') {
        idx.history = [{ date: idx._observationDate, value: idx.currentValue }];
      }
      // An explicit null means the source did not date this observation. Do not
      // replace it with today; the adapter must see it as stale/undated.
      if (hasObservationDate) delete idx._observationDate;
    }
    return newIndices;
  }
  const prevMap = new Map();
  for (const idx of previousPayload.indices) {
    if (idx.indexId) prevMap.set(idx.indexId, idx);
  }
  const fallbackDate = new Date().toISOString().slice(0, 10);
  for (const idx of newIndices) {
    const prev = prevMap.get(idx.indexId);
    const existingHistory = prev?.history ?? [];
    if (idx.history?.length > 0) { delete idx._observationDate; continue; }
    const hasObservationDate = Object.prototype.hasOwnProperty.call(idx, '_observationDate');
    if (hasObservationDate && typeof idx._observationDate !== 'string') {
      idx.history = existingHistory.slice(-24);
      delete idx._observationDate;
      continue;
    }
    const obsDate = hasObservationDate ? idx._observationDate : fallbackDate;
    const last = existingHistory[existingHistory.length - 1];
    const newHistory = [...existingHistory];
    if (!last || last.date !== obsDate) {
      newHistory.push({ date: obsDate, value: idx.currentValue });
    }
    idx.history = newHistory.slice(-24);
    delete idx._observationDate;
  }
  return newIndices;
}

// ─── WTO helpers ───

// Returns parsed JSON on success, null on any failure (HTTP error, timeout,
// network abort, JSON parse). The null contract lets every batch-loop caller
// — `fetchTariffTrends`, `fetchTradeRestrictions`, `fetchTradeBarriers` —
// degrade gracefully on a single bad batch via their existing `if (!data)`
// guards. Pre-2026-05-01 this only caught HTTP errors and let timeouts
// throw, so one slow batch (e.g. WTO p99 latency spike) sank an entire
// 10-batch loop and silently expired the downstream canonical keys (8h TTL)
// while the seeder kept "succeeding" via shipping/customs alone.
//
// Timeout is 60s per batch — WTO p99 latency for a 30-reporter `TP_A_0010`
// query observed at 21s under normal load, with occasional spikes >15s.
// Total budget across 10 batches × 60s + 1s sleeps = ~10m worst case,
// well inside the 6h cron interval.
export async function wtoFetch(path, params) {
  const apiKey = process.env.WTO_API_KEY;
  if (!apiKey) { console.warn('[WTO] WTO_API_KEY not set'); return null; }
  const url = new URL(`https://api.wto.org/timeseries/v1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const indicator = params?.i || 'unknown';
  const reporterCount = typeof params?.r === 'string' ? params.r.split(',').length : '?';
  try {
    const resp = await fetch(url.toString(), {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(60_000),
    });
    if (resp.status === 204) return { Dataset: [] };
    if (!resp.ok) {
      console.warn(`[WTO] HTTP ${resp.status} for ${path} i=${indicator} reporters=${reporterCount}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    const cause = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? 'timeout'
      : (err?.cause?.code || err?.code || err?.message || 'unknown');
    console.warn(`[WTO] FAIL ${path} i=${indicator} reporters=${reporterCount} cause=${cause}`);
    return null;
  }
}

// US effective tariff rate from FRED: customs duties / goods imports × 100
// B235RC1Q027SBEA = customs duties (quarterly, SAAR billions)
// IEAMGSN = goods imports (quarterly, SAAR billions)
const FRED_CUSTOMS_SERIES = 'B235RC1Q027SBEA';
const FRED_IMPORTS_SERIES = 'A255RC1Q027SBEA'; // Imports of goods, Billions, Quarterly, SAAR (matches customs units)

function fredSeriesUrl(seriesId) {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;
  return `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=20`;
}

async function fetchEffectiveTariffRateFromFred() {
  try {
    const customsUrl = fredSeriesUrl(FRED_CUSTOMS_SERIES);
    const importsUrl = fredSeriesUrl(FRED_IMPORTS_SERIES);
    if (!customsUrl || !importsUrl) { console.warn('  FRED tariff rate: FRED_API_KEY not set'); return null; }
    const [customsResp, importsResp] = await Promise.all([
      fredFetchJson(customsUrl, _proxyAuth),
      fredFetchJson(importsUrl, _proxyAuth),
    ]);
    const customs = customsResp?.observations ?? [];
    const imports = importsResp?.observations ?? [];
    if (!customs?.length || !imports?.length) {
      console.warn('  FRED tariff rate: no data from one or both series');
      return null;
    }
    // Both series are quarterly; match by date
    const importsMap = new Map(imports.map(o => [o.date, parseFloat(o.value)]));
    const latest = customs
      .map(o => ({ date: o.date, customs: parseFloat(o.value), imports: importsMap.get(o.date) }))
      .filter(o => Number.isFinite(o.customs) && Number.isFinite(o.imports) && o.imports > 0)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!latest) { console.warn('  FRED tariff rate: no matching quarters'); return null; }
    const rate = (latest.customs / latest.imports) * 100;
    console.log(`  FRED effective tariff: ${rate.toFixed(1)}% (${latest.date})`);
    return {
      sourceName: 'FRED (BEA)',
      sourceUrl: `https://fred.stlouisfed.org/series/${FRED_CUSTOMS_SERIES}`,
      observationPeriod: latest.date,
      updatedAt: latest.date,
      tariffRate: Math.round(rate * 100) / 100,
    };
  } catch (e) {
    console.warn(`  FRED tariff rate: ${e.message}`);
    return null;
  }
}

// ─── Trade Flows (WTO) — pre-seed every reporter versus World ───

export const WORLD_PARTNER_CODE = '000';

// One seeded window per pair, sliced by the handler to whatever lookback the
// caller asked for. Previously the window was baked into the cache key
// (`…:${years}`) and only ever written at years=10, so every other supported
// lookback built a key nothing had written and came back as an upstream
// outage (issue #6309). Keeping the maximum here and slicing at read time
// makes all 1-30 answerable from the same fetch.
//
// Must stay equal to the `years` maximum in
// proto/worldmonitor/trade/v1/get_trade_flows.proto — a seeded window shorter
// than the contract maximum silently truncates the widest supported request.
// tests/trade-flows-coverage.test.mts pins the two together.
export const TRADE_FLOW_SEED_YEARS = 30;

export const TRADE_FLOW_KEY_PREFIX = 'trade:flows:v2';
// Coverage manifest: the pairs this seeder intends to publish. Read by the
// handler ONLY after a data-key miss, so it costs the served path nothing and
// lets a miss be named — a pair outside the manifest is a coverage answer, a
// pair inside it whose key is gone is a fault.
export const TRADE_FLOW_COVERAGE_KEY = `${TRADE_FLOW_KEY_PREFIX}:index`;
// One aggregate meta key for the whole flow fleet. Per-key meta (249 extra
// Redis writes per run) had no reader; health needs one freshness signal plus
// the coverage counts that separate "we never seeded this" from "WTO is down".
export const TRADE_FLOW_META_KEY = 'seed-meta:trade:flows';

/** Cache key for one seeded pair. Mirrored by the handler; pinned by tests. */
export function tradeFlowSeedKey(reporter, partner) {
  return `${TRADE_FLOW_KEY_PREFIX}:${reporter}:${partner}`;
}

/** Manifest member for one seeded pair. Mirrored by the handler; pinned by tests. */
export function tradeFlowCoverageId(reporter, partner) {
  return `${reporter}:${partner}`;
}

// There is deliberately no bilateral pair list here.
//
// This file used to carry ten curated pairs (US-China, US-Germany, …). None of
// them has ever produced a cache key, and none can: the WTO timeseries
// indicators these flows are built from, ITS_MTV_AX and ITS_MTV_AM, publish a
// World total only. Measured against api.wto.org on 2026-08-07 with the
// production key:
//
//   GET /indicators                     -> ITS_MTV_AX numberPartners = 3
//   GET /data?i=ITS_MTV_AX&r=840&p=all  -> one partner, "000" (World)
//   GET /data?i=ITS_MTV_AX&r=840&p=156  -> HTTP 204, no content
//
// and Redis held 256 `trade:flows:v1:*` keys at the time, every one of them a
// `:000:` World pair. So the pair list was dead configuration that quietly
// widened the advertised contract to a partner space upstream does not have.
//
// Keeping it would be worse than useless now: the coverage manifest below is
// what tells the handler a miss is a fault rather than a coverage answer, so an
// unattainable pair inside it would be reported as a broken seed forever.
export function tradeFlowPairUniverse(reporters) {
  const seen = new Set();
  const pairs = [];
  for (const reporter of reporters) {
    const id = tradeFlowCoverageId(reporter, WORLD_PARTNER_CODE);
    if (seen.has(id)) continue;
    seen.add(id);
    pairs.push([reporter, WORLD_PARTNER_CODE]);
  }
  return pairs;
}

function parseFlowRows(data, indicator) {
  const dataset = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
  return dataset.map(row => {
    const year = parseInt(row.Year ?? row.year ?? '', 10);
    const value = parseFloat(row.Value ?? row.value ?? '');
    if (Number.isNaN(year) || Number.isNaN(value)) return null;
    return { year, indicator, value, reporterName: row.ReportingEconomy ?? '', partnerName: row.PartnerEconomy ?? '' };
  }).filter(Boolean);
}

/**
 * Fold export and import rows into one record per year.
 *
 * Returns `{ records, incompleteYears }`. A year WTO answered on only one side
 * is NOT emitted: the previous version defaulted the missing leg to 0, which
 * publishes a fabricated zero the panel charts and that the next year's
 * year-over-year is differenced against — indistinguishable from trade actually
 * collapsing to nothing. `incompleteYears` counts what that guard dropped so
 * the run reports it instead of silently shrinking coverage.
 */
export function buildFlowRecords(rows, reporterCode, partnerCode) {
  const byYear = new Map();
  let reporterName = reporterCode;
  let partnerName = partnerCode === WORLD_PARTNER_CODE ? 'World' : partnerCode;
  for (const row of rows) {
    if (!byYear.has(row.year)) byYear.set(row.year, { exports: null, imports: null });
    const e = byYear.get(row.year);
    if (row.indicator === 'ITS_MTV_AX') e.exports = row.value; else e.imports = row.value;
    if (row.reporterName) reporterName = row.reporterName;
    if (row.partnerName && partnerCode !== WORLD_PARTNER_CODE) partnerName = row.partnerName;
  }
  const completeYears = [...byYear.keys()]
    .filter((year) => {
      const e = byYear.get(year);
      return Number.isFinite(e.exports) && Number.isFinite(e.imports);
    })
    .sort((a, b) => a - b);
  const records = completeYears.map((year, i) => {
    const cur = byYear.get(year);
    // Year-over-year only means anything across ADJACENT years. Differencing
    // across a WTO gap (or across a year the completeness guard above dropped)
    // and labelling the result yoy overstates a multi-year move as a one-year
    // one. No adjacent prior year → no change to report.
    const prev = i > 0 && completeYears[i - 1] === year - 1 ? byYear.get(year - 1) : null;
    return {
      reportingCountry: reporterName,
      partnerCountry: partnerName,
      year, exportValueUsd: cur.exports, importValueUsd: cur.imports,
      yoyExportChange: prev?.exports > 0 ? Math.round(((cur.exports - prev.exports) / prev.exports) * 10000) / 100 : 0,
      yoyImportChange: prev?.imports > 0 ? Math.round(((cur.imports - prev.imports) / prev.imports) * 10000) / 100 : 0,
      productSector: 'Total merchandise',
    };
  });
  return { records, incompleteYears: byYear.size - completeYears.length };
}

/**
 * Fetch one reporter/partner pair over the full seeded window.
 *
 * Publishes into `flows` only when BOTH indicators answered. `wtoFetch` returns
 * null for every failure mode and `{ Dataset: [] }` for a 204, so a null is a
 * failed request rather than an empty answer — and a pair built from one
 * successful side would persist half a bilateral relationship under a key the
 * handler serves as complete. Skipping leaves the previous key alive under its
 * TTL for the next run to replace.
 */
export async function fetchFlowPair(reporter, partner, flows, stats, now = new Date()) {
  const currentYear = now.getFullYear();
  const startYear = currentYear - TRADE_FLOW_SEED_YEARS;
  const base = { r: reporter, p: partner, ps: `${startYear}-${currentYear}`, pc: 'TO', fmt: 'json', mode: 'full', max: '500' };
  const [exportsResult, importsResult] = await Promise.allSettled([
    wtoFetch('/data', { ...base, i: 'ITS_MTV_AX' }),
    wtoFetch('/data', { ...base, i: 'ITS_MTV_AM' }),
  ]);
  const exportsData = exportsResult.status === 'fulfilled' ? exportsResult.value : null;
  const importsData = importsResult.status === 'fulfilled' ? importsResult.value : null;
  if (!exportsData || !importsData) {
    stats.upstreamFailures++;
    return;
  }
  // Bound the payload by the window we asked for. WTO's `max` caps rows
  // upstream, but a row outside `ps` would otherwise be stored and then served
  // as if it were inside the advertised window.
  const rows = [
    ...parseFlowRows(exportsData, 'ITS_MTV_AX'),
    ...parseFlowRows(importsData, 'ITS_MTV_AM'),
  ].filter((row) => row.year >= startYear && row.year <= currentYear);
  const { records, incompleteYears } = buildFlowRecords(rows, reporter, partner);
  stats.incompleteYearsDropped += incompleteYears;
  if (records.length === 0) {
    // Both indicators answered and neither had anything for this pair. That is
    // a definitive upstream answer, not a failure, so the pair is dropped from
    // advertised coverage — leaving it in would report "the seed is broken" for
    // a combination WTO simply does not carry.
    stats.emptyPairs++;
    stats.emptyPairIds.push(tradeFlowCoverageId(reporter, partner));
    return;
  }
  stats.pairsSeeded++;
  flows[tradeFlowSeedKey(reporter, partner)] = {
    flows: records,
    fetchedAt: new Date().toISOString(),
    upstreamUnavailable: false,
    // Mirrors the generated TradeFlowUnavailableReason zero value; the handler
    // recomputes this after slicing, but the seeded payload must be valid on
    // its own rather than carrying a string the enum does not contain.
    unavailableReason: 'TRADE_FLOW_UNAVAILABLE_REASON_UNSPECIFIED',
    coverageStartYear: records[0].year,
    coverageEndYear: records[records.length - 1].year,
  };
}

// How many consecutive runs a pair must answer empty before it stops being
// advertised. 3 runs at the 6h cron is ~18h — comfortably longer than the 24h
// CDN window is short, so a pair only becomes cacheable-`not_covered` once the
// emptiness has clearly outlived any single upstream blip.
export const TRADE_FLOW_EMPTY_STREAK_TO_DROP = 3;

/** Previous run's per-pair empty streaks; {} when no manifest is readable. */
async function readEmptyPairStreaks() {
  try {
    const previous = await verifySeedKey(TRADE_FLOW_COVERAGE_KEY);
    const streaks = previous?.emptyStreaks;
    if (!streaks || typeof streaks !== 'object' || Array.isArray(streaks)) return {};
    const clean = {};
    for (const [id, n] of Object.entries(streaks)) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) clean[id] = n;
    }
    return clean;
  } catch {
    // No manifest, unreadable, or Redis down. Starting the streaks at zero only
    // delays a drop by a run; inventing one would drop a pair on first sight.
    return {};
  }
}

export async function fetchTradeFlows() {
  const flows = {};
  const now = new Date();
  const pairs = tradeFlowPairUniverse(ALL_REPORTERS);
  const stats = {
    pairsAttempted: pairs.length,
    pairsSeeded: 0,
    upstreamFailures: 0,
    emptyPairs: 0,
    emptyPairIds: [],
    incompleteYearsDropped: 0,
  };

  for (const [reporter, partner] of pairs) {
    await fetchFlowPair(reporter, partner, flows, stats, now);
    await sleep(500);
  }

  const coverage = {
    ...stats,
    startYear: now.getFullYear() - TRADE_FLOW_SEED_YEARS,
    endYear: now.getFullYear(),
  };
  console.log(
    `  Trade flows: ${stats.pairsSeeded}/${stats.pairsAttempted} pairs seeded `
    + `(${stats.upstreamFailures} upstream failures, ${stats.emptyPairs} empty, `
    + `${stats.incompleteYearsDropped} one-sided years dropped)`,
  );
  // Advertised coverage is intent MINUS what upstream definitively answered
  // empty. The distinction is the whole point of the manifest:
  //   - a pair a WTO *failure* dropped stays advertised, so the handler calls a
  //     miss `seed_missing` — a fault, worth retrying, never CDN-cached;
  //   - a pair WTO *answered nothing for* is removed, so the handler calls it
  //     `not_covered` — an honest contract answer.
  // Keeping the second class in would report ~22 reporters (measured 2026-08-07:
  // 256 published against 278 attempted) as a broken seed forever.
  //
  // But removal must not be triggered by a SINGLE empty answer. `not_covered` is
  // the one verdict that leaves upstreamUnavailable false, which is the one the
  // gateway lets the CDN hold — and this route is on the `daily` tier, so
  // CDN-Cache-Control pins it for up to 24h, four times the 6h seed cadence. One
  // transient 204 for a normally-populated reporter would therefore strand it as
  // "not covered" long after the next run had already re-seeded it. Require the
  // emptiness to persist instead: until then the pair stays advertised and reads
  // `seed_missing`, which is no-store and self-corrects on the next run.
  const emptyStreaks = await readEmptyPairStreaks();
  const emptyIds = new Set(stats.emptyPairIds);
  const streaks = {};
  const advertised = [];
  for (const [reporter, partner] of pairs) {
    const id = tradeFlowCoverageId(reporter, partner);
    if (!emptyIds.has(id)) continue; // seeded or upstream-failed: keep advertised
    const streak = (emptyStreaks[id] ?? 0) + 1;
    streaks[id] = streak;
    if (streak < TRADE_FLOW_EMPTY_STREAK_TO_DROP) advertised.push(id);
  }
  for (const [reporter, partner] of pairs) {
    const id = tradeFlowCoverageId(reporter, partner);
    if (!emptyIds.has(id)) advertised.push(id);
  }
  advertised.sort();
  const droppedForEmptiness = stats.emptyPairs - Object.values(streaks)
    .filter((n) => n < TRADE_FLOW_EMPTY_STREAK_TO_DROP).length;
  if (stats.emptyPairs > 0) {
    console.log(
      `  Trade flows: ${stats.emptyPairs} pairs answered empty; `
      + `${droppedForEmptiness} dropped from advertised coverage after `
      + `${TRADE_FLOW_EMPTY_STREAK_TO_DROP} consecutive empty runs`,
    );
  }

  return {
    coverage,
    flows,
    //
    // The run counters ride here rather than in seed-meta's `coverage` field.
    // api/health.js parses that field with the consumer-prices page/retailer
    // schema, so a differently-shaped object is published as an all-zero
    // completedPages/failedPages block — a misleading operator signal, which is
    // the failure class this issue exists to remove. Health gets the number it
    // can actually interpret, `recordCount`, via its minRecordCount floor.
    manifest: {
      pairs: advertised,
      startYear: coverage.startYear,
      endYear: coverage.endYear,
      stats,
      // Carried run-to-run so a pair must answer empty repeatedly before it
      // becomes a cacheable `not_covered`. Only currently-empty pairs appear —
      // a pair that produced data resets by omission.
      emptyStreaks: streaks,
      // Publication gate, not payload — see publishTradeFlows.
      reporterListIsFallback: REPORTER_LIST_IS_FALLBACK,
      fetchedAt: new Date().toISOString(),
    },
  };
}

/**
 * Coarse label for WHY the run published fewer pairs than it attempted, so an
 * on-call agent can tell a transient WTO outage from a permanent reporter-roster
 * shift at a glance on /api/health. Kept to a closed vocabulary (health does
 * not relay arbitrary free text):
 *
 *   - run-failed       the FETCH loop itself threw before producing stats
 *   - upstream         upstreamFailures dominated (requests errored/HTTP non-204)
 *   - empty            emptyPairs dominated (WTO answered 204/nothing, a real
 *                      and usually permanent roster contraction)
 *   - incomplete-years one-sided years dominated (row-level completeness guard)
 *   - mixed            multiple contributors, none dominant
 *   - none             no shortfall (pairsSeeded == pairsAttempted, no dropped rows)
 *
 * Accounting: `pairsSeeded + upstreamFailures + emptyPairs == pairsAttempted`,
 * so a healthy run's delta is exactly zero and `incompleteYearsDropped` (a
 * row-level counter, not a pair counter) is zero too. A positive delta whose
 * upstream/empty counters do not explain it — the counters cannot both be right
 * — resolves to `mixed` rather than inventing a winner. When no pair shortfall
 * exists but one-sided years were dropped anyway, `incomplete-years` names the
 * row-level quality signal even though the pair count is full.
 */
export function dominantFailureMode(coverage) {
  const seeded = coverage.pairsSeeded ?? 0;
  const attempted = coverage.pairsAttempted ?? 0;
  const upstream = coverage.upstreamFailures ?? 0;
  const empty = coverage.emptyPairs ?? 0;
  const incomplete = coverage.incompleteYearsDropped ?? 0;
  if (attempted <= 0 || seeded > attempted) return 'run-failed';

  const delta = attempted - seeded;
  if (delta <= 0) return incomplete > 0 ? 'incomplete-years' : 'none';

  const accounted = upstream + empty;
  if (accounted === 0) return incomplete > 0 ? 'incomplete-years' : 'mixed';
  if (accounted !== delta) return 'mixed';
  // A contributor is dominant when it explains the whole shortfall itself, or
  // when the other side is negligible (< 20% of the delta). Ties resolve to
  // `mixed` rather than picking a winner by accident.
  const shortfallSlots = accounted;
  if (upstream > 0 && empty === 0) return 'upstream';
  if (empty > 0 && upstream === 0) return 'empty';
  if (upstream > shortfallSlots * 0.8) return 'upstream';
  if (empty > shortfallSlots * 0.8) return 'empty';
  return 'mixed';
}

/**
 * Publish the flow fleet: one key per seeded pair, then the coverage manifest,
 * then a single freshness/coverage meta record.
 *
 * Order matters on the last two. The manifest is what lets a handler miss be
 * named, and the meta record is what health reads as "this fleet is fresh" — so
 * the meta goes last, after everything it vouches for is in Redis.
 */
export async function publishTradeFlows({ flows, manifest }) {
  // Per-key isolation. writeExtraKey already retries transient failures, so a
  // throw here is exhaustion or a permanent 4xx — for ONE pair. Letting it
  // propagate would discard every pair after it (already fetched, already in
  // memory, ~9 minutes of WTO calls), skip the manifest and the meta record,
  // and abort the tariff and customs-revenue writes that follow in fetchAll.
  // One bad pair must not cost the fleet.
  const failedKeys = [];
  for (const [key, data] of Object.entries(flows)) {
    try {
      await writeExtraKey(key, data, TRADE_TTL);
    } catch (err) {
      failedKeys.push(key);
      console.warn(`  Trade flows: write failed for ${key}: ${err?.message || err}`);
    }
  }
  if (failedKeys.length > 0) {
    console.warn(`  Trade flows: ${failedKeys.length}/${Object.keys(flows).length} key writes failed`);
  }
  // Health must count what actually landed, not what was fetched. Reporting the
  // fetch count would let a Redis-side partial failure read as full coverage.
  const written = Object.keys(flows).length - failedKeys.length;
  // The manifest is the only thing that lets the handler answer `not_covered`,
  // and `not_covered` is the one verdict that leaves upstreamUnavailable false
  // — which is exactly the one the gateway lets the CDN hold (`daily` tier,
  // s-maxage 14400; every other reason forces no-store through
  // getRpcNoStoreReasonFromPayload). A manifest that under-states coverage
  // therefore publishes "this economy is not covered", cached for hours, about
  // economies this seeder covers perfectly well.
  //
  // Two ways a run reaches that state, both reachable without any code fault:
  //   - the WTO /reporters call failed and ALL_REPORTERS fell back to the local
  //     un-to-iso2.json list, frozen at 239 codes against the 278 WTO
  //     advertised on 2026-08-07;
  //   - WTO_API_KEY is unset or rotated, so fetchWtoReporters returns early and
  //     leaves ALL_REPORTERS at its `[]` initializer — a total outage that would
  //     otherwise publish an EMPTY manifest and turn every request into a
  //     cacheable `not_covered`.
  //
  // Refusing the write leaves the previous manifest alive under its own TTL, or
  // none at all, which the handler reports as `coverage_unknown`:
  // upstreamUnavailable true, no-store, honest about not knowing.
  const untrustworthy = manifest.reporterListIsFallback
    ? 'reporter list came from the local fallback'
    : manifest.pairs.length === 0
      ? 'the run advertised zero pairs'
      : null;
  if (untrustworthy) {
    console.warn(`  Trade flows: not publishing a coverage manifest — ${untrustworthy}`);
  } else {
    // Isolated for the same reason as the per-pair writes above: letting this
    // throw would skip the freshness record AND abort fetchAll before the
    // tariff, customs-revenue and canonical shipping publishes that follow —
    // the exact cascade the per-key isolation exists to prevent. The previous
    // manifest stays alive under its own TTL.
    try {
      await writeExtraKey(TRADE_FLOW_COVERAGE_KEY, manifest, TRADE_TTL);
    } catch (err) {
      console.warn(`  Trade flows: coverage manifest write failed: ${err?.message || err}`);
    }
  }
  // recordCount is the number of pairs actually IN Redis, which is what
  // api/health.js compares against its minRecordCount floor. Deliberately no
  // `coverage` argument — see the manifest comment in fetchTradeFlows.
  //
  // A run that landed NOTHING must not stamp a fresh timestamp over the last
  // good record: that would replace "the fleet is 256 pairs and healthy" with
  // "the fleet is 0 pairs, as of now", turning a total failure into a freshly
  // dated EMPTY instead of letting the existing meta age into STALE_SEED. The
  // seeder is not the right place to declare the fleet gone.
  if (written === 0) {
    console.warn('  Trade flows: no keys written; leaving the previous seed-meta record to age out');
    return;
  }
  await writeSeedMeta(TRADE_FLOW_KEY_PREFIX, written, TRADE_FLOW_META_KEY, undefined, undefined, {
    // Why this run published fewer than attempted, coarse enough for /api/health
    // to relay to an on-call agent without Railway logs or a raw index read.
    // Written NEXT TO recordCount, never under `coverage` — health parses that
    // field with the consumer-prices retailer schema, so a different shape
    // there would be published as an all-zero purchasedPages block (see the
    // manifest comment in fetchTradeFlows). An envelope-less top-level field is
    // the one thing health can read and echo verbatim.
    dominantFailureMode: dominantFailureMode(manifest.stats ?? {}),
  });
}

// ─── Trade Barriers (WTO) ───

async function fetchTradeBarriers() {
  const currentYear = new Date().getFullYear();
  const BATCH = 30;
  const allAgri = [];
  const allNonAgri = [];
  for (let i = 0; i < ALL_REPORTERS.length; i += BATCH) {
    const batch = ALL_REPORTERS.slice(i, i + BATCH).join(',');
    const [agriResult, nonAgriResult] = await Promise.allSettled([
      wtoFetch('/data', { i: 'TP_A_0160', r: batch, ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '5000' }),
      wtoFetch('/data', { i: 'TP_A_0430', r: batch, ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '5000' }),
    ]);
    if (agriResult.status === 'fulfilled' && agriResult.value) allAgri.push(agriResult.value);
    if (nonAgriResult.status === 'fulfilled' && nonAgriResult.value) allNonAgri.push(nonAgriResult.value);
    await sleep(1000);
  }
  const mergeDatasets = (results) => results.flatMap(d => Array.isArray(d) ? d : d?.Dataset ?? d?.dataset ?? []);
  const agriData = allAgri.length > 0 ? { Dataset: mergeDatasets(allAgri) } : null;
  const nonAgriData = allNonAgri.length > 0 ? { Dataset: mergeDatasets(allNonAgri) } : null;
  if (!agriData && !nonAgriData) return null;

  const parseRows = (data) => {
    const dataset = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
    return dataset.map(row => {
      const year = parseInt(row.Year ?? row.year ?? '0', 10);
      const value = parseFloat(row.Value ?? row.value ?? '');
      const cc = String(row.ReportingEconomyCode ?? '');
      return !Number.isNaN(year) && !Number.isNaN(value) && cc ? { country: String(row.ReportingEconomy ?? ''), countryCode: cc, year, value } : null;
    }).filter(Boolean);
  };

  const latestByCountry = (rows) => {
    const m = new Map();
    for (const r of rows) { const e = m.get(r.countryCode); if (!e || r.year > e.year) m.set(r.countryCode, r); }
    return m;
  };

  const latestAgri = latestByCountry(agriData ? parseRows(agriData) : []);
  const latestNonAgri = latestByCountry(nonAgriData ? parseRows(nonAgriData) : []);
  const allCodes = new Set([...latestAgri.keys(), ...latestNonAgri.keys()]);

  const barriers = [];
  for (const code of allCodes) {
    const agri = latestAgri.get(code);
    const nonAgri = latestNonAgri.get(code);
    if (!agri && !nonAgri) continue;
    const agriRate = agri?.value ?? 0;
    const nonAgriRate = nonAgri?.value ?? 0;
    const gap = agriRate - nonAgriRate;
    const country = agri?.country ?? nonAgri?.country ?? code;
    const year = String(agri?.year ?? nonAgri?.year ?? '');
    barriers.push({
      id: `${code}-tariff-gap-${year}`, notifyingCountry: country,
      title: `Agricultural tariff: ${agriRate.toFixed(1)}% vs Non-agricultural: ${nonAgriRate.toFixed(1)}% (gap: ${gap > 0 ? '+' : ''}${gap.toFixed(1)}pp)`,
      measureType: gap > 10 ? 'High agricultural protection' : gap > 5 ? 'Moderate agricultural protection' : 'Low tariff gap',
      productDescription: 'Agricultural vs Non-agricultural products',
      objective: gap > 0 ? 'Agricultural sector protection' : 'Uniform tariff structure',
      status: deriveWtoSeverityStatus(gap),
      dateDistributed: year, sourceUrl: 'https://stats.wto.org',
    });
  }
  barriers.sort((a, b) => {
    const gapA = parseFloat(a.title.match(/gap: ([+-]?\d+\.?\d*)/)?.[1] ?? '0');
    const gapB = parseFloat(b.title.match(/gap: ([+-]?\d+\.?\d*)/)?.[1] ?? '0');
    return gapB - gapA;
  });
  console.log(`  Trade barriers: ${barriers.length} countries`);
  return { barriers, _reporterCountries: getReporterIso2(), fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

// ─── Trade Restrictions (WTO) ───

async function fetchTradeRestrictions() {
  const currentYear = new Date().getFullYear();
  const BATCH = 30;
  const allResults = [];
  for (let i = 0; i < ALL_REPORTERS.length; i += BATCH) {
    const batch = ALL_REPORTERS.slice(i, i + BATCH).join(',');
    const data = await wtoFetch('/data', {
      i: 'TP_A_0010', r: batch,
      ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '5000',
    });
    if (data) allResults.push(data);
    await sleep(1000);
  }
  if (allResults.length === 0) return null;

  const dataset = allResults.flatMap(d => Array.isArray(d) ? d : d?.Dataset ?? d?.dataset ?? []);
  const latestByCountry = new Map();
  for (const row of dataset) {
    const code = String(row.ReportingEconomyCode ?? '');
    const year = parseInt(row.Year ?? row.year ?? '0', 10);
    const existing = latestByCountry.get(code);
    if (!existing || year > parseInt(existing.Year ?? existing.year ?? '0', 10)) latestByCountry.set(code, row);
  }

  const restrictions = [...latestByCountry.values()].map(row => {
    const value = parseFloat(row.Value ?? row.value ?? '');
    if (Number.isNaN(value)) return null;
    const cc = String(row.ReportingEconomyCode ?? '');
    const year = String(row.Year ?? row.year ?? '');
    return {
      id: `${cc}-${year}-${row.IndicatorCode ?? ''}`,
      reportingCountry: String(row.ReportingEconomy ?? cc),
      affectedCountry: 'All trading partners', productSector: 'All products',
      measureType: 'WTO MFN Baseline', description: `WTO MFN baseline: ${value.toFixed(1)}%`,
      status: deriveWtoSeverityStatus(value),
      notifiedAt: year, sourceUrl: 'https://stats.wto.org',
    };
  }).filter(Boolean).sort((a, b) => {
    const rateA = parseFloat(a.description.match(/[\d.]+/)?.[0] ?? '0');
    const rateB = parseFloat(b.description.match(/[\d.]+/)?.[0] ?? '0');
    return rateB - rateA;
  });

  console.log(`  Trade restrictions: ${restrictions.length} countries`);
  return { restrictions, _reporterCountries: getReporterIso2(), fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

// ─── Tariff Trends (WTO) — pre-seed every reporter's MFN applied series ───
//
// One seeded window per reporter, sliced by the handler to whatever lookback
// the caller asked for. Previously the window was baked into the cache key
// (`…:${years}`) and only ever written at years=10, so every other supported
// lookback built a key nothing had written and came back as an upstream
// outage (issue #6316). Keeping the maximum here and slicing at read time
// makes all 1-30 answerable from the same fetch.
//
// Must stay equal to the `years` maximum in
// proto/worldmonitor/trade/v1/get_tariff_trends.proto — a seeded window shorter
// than the contract maximum silently truncates the widest supported request.
// tests/tariff-trends-coverage.test.mts pins the two together.
export const TARIFF_SEED_YEARS = 30;

export const TARIFF_KEY_PREFIX = 'trade:tariffs:v2';
// Coverage manifest: the reporters this seeder intends to publish. Read by the
// handler ONLY after a data-key miss, so it costs the served path nothing and
// lets a miss be named — a reporter outside the manifest is a coverage answer,
// a reporter inside it whose key is gone is a fault.
export const TARIFF_COVERAGE_KEY = `${TARIFF_KEY_PREFIX}:index`;
// One aggregate meta key for the whole tariff fleet. Per-key meta (N extra
// Redis writes per run) had no fleet-level reader; health needs one freshness
// signal plus the coverage counts that separate "we never seeded this" from
// "WTO is down".
export const TARIFF_META_KEY = 'seed-meta:trade:tariffs';

/** Cache key for one seeded reporter. Mirrored by the handler; pinned by tests. */
export function tariffTrendSeedKey(reporter) {
  return `${TARIFF_KEY_PREFIX}:${reporter}`;
}

/** Manifest member for one seeded reporter. Mirrored by the handler; pinned by tests. */
export function tariffTrendCoverageId(reporter) {
  return reporter;
}

/**
 * Build the tariff datapoint list for one reporter from raw WTO rows.
 * Exported so coverage tests can drive the real construction path.
 */
export function buildTariffDatapoints(reporter, rows) {
  return rows.map((row) => {
    const year = parseInt(row.Year ?? row.year ?? '', 10);
    const tariffRate = parseFloat(row.Value ?? row.value ?? '');
    if (Number.isNaN(year) || Number.isNaN(tariffRate)) return null;
    return {
      reportingCountry: row.ReportingEconomy ?? reporter,
      partnerCountry: 'World',
      productSector: 'All products',
      year,
      tariffRate: Math.round(tariffRate * 100) / 100,
      boundRate: 0,
      indicatorCode: 'TP_A_0010',
    };
  }).filter(Boolean).sort((a, b) => a.year - b.year);
}

export async function fetchTariffTrends() {
  const currentYear = new Date().getFullYear();
  const trends = {};
  const usEffectiveTariffRate = await fetchEffectiveTariffRateFromFred();
  // Advertised coverage is intent MINUS what upstream definitively answered
  // empty. A batch WTO *failure* leaves those codes advertised so a miss is
  // seed_missing (fault); a successful batch that produced no usable rows for
  // a code removes it so a miss is not_covered (contract answer).
  const emptyAnswered = new Set();
  let minYear = Number.POSITIVE_INFINITY;
  let maxYear = Number.NEGATIVE_INFINITY;

  // Batch WTO requests in groups of 30 to avoid URL length limits
  const BATCH_SIZE = 30;
  for (let i = 0; i < ALL_REPORTERS.length; i += BATCH_SIZE) {
    const batch = ALL_REPORTERS.slice(i, i + BATCH_SIZE).filter((c) => /^[0-9]{3}$/.test(c));
    if (batch.length === 0) continue;
    const data = await wtoFetch('/data', {
      i: 'TP_A_0010', r: batch.join(','),
      ps: `${currentYear - TARIFF_SEED_YEARS}-${currentYear}`, fmt: 'json', mode: 'full', max: '5000',
    });
    if (!data) {
      // Upstream failure for the whole batch — leave these codes advertised.
      await sleep(1000);
      continue;
    }
    const dataset = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];

    // Group by reporter code
    const byReporter = new Map();
    for (const row of dataset) {
      const code = String(row.ReportingEconomyCode ?? '');
      if (!byReporter.has(code)) byReporter.set(code, []);
      byReporter.get(code).push(row);
    }

    for (const reporter of batch) {
      const rows = byReporter.get(reporter) ?? [];
      const datapoints = buildTariffDatapoints(reporter, rows);
      if (datapoints.length === 0) {
        emptyAnswered.add(reporter);
        continue;
      }
      for (const point of datapoints) {
        if (point.year < minYear) minYear = point.year;
        if (point.year > maxYear) maxYear = point.year;
      }
      const cacheKey = tariffTrendSeedKey(reporter);
      trends[cacheKey] = {
        datapoints,
        ...(reporter === '840' && usEffectiveTariffRate ? { effectiveTariffRate: usEffectiveTariffRate } : {}),
        fetchedAt: new Date().toISOString(),
        upstreamUnavailable: false,
        unavailableReason: 'TARIFF_TREND_UNAVAILABLE_REASON_UNSPECIFIED',
        coverageStartYear: datapoints[0].year,
        coverageEndYear: datapoints[datapoints.length - 1].year,
      };
    }
    await sleep(1000);
  }

  const reporters = ALL_REPORTERS
    .filter((code) => /^[0-9]{3}$/.test(code) && !emptyAnswered.has(code))
    .sort();
  const manifest = {
    reporters,
    startYear: Number.isFinite(minYear) ? minYear : currentYear - TARIFF_SEED_YEARS,
    endYear: Number.isFinite(maxYear) ? maxYear : currentYear,
    fetchedAt: new Date().toISOString(),
    reporterListIsFallback: REPORTER_LIST_IS_FALLBACK === true,
  };

  console.log(
    `  Tariff trends: ${Object.keys(trends).length} countries `
    + `(${reporters.length} advertised, ${emptyAnswered.size} empty)`,
  );
  return { trends, manifest };
}

/**
 * Publish the tariff fleet: one key per reporter, then the coverage manifest,
 * then a single freshness/coverage meta record.
 *
 * Order matters on the last two. The manifest is what lets a handler miss be
 * named, and the meta record is what health reads as "this fleet is fresh" —
 * so the meta goes last, after everything it vouches for is in Redis.
 */
export async function publishTariffTrends({ trends, manifest }) {
  const failedKeys = [];
  for (const [key, data] of Object.entries(trends)) {
    try {
      await writeExtraKey(key, data, TARIFF_TTL);
    } catch (err) {
      failedKeys.push(key);
      console.warn(`  Tariff trends: write failed for ${key}: ${err?.message || err}`);
    }
  }
  if (failedKeys.length > 0) {
    console.warn(`  Tariff trends: ${failedKeys.length}/${Object.keys(trends).length} key writes failed`);
  }
  const written = Object.keys(trends).length - failedKeys.length;

  // Same gate as publishTradeFlows: an under-stated manifest would publish
  // cacheable `not_covered` about economies this seeder covers. Refuse the
  // write and leave the previous manifest under its own TTL, or none at all
  // (handler reports coverage_unknown).
  const untrustworthy = manifest.reporterListIsFallback
    ? 'reporter list came from the local fallback'
    : !Array.isArray(manifest.reporters) || manifest.reporters.length === 0
      ? 'the run advertised zero reporters'
      : null;
  if (untrustworthy) {
    console.warn(`  Tariff trends: not publishing a coverage manifest — ${untrustworthy}`);
  } else {
    try {
      await writeExtraKey(TARIFF_COVERAGE_KEY, {
        reporters: manifest.reporters,
        startYear: manifest.startYear,
        endYear: manifest.endYear,
        fetchedAt: manifest.fetchedAt,
      }, TARIFF_TTL);
    } catch (err) {
      console.warn(`  Tariff trends: coverage manifest write failed: ${err?.message || err}`);
    }
  }

  // A run that landed NOTHING must not stamp a fresh timestamp over the last
  // good record — same rationale as publishTradeFlows.
  if (written === 0) {
    console.warn('  Tariff trends: no keys written; leaving the previous seed-meta record to age out');
    return;
  }
  // The meta record is what health reads as "this fleet is fresh", so a write
  // rejection must NOT abort the run mid-fetchAll and skip the remaining key
  // writes (customs revenue, resilient indices) — log and keep going; the
  // previous meta record then ages out on its own TTL instead of crashing the
  // seeder. Mirrors the isolation policy in _seed-utils.mjs.
  try {
    await writeSeedMeta(TARIFF_KEY_PREFIX, written, TARIFF_META_KEY);
  } catch (err) {
    console.warn(`  Tariff trends: seed-meta write failed: ${err?.message || err}`);
  }
}

// ─── US Treasury Customs Revenue ───

const TREASURY_MTS_URL = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/mts/mts_table_9';

async function fetchCustomsRevenue() {
  const threeYearsAgo = `${new Date().getFullYear() - 3}-01-01`;
  const fields = 'record_date,current_month_rcpt_outly_amt,current_fytd_rcpt_outly_amt,record_fiscal_year,record_calendar_year,record_calendar_month';
  const url = `${TREASURY_MTS_URL}?fields=${fields}&filter=classification_desc:eq:Customs%20Duties,record_date:gte:${threeYearsAgo}&sort=-record_date&page[size]=50`;

  // Treasury MTS occasionally trips up on Railway egress (transient connect /
  // 5xx / TLS resets). 30+ hour stale windows traced back to a single rejected
  // fetch followed by no retry until the next 6h cron tick — by which point
  // the 24h data TTL had expired and the panel went empty. Three attempts
  // with linear backoff (5s, 10s) plus the existing 15s per-attempt timeout
  // give a worst-case ~60s budget per cron run, well within the bundle window.
  // The final rejection re-throws with attempt count + last status / error
  // so the rejection log line at fetchAll() + Sentry have enough context to
  // triage from health output alone.
  //
  // Deterministic failures (4xx other than 429, schema-drift row-count
  // violation) skip the retry loop — they cannot recover by waiting.
  // Marking them with `{ __retryable: false }` lets the catch block
  // short-circuit instead of burning ~30s of cron time and emitting
  // misleading "retrying in 5000ms" warns for what is actually a fixed
  // upstream / contract-violation condition.
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        // 4xx client errors (except 429 rate-limit) are deterministic — the
        // request is malformed or the resource is gone; retry can't fix it.
        const isClient4xx = resp.status >= 400 && resp.status < 500 && resp.status !== 429;
        const err = new Error(`Treasury MTS HTTP ${resp.status}`);
        if (isClient4xx) err.__retryable = false;
        throw err;
      }
      const json = await resp.json();
      const rows = json.data;
      // Empty array MAY be transient (deploy gap, reseed window) — keep retryable.
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('Treasury MTS returned no data');
      // Row-count > 100 means schema drift / new MTS response shape; second
      // request will return the same number, so don't waste cron time.
      if (rows.length > 100) {
        const err = new Error(`Treasury MTS returned unexpected row count: ${rows.length}`);
        err.__retryable = false;
        throw err;
      }
      // Success — break out, fall through to parse below.
      return parseCustomsRows(rows);
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      // Skip the rest of the retry budget on deterministic failures.
      if (err?.__retryable === false) {
        console.warn(`  Treasury customs attempt ${attempt}/3 hit non-retryable error (${msg}); aborting retry`);
        break;
      }
      if (attempt < 3) {
        const backoffMs = attempt * 5_000; // 5s, 10s
        console.warn(`  Treasury customs attempt ${attempt}/3 failed (${msg}); retrying in ${backoffMs}ms`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw new Error(`Treasury MTS exhausted 3 attempts: ${lastErr?.message || lastErr}`);
}

function parseCustomsRows(rows) {

  const months = rows
    .map(r => {
      const monthly = parseFloat(r.current_month_rcpt_outly_amt);
      const fytd = parseFloat(r.current_fytd_rcpt_outly_amt);
      if (!Number.isFinite(monthly) || !Number.isFinite(fytd)) return null;
      return {
        recordDate: r.record_date,
        fiscalYear: parseInt(r.record_fiscal_year, 10) || 0,
        calendarYear: parseInt(r.record_calendar_year, 10) || 0,
        calendarMonth: parseInt(r.record_calendar_month, 10) || 0,
        monthlyAmountBillions: Math.round((monthly / 1e9) * 100) / 100,
        fytdAmountBillions: Math.round((fytd / 1e9) * 100) / 100,
      };
    })
    .filter(Boolean)
    .reverse();

  console.log(`  Treasury customs revenue: ${months.length} months (${months[0]?.recordDate} to ${months[months.length - 1]?.recordDate})`);
  return { months, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

// ─── Main ───

async function fetchAll() {
  await fetchWtoReporters();
  const [shipping, scfi, ccfi, bdi, barriers, restrictions, flows, tariffs, customs] = await Promise.allSettled([
    fetchShippingRates(),
    fetchSCFI(),
    fetchCCFI(),
    fetchBDI(),
    fetchTradeBarriers(),
    fetchTradeRestrictions(),
    fetchTradeFlows(),
    fetchTariffTrends(),
    fetchCustomsRevenue(),
  ]);

  const sh = shipping.status === 'fulfilled' ? shipping.value : null;
  const scfiResult = scfi.status === 'fulfilled' ? scfi.value : [];
  const ccfiResult = ccfi.status === 'fulfilled' ? ccfi.value : [];
  const bdiResult = bdi.status === 'fulfilled' ? bdi.value : [];
  const ba = barriers.status === 'fulfilled' ? barriers.value : null;
  const re = restrictions.status === 'fulfilled' ? restrictions.value : null;
  const fl = flows.status === 'fulfilled' ? flows.value : null;
  const ta = tariffs.status === 'fulfilled' ? tariffs.value : null;
  const cu = customs.status === 'fulfilled' ? customs.value : null;

  if (shipping.status === 'rejected') console.warn(`  Shipping failed: ${shipping.reason?.message || shipping.reason}`);
  if (scfi.status === 'rejected') console.warn(`  SCFI failed: ${scfi.reason?.message || scfi.reason}`);
  if (ccfi.status === 'rejected') console.warn(`  CCFI failed: ${ccfi.reason?.message || ccfi.reason}`);
  if (bdi.status === 'rejected') console.warn(`  BDI failed: ${bdi.reason?.message || bdi.reason}`);
  if (barriers.status === 'rejected') console.warn(`  Barriers failed: ${barriers.reason?.message || barriers.reason}`);
  if (restrictions.status === 'rejected') console.warn(`  Restrictions failed: ${restrictions.reason?.message || restrictions.reason}`);
  if (flows.status === 'rejected') console.warn(`  Flows failed: ${flows.reason?.message || flows.reason}`);
  if (tariffs.status === 'rejected') console.warn(`  Tariffs failed: ${tariffs.reason?.message || tariffs.reason}`);
  if (customs.status === 'rejected') console.warn(`  Treasury customs failed: ${customs.reason?.message || customs.reason}`);

  const allIndices = [
    ...(sh?.indices || []),
    ...scfiResult,
    ...ccfiResult,
    ...bdiResult,
  ];

  if (allIndices.length === 0 && !ba && !re) throw new Error('All supply-chain/trade fetches failed');

  // History accumulation: read previous payload, merge history
  let previousPayload = null;
  try { previousPayload = await verifySeedKey(KEYS.shipping); } catch { /* ignore */ }
  const mergedIndices = accumulateHistory(allIndices, previousPayload);
  console.log(`  Merged shipping indices: ${mergedIndices.length} (FRED: ${sh?.indices?.length ?? 0}, SCFI: ${scfiResult.length}, CCFI: ${ccfiResult.length}, BDI: ${bdiResult.length})`);

  // Write secondary keys BEFORE returning (runSeed calls process.exit after primary write)
  if (ba) await writeExtraKeyWithMeta(KEYS.barriers, ba, TRADE_TTL, ba.barriers?.length ?? 0);
  if (re) await writeExtraKeyWithMeta(KEYS.restrictions, re, TRADE_TTL, re.restrictions?.length ?? 0);
  if (fl) await publishTradeFlows(fl);
  if (ta) await publishTariffTrends(ta);
  if (cu) await writeExtraKeyWithMeta(KEYS.customsRevenue, cu, CUSTOMS_TTL, cu.months?.length ?? 0);

  return mergedIndices.length > 0
    ? { indices: mergedIndices, fetchedAt: new Date().toISOString(), upstreamUnavailable: false }
    : { indices: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
}

function validate(data) {
  return data?.indices?.length > 0;
}

export function declareRecords(data) {
  return Array.isArray(data?.indices) ? data.indices.length : 0;
}

// Content-age contract: newest observation date across every shipping index's
// accumulated history. See scripts/_content-age-helpers.mjs.
export function supplyChainContentMeta(data) {
  const tokens = [];
  for (const idx of Array.isArray(data?.indices) ? data.indices : []) {
    for (const h of Array.isArray(idx?.history) ? idx.history : []) {
      if (h?.date) tokens.push(h.date);
    }
  }
  return tokensToContentMeta(tokens);
}

// Standalone entrypoint guard. Without this, importing this file from tests
// kicks off the whole seeder (Redis lock acquisition, external API calls,
// Redis writes) at module-load time, which hangs the test runner.
if (process.argv[1]?.endsWith('seed-supply-chain-trade.mjs')) {
  runSeed('supply_chain', 'shipping', KEYS.shipping, fetchAll, {
    validateFn: validate,
    ttlSeconds: SHIPPING_TTL,
    // fetchAll runs 9 fetchers via Promise.allSettled, so total = the slowest branch;
    // the WTO branches (barriers/restrictions/flows over ~239 reporters) were budgeted
    // for the 6h cron ("~10min worst case") and routinely exceed the default 240s
    // fetch-phase deadline (lockTtlMs 120s + 120s margin), tripping the #4786 backstop
    // WITHOUT ever reaching atomicPublish (issue #4864). Every fetch is bounded (15/20/60s
    // AbortSignal.timeout) — no non-settling await — so this is legitimate cumulative
    // latency. Size lockTtlMs to the WTO design budget so slow-but-legit runs complete and
    // republish (which recreates an expired key and restores the graceful self-heal).
    lockTtlMs: 900_000, // 15min → deadline 17min
    sourceVersion: 'fred-wto-sse-bdi-budgetlab',

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 420,
    contentMeta: supplyChainContentMeta,
    maxContentAgeMin: SUPPLY_CHAIN_MAX_CONTENT_AGE_MIN,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
