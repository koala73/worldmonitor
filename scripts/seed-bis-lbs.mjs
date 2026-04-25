#!/usr/bin/env node
//
// BIS Locational Banking Statistics — by-parent cross-border claims
// Canonical key: economic:bis-lbs:v1
//
// SDMX dataflow: WS_LBS_D_PUB
// Endpoint:      https://stats.bis.org/api/v1/data/WS_LBS_D_PUB/<KEY>
//
// Per plan 2026-04-25-004 §Component 2 (Codex R2 P1 + R4 P1 corrections):
//
//   12-dim SDMX key shape:
//     Q.S.C.A.TO1.A.<L_PARENT_CTY>.A.5A.A.<L_CP_COUNTRY>.N
//
//   Frequency       Q  (quarterly)
//   Measure         S  (stocks at end-period)
//   Balance sheet   C  (claims)
//   Instruments     A  (all)
//   Currency denom  TO1 (all currencies)
//   Currency type   A  (all)
//   PARENT country  varied per query — enumerated ISO2 (Codex R4 P1 #2:
//                   `4F` is NOT valid; use individual parent ISO2 codes)
//   Reporting type  A  (all)
//   REP country     5A (all reporters — aggregate, NOT varied)
//   Counterparty    A  (all sectors)
//   Counterparty    empty wildcard — pull all counterparties per query
//   Position type   N  (cross-border position type)
//
// ISO mapping (Codex R4 P1 #2): BIS LBS L_CP_COUNTRY uses CL_BIS_IF_REF_AREA
// which follows ISO 3166-1 alpha-2 for country members. ISO2 codes pass
// directly to the SDMX key — no M49 mapping needed. BIS-defined aggregate
// codes (5J all parents, 5A all reporters, 5M emerging markets, 1C
// international organisations, etc.) are handled as explicit allow-listed
// exceptions in the country-iteration loop below.
//
// Output schema:
//   { countries: { [iso2]: {
//       totalXborderPctGdp: number,    // Component 2 input
//       parentCount: number,            // Component 4 input (count of parents
//                                       //  with claims > 1% of GDP)
//       parents: { [parentIso2]: number }, // per-parent claims (USD millions)
//                                          // for downstream provenance
//     }},
//     gdpYear: number,
//     bisQuarter: string,    // e.g. "2025Q1"
//     sources: string[],
//     seededAt: string }

import { loadEnvFile, CHROME_UA, runSeed, resolveProxyForConnect, httpsProxyFetchRaw } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const _proxyAuth = resolveProxyForConnect();
const CANONICAL_KEY = 'economic:bis-lbs:v1';
const CACHE_TTL = 100 * 24 * 3600; // 100 days; BIS LBS publishes quarterly
const WB_BASE = 'https://api.worldbank.org/v2';
const BIS_BASE = 'https://stats.bis.org/api/v1/data/WS_LBS_D_PUB';

// Major Western parent countries enumerated per Codex R4 P1 #2.
// Sum across these gives the "exposure to actions by US/UK/major-EU/etc.
// banks" signal. Together they account for >85% of BIS LBS counterparty
// claims globally per the BIS 2024 outline.
const PARENT_COUNTRIES = [
  'US', 'GB', 'DE', 'FR', 'IT', 'NL', 'ES', 'BE', 'AT', 'IE', 'LU',
  'CH', 'JP', 'CA', 'AU', 'SG',
];

// BIS-defined aggregate codes — skip during per-counterparty iteration.
// These are NOT real countries; including them would inflate claim sums
// and corrupt the % of GDP ratio.
const BIS_AGGREGATE_CODES = new Set([
  '5J', '5A', '5M', '1C', '4F', '4U', '5C', // common aggregates
  'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', // grouped aggregates
  '5R', '5T', '5W', '5Z',                          // EM/AE/world groupings
]);

async function fetchSdmxJson(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/vnd.sdmx.data+json;version=1.0.0' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (directErr) {
    if (!_proxyAuth) throw directErr;
    console.warn(`  BIS direct failed (${directErr.message}), retrying via proxy`);
    const { buffer } = await httpsProxyFetchRaw(url, _proxyAuth, {
      accept: 'application/vnd.sdmx.data+json;version=1.0.0',
      timeoutMs: 60_000,
    });
    return JSON.parse(buffer.toString('utf8'));
  }
}

// Parse SDMX-JSON Data Message: extract latest-period claim per
// counterparty country for a given parent. Returns { [iso2]: claimUsdMillions }.
//
// SDMX-JSON shape (simplified):
//   data.dataSets[0].series = { "<dim-coord-string>": { observations: { "<period-idx>": [value, ...] } } }
//   data.structure.dimensions.series = [ { id, values: [...] }, ... ]
//   data.structure.dimensions.observation = [ { id, values: [...] } ]   // typically TIME_PERIOD
//
// We need to:
//   1. Find which series-dimension index is L_CP_COUNTRY (counterparty country)
//   2. For each series, decode that dimension index to the counterparty ISO2
//   3. Pick the latest observation (last index in observations dict)
export function extractClaimsByCounterparty(sdmxJson) {
  const ds = sdmxJson?.data?.dataSets?.[0] ?? sdmxJson?.dataSets?.[0];
  const structure = sdmxJson?.data?.structure ?? sdmxJson?.structure;
  if (!ds?.series || !structure?.dimensions?.series) return { byCounterparty: {}, latestPeriod: null };

  const seriesDims = structure.dimensions.series;
  const cpIdx = seriesDims.findIndex((d) => d.id === 'L_CP_COUNTRY' || d.id === 'CP_COUNTRY' || d.id === 'COUNTERPARTY_COUNTRY');
  if (cpIdx < 0) {
    throw new Error('SDMX response missing L_CP_COUNTRY dimension');
  }
  const cpValues = seriesDims[cpIdx].values; // [{ id, name }, ...]

  const obsDim = (structure.dimensions.observation ?? [])[0];
  const obsValues = obsDim?.values ?? [];

  const byCounterparty = {};
  let latestPeriod = null;

  for (const [seriesKey, series] of Object.entries(ds.series)) {
    const coords = seriesKey.split(':').map((s) => Number.parseInt(s, 10));
    const cpRefIdx = coords[cpIdx];
    const cpEntry = cpValues[cpRefIdx];
    if (!cpEntry) continue;
    const cpCode = String(cpEntry.id ?? '').trim().toUpperCase();
    if (!cpCode || cpCode.length !== 2 || BIS_AGGREGATE_CODES.has(cpCode)) continue;

    const obs = series.observations ?? {};
    // Latest period: highest numeric obs index (SDMX-JSON convention).
    let latestIdx = -1;
    let latestVal = null;
    for (const [idxStr, valArr] of Object.entries(obs)) {
      const idx = Number.parseInt(idxStr, 10);
      if (idx > latestIdx && Array.isArray(valArr) && valArr.length > 0) {
        latestIdx = idx;
        latestVal = Number(valArr[0]);
      }
    }
    if (!Number.isFinite(latestVal) || latestVal < 0) continue;
    // Upper-bound sanity guard: BIS reports claims in USD millions. The
    // largest realistic single-bilateral claim is ~$2T = 2,000,000 millions.
    // 1e8 millions = $100T = >half of global GDP — far above any plausible
    // bilateral exposure. A value above this threshold indicates a parser
    // or upstream-corruption fault; reject silently rather than corrupt
    // the % of GDP ratio downstream.
    if (latestVal > 1e8) continue;

    byCounterparty[cpCode] = latestVal;
    const period = obsValues[latestIdx]?.id;
    if (period && (!latestPeriod || period > latestPeriod)) latestPeriod = period;
  }

  return { byCounterparty, latestPeriod };
}

async function fetchBisLbsForParent(parentIso2) {
  const key = `Q.S.C.A.TO1.A.${parentIso2}.A.5A.A..N`;
  // `?lastNObservations=4` keeps payload small; we only need the most
  // recent quarter (older quarters used for cross-quarter reconciliation
  // if the latest is missing).
  const url = `${BIS_BASE}/${key}?lastNObservations=4`;
  const json = await fetchSdmxJson(url);
  return extractClaimsByCounterparty(json);
}

// Bounded-concurrency runner. Sequential 16 parents × 60s timeout = 960s
// worst-case, which exceeds the bundle's 600s timeoutMs. Parallel-4
// caps wall time at ~4 × 60s = 240s on the slow path while staying
// polite to BIS API (4 in-flight is well under any reasonable rate
// limit). The runner returns the per-parent result map AND an errors
// array so the caller can gate validation on the success-count.
async function runParentFetchesConcurrent(parents, concurrency = 4) {
  const results = {};
  const errors = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= parents.length) return;
      const parent = parents[idx];
      try {
        results[parent] = await fetchBisLbsForParent(parent);
      } catch (err) {
        errors.push(`parent=${parent}: ${err.message}`);
        results[parent] = { byCounterparty: {}, latestPeriod: null };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, parents.length) }, () => worker());
  await Promise.all(workers);
  return { results, errors };
}

async function fetchGdpByCountry() {
  const out = {};
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const url = `${WB_BASE}/country/all/indicator/NY.GDP.MKTP.CD?format=json&per_page=500&page=${page}&mrv=3`;
    let json;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      json = await resp.json();
    } catch (directErr) {
      if (!_proxyAuth) throw directErr;
      const { buffer } = await httpsProxyFetchRaw(url, _proxyAuth, { accept: 'application/json', timeoutMs: 30_000 });
      json = JSON.parse(buffer.toString('utf8'));
    }
    const meta = json[0];
    const records = json[1] ?? [];
    totalPages = meta?.pages ?? 1;
    for (const record of records) {
      const rawCode = record?.countryiso3code ?? record?.country?.id ?? '';
      const iso2 = rawCode.length === 3 ? (iso3ToIso2[rawCode] ?? null) : (rawCode.length === 2 ? rawCode : null);
      if (!iso2) continue;
      const value = Number(record?.value);
      if (!Number.isFinite(value) || value <= 0) continue;
      const year = Number(record?.date);
      if (!Number.isFinite(year)) continue;
      const existing = out[iso2];
      if (!existing || year > existing.year) out[iso2] = { value, year };
    }
    page++;
  }
  return out;
}

export function combineLbsByCounterparty(perParent, gdpByCountry) {
  // Reshape: counterparty → parent → claim.
  const claimsByCpByParent = {};
  for (const [parent, { byCounterparty }] of Object.entries(perParent)) {
    for (const [cp, claim] of Object.entries(byCounterparty)) {
      if (!claimsByCpByParent[cp]) claimsByCpByParent[cp] = {};
      claimsByCpByParent[cp][parent] = claim;
    }
  }

  const countries = {};
  for (const [cp, parents] of Object.entries(claimsByCpByParent)) {
    const gdp = gdpByCountry[cp];
    if (!gdp) continue;
    // BIS LBS reports claims in USD millions; WB GDP in USD. Convert
    // millions → USD before computing the ratio.
    const claimsUsd = Object.values(parents).reduce((sum, v) => sum + v * 1e6, 0);
    const totalXborderPctGdp = Math.round((claimsUsd / gdp.value) * 10_000) / 100;

    // Component 4: count of parents with claims > 1% of GDP.
    const parentCount = Object.values(parents).filter((v) => (v * 1e6) > 0.01 * gdp.value).length;

    countries[cp] = {
      totalXborderPctGdp,
      parentCount,
      parents,
      gdpYear: gdp.year,
    };
  }
  return countries;
}

// Minimum successful parents required for the seed payload to be
// considered structurally valid. Below this threshold, the surviving
// parents would skew Component 4 (financial-center redundancy) low for
// every counterparty country until the next successful run — a covertly-
// degraded payload that passes the >100-counterparty floor. Reject
// instead so seed-meta is NOT refreshed and the previous valid payload
// stays alive under cache TTL.
const MIN_SUCCESSFUL_PARENTS = 12;

export async function fetchBisLbs() {
  const { results: perParent, errors } = await runParentFetchesConcurrent(PARENT_COUNTRIES, 4);
  const successfulParents = PARENT_COUNTRIES.length - errors.length;
  if (successfulParents < MIN_SUCCESSFUL_PARENTS) {
    throw new Error(
      `BIS LBS: only ${successfulParents}/${PARENT_COUNTRIES.length} parents succeeded ` +
        `(min ${MIN_SUCCESSFUL_PARENTS} required to avoid skewing parentCount). Errors: ${errors.join('; ')}`,
    );
  }
  if (errors.length > 0) {
    console.warn(`[bis-lbs] ${errors.length}/${PARENT_COUNTRIES.length} parent fetches failed (proceeding with ${successfulParents} successful): ${errors.join('; ')}`);
  }

  const gdpByCountry = await fetchGdpByCountry();
  const countries = combineLbsByCounterparty(perParent, gdpByCountry);

  // Provenance: counterparties seen in BIS LBS but dropped because no
  // GDP record was available. Surfaces silent coverage gaps for ops
  // triage without polluting the main `countries` map.
  const droppedForMissingGdp = [];
  const seenCounterparties = new Set();
  for (const { byCounterparty } of Object.values(perParent)) {
    for (const cp of Object.keys(byCounterparty)) seenCounterparties.add(cp);
  }
  for (const cp of seenCounterparties) {
    if (!gdpByCountry[cp]) droppedForMissingGdp.push(cp);
  }

  // Pick the most-common latestPeriod across parents (mode).
  const periods = Object.values(perParent).map((p) => p.latestPeriod).filter(Boolean);
  const periodCounts = periods.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
  const bisQuarter = Object.entries(periodCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    countries,
    bisQuarter,
    parentCountries: PARENT_COUNTRIES,
    droppedForMissingGdp,
    successfulParents,
    sources: [
      'https://stats.bis.org/api/v1/data/WS_LBS_D_PUB',
      'https://www.bis.org/statistics/about_banking_stats.htm',
      'https://www.bis.org/terms_conditions.htm',
    ],
    seededAt: new Date().toISOString(),
  };
}

// BIS LBS counterparty coverage spans ~200+ jurisdictions. Floor of 150
// is conservative — at this threshold, a fresh seed represents the
// vast majority of manifest countries. Below 150 indicates a serious
// upstream regression that should NOT silently refresh seed-meta.
export function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 150;
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

export { CANONICAL_KEY, CACHE_TTL, PARENT_COUNTRIES };

if (process.argv[1]?.endsWith('seed-bis-lbs.mjs')) {
  runSeed('economic', 'bis-lbs', CANONICAL_KEY, fetchBisLbs, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `bis-lbs-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    emptyDataIsFailure: true,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 14400, // 10d, > 1 BIS LBS publish lag
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
