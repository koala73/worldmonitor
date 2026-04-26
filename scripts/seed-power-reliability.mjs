#!/usr/bin/env node

// PR 1 of the resilience repair plan (§3.1). Writes per-country
// electric power transmission + distribution losses. Read by
// scoreEnergy v2 via `resilience:power-losses:v1` as the direct
// grid-integrity signal that replaces the retired electricityConsumption
// wealth proxy.
//
// Source: World Bank WDI EG.ELC.LOSS.ZS — "Electric power
// transmission and distribution losses (% of output)". Annual
// cadence. Lower is better; developing economies often report 15-25%,
// OECD economies typically 3-8%.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const WB_BASE = 'https://api.worldbank.org/v2';
const CANONICAL_KEY = 'resilience:power-losses:v1';
const CACHE_TTL = 35 * 24 * 3600;
const INDICATOR = 'EG.ELC.LOSS.ZS';

async function fetchPowerLosses() {
  const pages = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    // mrv=5 (NOT mrv=1) per memory `feedback_wb_bulk_mrv1_null_coverage_trap`:
    // mrv=1 returns a SINGLE year across all countries with `value: null` for
    // late-reporters (KW/QA/AE publish 1-2y behind G7), silently dropping
    // them. mrv=5 + per-country pickLatest gives a true latest-non-null.
    const url = `${WB_BASE}/country/all/indicator/${INDICATOR}?format=json&per_page=2000&page=${page}&mrv=5`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`World Bank ${INDICATOR}: HTTP ${resp.status}`);
    const json = await resp.json();
    totalPages = json[0]?.pages ?? 1;
    pages.push(...(json[1] ?? []));
    page++;
  }

  const countries = {};
  for (const record of pages) {
    const rawCode = record?.countryiso3code ?? record?.country?.id ?? '';
    const iso2 = rawCode.length === 3 ? (iso3ToIso2[rawCode] ?? null) : (rawCode.length === 2 ? rawCode : null);
    if (!iso2) continue;
    // CRITICAL: skip null records BEFORE Number() coercion.
    // Number(null) === 0 (not NaN), passes Number.isFinite(), and would
    // let a `value: null` record overwrite an older non-null record below.
    // EG.ELC.LOSS.ZS is a "% of" indicator where 0 IS legitimate (perfect
    // grid reliability), so we CAN'T use the `value <= 0` defense — must
    // skip null explicitly. Same recipe as PR #3427.
    if (record?.value == null) continue;
    const value = Number(record.value);
    if (!Number.isFinite(value)) continue;
    const year = Number(record?.date);
    if (!Number.isFinite(year)) continue;
    // Per-country latest-non-null (mrv=5 returns up to 5 records per country).
    const existing = countries[iso2];
    if (!existing || year > existing.year) {
      countries[iso2] = { value, year };
    }
  }

  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 150;
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

if (process.argv[1]?.endsWith('seed-power-reliability.mjs')) {
  runSeed('resilience', 'power-losses', CANONICAL_KEY, fetchPowerLosses, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `wb-power-losses-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 8 * 24 * 60,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
