#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const WB_BASE = 'https://api.worldbank.org/v2';
const CANONICAL_KEY = 'resilience:recovery:reserve-adequacy:v1';
const CACHE_TTL = 35 * 24 * 3600;
const INDICATOR = 'FI.RES.TOTL.MO';

async function fetchReserveAdequacy() {
  const pages = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${WB_BASE}/country/all/indicator/${INDICATOR}?format=json&per_page=500&page=${page}&mrv=1`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`World Bank ${INDICATOR}: HTTP ${resp.status}`);
    const json = await resp.json();
    const meta = json[0];
    const records = json[1] ?? [];
    totalPages = meta?.pages ?? 1;
    pages.push(...records);
    page++;
  }

  const countries = {};
  for (const record of pages) {
    const rawCode = record?.countryiso3code ?? record?.country?.id ?? '';
    const iso2 = rawCode.length === 3 ? (iso3ToIso2[rawCode] ?? null) : (rawCode.length === 2 ? rawCode : null);
    if (!iso2) continue;
    const value = Number(record?.value);
    if (!Number.isFinite(value)) continue;
    const year = Number(record?.date);

    countries[iso2] = {
      reserveMonths: value,
      year: Number.isFinite(year) ? year : null,
    };
  }

  return { countries, seededAt: new Date().toISOString() };
}

function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 100;
}

if (process.argv[1]?.endsWith('seed-recovery-reserve-adequacy.mjs')) {
  runSeed('resilience', 'recovery:reserve-adequacy', CANONICAL_KEY, fetchReserveAdequacy, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `wb-reserves-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
