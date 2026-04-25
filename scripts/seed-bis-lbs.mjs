#!/usr/bin/env node
//
// BIS Consolidated Banking Statistics — by-parent foreign claims
// Canonical key: economic:bis-lbs:v1
//
// CORRECTION (PR follow-up to #3407, 2026-04-25): the original draft used
// `WS_LBS_D_PUB` (Locational Banking Statistics) on the assumption it
// publishes a per-counterparty breakdown. It does not — `WS_LBS_D_PUB`
// only exposes counterparty as the aggregate `5J`. The plan misread the
// public BIS API. Migrated to `WS_CBS_PUB` (Consolidated Banking
// Statistics), which IS the dataflow that publishes by-parent foreign
// claims with a counterparty-country breakdown.
//
// SDMX dataflow: WS_CBS_PUB
// Endpoint:      https://stats.bis.org/api/v1/data/WS_CBS_PUB/<KEY>
//
// CBS has 11 dimensions (in this order, discovered via probe of
// `WS_CBS_PUB/all?lastNObservations=1` against the live BIS API):
//
//   1. FREQ           — Q (quarterly)
//   2. L_MEASURE      — S (stocks at end-period)
//   3. L_REP_CTY      — parent country (the bank's parent / where the
//                        consolidated bank group is headquartered).
//                        VARIED across our enumerated 16 Western parents.
//   4. CBS_BANK_TYPE  — 4B (consolidated banks)
//   5. CBS_BASIS      — F (foreign claims, ultimate-risk basis — the
//                        view that captures sovereign-exposure semantics)
//   6. L_POSITION     — C (claims)
//   7. L_INSTR        — A (all instruments)
//   8. REM_MATURITY   — A (all maturities)
//   9. CURR_TYPE_BOOK — TO1 (all currencies)
//  10. L_CP_SECTOR    — A (all counterparty sectors)
//  11. L_CP_COUNTRY   — counterparty country. Empty position returns
//                        all counterparties as separate series (verified
//                        by probe — empty in CBS does NOT collapse to
//                        an aggregate the way it does in LBS).
//
// SDMX key shape:  Q.S.<PARENT>.4B.F.C.A.A.TO1.A.
//
// Output schema (unchanged from the original LBS draft — same downstream
// scorer contract; only the source dataflow + dimension shape changed):
//   { countries: { [iso2]: {
//       totalXborderPctGdp: number,     // Component 2 input
//       parentCount: number,             // Component 4 input
//       parents: { [parentIso2]: number },
//     }},
//     bisQuarter: string,
//     successfulParents: number,
//     droppedForMissingGdp: string[],
//     sources: string[],
//     seededAt: string }

import { loadEnvFile, CHROME_UA, runSeed, resolveProxyForConnect, httpsProxyFetchRaw } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const _proxyAuth = resolveProxyForConnect();
const CANONICAL_KEY = 'economic:bis-lbs:v1';
const CACHE_TTL = 100 * 24 * 3600; // 100 days; CBS publishes quarterly
const WB_BASE = 'https://api.worldbank.org/v2';
const BIS_BASE = 'https://stats.bis.org/api/v1/data/WS_CBS_PUB';

// Major Western parent countries enumerated per Codex R4 P1 #2 (the
// principle survives the LBS → CBS dataflow swap; CBS uses ISO 3166-1
// alpha-2 codes via the same `CL_BIS_IF_REF_AREA` codelist as LBS).
const PARENT_COUNTRIES = [
  'US', 'GB', 'DE', 'FR', 'IT', 'NL', 'ES', 'BE', 'AT', 'IE', 'LU',
  'CH', 'JP', 'CA', 'AU', 'SG',
];

// BIS-defined aggregate codes — skip during per-counterparty iteration.
// CBS uses an even larger aggregate set than LBS (the 252-value codelist
// includes UN regional groupings + offshore-centre groups + financial-
// centre composites). Anything that isn't a 2-letter ISO2 country code
// is dropped at the iteration boundary; this set is informational only.
const BIS_AGGREGATE_CODES = new Set([
  '5J', '5A', '5M', '5C', '5R', '5T', '5W', '5Z',
  '1C', '1E', '1W',
  '2Z', '3P',
  '4F', '4U',
  'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9',
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
// CBS-specific note: counterparty values include both ISO2 country
// codes AND BIS aggregate codes. Filter to ISO2-shaped 2-letter codes
// not in the aggregate allow-list.
export function extractClaimsByCounterparty(sdmxJson) {
  const ds = sdmxJson?.data?.dataSets?.[0] ?? sdmxJson?.dataSets?.[0];
  const structure = sdmxJson?.data?.structure ?? sdmxJson?.structure;
  if (!ds?.series || !structure?.dimensions?.series) return { byCounterparty: {}, latestPeriod: null };

  const seriesDims = structure.dimensions.series;
  const cpIdx = seriesDims.findIndex((d) => d.id === 'L_CP_COUNTRY' || d.id === 'CP_COUNTRY' || d.id === 'COUNTERPARTY_COUNTRY');
  if (cpIdx < 0) {
    throw new Error('SDMX response missing L_CP_COUNTRY dimension');
  }
  const cpValues = seriesDims[cpIdx].values;

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
    // Only ISO2-shaped country codes pass; aggregate / regional codes
    // (3P, 1C, 5J, etc.) and any non-2-letter values are dropped.
    if (!cpCode || cpCode.length !== 2 || !/^[A-Z]{2}$/.test(cpCode) || BIS_AGGREGATE_CODES.has(cpCode)) continue;

    const obs = series.observations ?? {};
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
    // Upper-bound sanity guard: BIS reports claims in USD millions.
    // 1e8 millions = $100T = >half of global GDP. A value above this
    // indicates parser / upstream-corruption fault; reject silently.
    if (latestVal > 1e8) continue;

    byCounterparty[cpCode] = latestVal;
    const period = obsValues[latestIdx]?.id;
    if (period && (!latestPeriod || period > latestPeriod)) latestPeriod = period;
  }

  return { byCounterparty, latestPeriod };
}

async function fetchCbsForParent(parentIso2) {
  // CBS key: Q.S.<PARENT>.4B.F.C.A.A.TO1.A. (empty L_CP_COUNTRY → all
  // counterparties; verified by probe to expand correctly in CBS,
  // unlike LBS where it collapses to the 5J aggregate).
  const key = `Q.S.${parentIso2}.4B.F.C.A.A.TO1.A.`;
  const url = `${BIS_BASE}/${key}?lastNObservations=4`;
  const json = await fetchSdmxJson(url);
  return extractClaimsByCounterparty(json);
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

export function combineCbsByCounterparty(perParent, gdpByCountry) {
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
    // CBS reports claims in USD millions; WB GDP in USD. Convert
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

// Bounded-concurrency runner. Sequential 16 × 60s would exceed the
// bundle's 600s timeout. Parallel-4 caps wall time at ~240s on the
// slow path while staying polite to BIS API.
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
        results[parent] = await fetchCbsForParent(parent);
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

// Minimum successful parents required for the seed payload to be
// considered structurally valid. Below this threshold, the surviving
// parents would skew Component 4 (financial-center redundancy) low.
const MIN_SUCCESSFUL_PARENTS = 12;

export async function fetchBisLbs() {
  const { results: perParent, errors } = await runParentFetchesConcurrent(PARENT_COUNTRIES, 4);
  const successfulParents = PARENT_COUNTRIES.length - errors.length;
  if (successfulParents < MIN_SUCCESSFUL_PARENTS) {
    throw new Error(
      `BIS CBS: only ${successfulParents}/${PARENT_COUNTRIES.length} parents succeeded ` +
        `(min ${MIN_SUCCESSFUL_PARENTS} required to avoid skewing parentCount). Errors: ${errors.join('; ')}`,
    );
  }
  if (errors.length > 0) {
    console.warn(`[bis-cbs] ${errors.length}/${PARENT_COUNTRIES.length} parent fetches failed (proceeding with ${successfulParents} successful): ${errors.join('; ')}`);
  }

  const gdpByCountry = await fetchGdpByCountry();
  const countries = combineCbsByCounterparty(perParent, gdpByCountry);

  // Provenance: counterparties seen in CBS but dropped because no
  // GDP record was available.
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
      'https://stats.bis.org/api/v1/data/WS_CBS_PUB',
      'https://www.bis.org/statistics/about_banking_stats.htm',
      'https://www.bis.org/terms_conditions.htm',
    ],
    seededAt: new Date().toISOString(),
  };
}

// CBS counterparty coverage spans ~150-200 jurisdictions per parent.
// Floor of 150 is conservative — at this threshold, a fresh seed
// represents the vast majority of manifest countries.
export function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 150;
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

export { CANONICAL_KEY, CACHE_TTL, PARENT_COUNTRIES };
// Backwards-compat alias for tests that imported the original LBS name.
export { combineCbsByCounterparty as combineLbsByCounterparty };

if (process.argv[1]?.endsWith('seed-bis-lbs.mjs')) {
  runSeed('economic', 'bis-lbs', CANONICAL_KEY, fetchBisLbs, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `bis-cbs-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    emptyDataIsFailure: true,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 14400,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
