#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, resolveProxyForConnect, httpsProxyFetchRaw } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const WB_BASE = 'https://api.worldbank.org/v2';
const _proxyAuth = resolveProxyForConnect();
const CANONICAL_KEY = 'resilience:recovery:external-debt:v1';
const CACHE_TTL = 35 * 24 * 3600;

const DEBT_INDICATOR = 'DT.DOD.DSTC.CD';
const RESERVES_INDICATOR = 'FI.RES.TOTL.CD';

async function fetchWbIndicator(indicator) {
  const out = {};
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    // mrv=5 (NOT mrv=1) per memory `feedback_wb_bulk_mrv1_null_coverage_trap`:
    // mrv=1 returns a SINGLE year across all countries with `value: null`
    // for late-reporters (KW/QA/AE/etc. publish 1-2y behind G7), silently
    // dropping them from the dataset. mrv=5 + per-country pickLatest gives
    // a true latest-available-non-null per country. Same pattern used by
    // `seed-wb-external-debt.mjs` for the financialSystemExposure dim.
    const url = `${WB_BASE}/country/all/indicator/${indicator}?format=json&per_page=500&page=${page}&mrv=5`;
    let json;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      json = await resp.json();
    } catch (directErr) {
      if (!_proxyAuth) throw new Error(`World Bank ${indicator}: ${directErr.message}`);
      console.warn(`  WB ${indicator} p${page}: direct failed (${directErr.message}), retrying via proxy`);
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
      // CRITICAL: skip null records BEFORE Number() coercion.
      // Number(null) === 0 (not NaN), which would pass Number.isFinite()
      // and let a `value: null` record overwrite an older non-null
      // record in the latest-picker below — silently defeating the
      // mrv=5 + pickLatest fix. WB returns null for late-reporters
      // and out-of-scope countries; both should be skipped, not
      // coerced to 0. Spotted by reviewer post-PR-#3427-initial-push.
      if (record?.value == null) continue;
      const value = Number(record.value);
      if (!Number.isFinite(value)) continue;
      const year = Number(record?.date);
      if (!Number.isFinite(year)) continue;
      // Per-country latest-non-null. Order-agnostic (mrv=5 returns up
      // to 5 records per country, possibly across pages).
      const existing = out[iso2];
      if (!existing || year > existing.year) {
        out[iso2] = { value, year };
      }
    }
    page++;
  }
  return out;
}

async function fetchExternalDebt() {
  const [debtMap, reservesMap] = await Promise.all([
    fetchWbIndicator(DEBT_INDICATOR),
    fetchWbIndicator(RESERVES_INDICATOR),
  ]);

  const countries = {};
  let droppedHicZeroDebt = 0;
  const allCodes = new Set([...Object.keys(debtMap), ...Object.keys(reservesMap)]);

  for (const code of allCodes) {
    const debt = debtMap[code];
    const reserves = reservesMap[code];
    if (!debt || !reserves || reserves.value <= 0) continue;

    // Plan 2026-04-26 audit finding #7: WB IDS dataset (DT.DOD.DSTC.CD)
    // is LMIC-scoped. High-income countries get value=0 from this series
    // (not null — actually the literal zero), which under the previous
    // code translated to debtToReservesRatio=0 → score 100. 72/164
    // countries (44%) of the v15 ranking had this false-perfect signal,
    // including NO/CH/DK/SE/FI/IS/KW/AE/SG/LU. Filter those out: a real
    // LMIC-scoped IDS reading must have positive short-term debt. The
    // construct semantically applies to LMICs only, so dropping HIC is
    // correct (they get the dim's IMPUTE fallback score 50 / cov 0.3).
    if (debt.value <= 0) { droppedHicZeroDebt++; continue; }

    countries[code] = {
      debtToReservesRatio: Math.round((debt.value / reserves.value) * 1000) / 1000,
      year: debt.year ?? reserves.year ?? null,
    };
  }

  if (droppedHicZeroDebt > 0) {
    console.warn(`[recovery:external-debt] Dropped ${droppedHicZeroDebt} countries with debt=0 (HIC out-of-IDS-scope; would have falsely scored 100 on debtToReservesRatio).`);
  }

  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 80;
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

if (process.argv[1]?.endsWith('seed-recovery-external-debt.mjs')) {
  runSeed('resilience', 'recovery:external-debt', CANONICAL_KEY, fetchExternalDebt, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `wb-debt-reserves-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 86400,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
