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
    const url = `${WB_BASE}/country/all/indicator/${indicator}?format=json&per_page=500&page=${page}&mrv=1`;
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
      const value = Number(record?.value);
      if (!Number.isFinite(value)) continue;
      out[iso2] = { value, year: Number(record?.date) || null };
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
  const allCodes = new Set([...Object.keys(debtMap), ...Object.keys(reservesMap)]);

  for (const code of allCodes) {
    const debt = debtMap[code];
    const reserves = reservesMap[code];
    if (!debt || !reserves || reserves.value <= 0) continue;

    countries[code] = {
      debtToReservesRatio: Math.round((debt.value / reserves.value) * 1000) / 1000,
      year: debt.year ?? reserves.year ?? null,
    };
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
