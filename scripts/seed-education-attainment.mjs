#!/usr/bin/env node
//
// World Bank — female upper-secondary educational attainment
// Canonical key: resilience:education-attainment:v1
//
//   SE.SEC.CUAT.UP.FE.ZS — Educational attainment, at least completed
//                          upper secondary, population 25+, female (%)
//
// Feeds the `education` dimension of the Country Resilience Index
// (`scoreEducation` in `_dimension-scorers.ts`). See
// `docs/methodology/education-attainment.md` for the construct.
//
// Why the FEMALE variant and not the total:
//   The causal literature this construct rests on (Striessnig, Lutz & Patt
//   2013; Lutz, Muttarak & Striessnig 2014) reports the income-independent
//   effect on female secondary attainment specifically. Coverage is
//   identical — the female, male, and total series cover the same 181 of
//   the 196 rankable countries — so the mechanism-truest variant costs
//   nothing. Measured 2026-08-10 against `scripts/shared/sovereign-status.json`.
//
// Coverage shape (measured, not estimated):
//   181/196 rankable countries. The 15 absent are BB, ER, GA, GQ, KG, KN,
//   KP, LI, LY, MC, SS, ST, SY, TW, VC — micro-states, DPRK, and conflict
//   states. All nine high-income probes (US, DE, JP, GB, FR, CA, AU, NO,
//   CH) are present, which is what disqualified adult literacy
//   (SE.ADT.LITR.ZS) for this construct: it covers only 131 and is missing
//   the entire OECD bloc.
//
// TW is absent from ALL World Bank data and always will be. It is a
// structural absence, not a fetch failure — the practical ceiling for any
// World Bank series against this universe is 195/196.

import { loadEnvFile, CHROME_UA, runSeed, resolveProxyForConnect, httpsProxyFetchRaw } from './_seed-utils.mjs';
import { wbCountryDictContentMeta } from './_wb-country-dict-content-age-helpers.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const WB_BASE = 'https://api.worldbank.org/v2';
const _proxyAuth = resolveProxyForConnect();
const CANONICAL_KEY = 'resilience:education-attainment:v1';
const CACHE_TTL = 35 * 24 * 3600; // 35 days; the series publishes annually

// Content-age budget. Educational attainment of the 25+ population is a
// slow-moving stock published on an irregular survey cadence — 39 of the
// 181 covered countries already carry an observation older than 5 years,
// including JP, CN, NZ, and KZ. 48 months mirrors the WB IDS budget and
// fires STALE_CONTENT only when the World Bank stops publishing entirely.
const MAX_CONTENT_AGE_MIN = 48 * 30 * 24 * 60;

const ATTAINMENT_INDICATOR = 'SE.SEC.CUAT.UP.FE.ZS';

// Observation window. Matches the window the coverage measurement used, so
// the published record count reproduces the measured 181. A country whose
// only observation predates 2011 is treated as uncovered rather than
// published at a 15+ year vintage.
const WINDOW_START = 2011;

// Validation floor. Deliberately well below the measured 181 so a transient
// World Bank dip does not refresh seed-meta on a truncated payload and
// freeze the bundle (memory: `feedback_strict_floor_validate_fail_poisons_seed_meta`).
// This is NOT the flag-flip gate — that separately requires recordCount >= 175
// per `docs/methodology/education-flag-flip-runbook.md`.
const MIN_COUNTRIES = 150;

// Pure record reducer, exported so the parsing traps below are testable
// without network. Folds a page of World Bank rows into `out`, keeping the
// most recent observation per ISO2 country.
export function reduceAttainmentRecords(records, out = {}) {
  for (const record of records ?? []) {
    const rawCode = record?.countryiso3code ?? record?.country?.id ?? '';
    const iso2 = rawCode.length === 3 ? (iso3ToIso2[rawCode] ?? null) : (rawCode.length === 2 ? rawCode : null);
    if (!iso2) continue;
    // CRITICAL: skip nulls BEFORE Number() coercion. Number(null) === 0,
    // which is finite, so a `value: null` record for a late reporter would
    // otherwise overwrite a real earlier observation with a false 0%
    // attainment — and 0% is a *plausible* value for this series (the
    // observed minimum is Niger at 1.15%), so it would not look wrong
    // downstream. Same trap as PR #3427 / #3432.
    if (record?.value == null) continue;
    const value = Number(record.value);
    if (!Number.isFinite(value)) continue;
    // The series is a percentage of population; anything outside 0..100 is
    // upstream corruption, not a real reading.
    if (value < 0 || value > 100) continue;
    const year = Number(record?.date);
    if (!Number.isFinite(year)) continue;

    const existing = out[iso2];
    if (!existing || year > existing.year) {
      out[iso2] = { value, year };
    }
  }
  return out;
}

async function fetchAttainment() {
  const out = {};
  let page = 1;
  let totalPages = 1;
  const windowEnd = new Date().getUTCFullYear();

  while (page <= totalPages) {
    const url = `${WB_BASE}/country/all/indicator/${ATTAINMENT_INDICATOR}`
      + `?format=json&per_page=500&page=${page}&date=${WINDOW_START}:${windowEnd}`;
    let json;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      json = await resp.json();
    } catch (directErr) {
      if (!_proxyAuth) throw new Error(`World Bank ${ATTAINMENT_INDICATOR}: ${directErr.message}`);
      console.warn(`  WB ${ATTAINMENT_INDICATOR} p${page}: direct failed (${directErr.message}), retrying via proxy`);
      const { buffer } = await httpsProxyFetchRaw(url, _proxyAuth, { accept: 'application/json', timeoutMs: 30_000 });
      json = JSON.parse(buffer.toString('utf8'));
    }

    const meta = json[0];
    totalPages = meta?.pages ?? 1;
    reduceAttainmentRecords(json[1] ?? [], out);
    page++;
  }
  return out;
}

async function fetchEducationAttainment() {
  const countries = await fetchAttainment();
  return {
    countries,
    sources: [`https://data.worldbank.org/indicator/${ATTAINMENT_INDICATOR}`],
    seededAt: new Date().toISOString(),
  };
}

export function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= MIN_COUNTRIES;
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

export { CANONICAL_KEY, CACHE_TTL, MIN_COUNTRIES, ATTAINMENT_INDICATOR, WINDOW_START, fetchEducationAttainment, fetchAttainment };

if (process.argv[1]?.endsWith('seed-education-attainment.mjs')) {
  runSeed('resilience', 'education-attainment', CANONICAL_KEY, fetchEducationAttainment, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `wb-education-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    // Empty result = real upstream failure, not a world with no schooling.
    emptyDataIsFailure: true,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 100800,
    contentMeta: wbCountryDictContentMeta,
    maxContentAgeMin: MAX_CONTENT_AGE_MIN,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
