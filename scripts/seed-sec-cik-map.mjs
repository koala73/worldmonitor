#!/usr/bin/env node

// Seeds the SEC ticker→CIK registry (company_tickers.json) into Redis as a slim
// {TICKER: {cik, name}} map. This is the authoritative attribution source for
// the corporate-intelligence endpoints (issue #5695): company identity always
// resolves through this registry — never through domain-slug guessing
// (issues #3754/#3755).

import { loadEnvFile, runSeed, withRetry, resolveProxy, curlFetch } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const SEC_CIK_MAP_KEY = 'intelligence:sec-cik-map:v1';
// 72h = 3× the daily bundle cadence (tests/seeder-canonical-ttl-vs-cron.test.mjs):
// cron drift must never TTL-out the canonical while seed-meta survives.
export const SEC_CIK_MAP_TTL_SECONDS = 72 * 3600;
export const SEC_CIK_MAP_MAX_STALE_MIN = 2880;
// The registry carries ~10k listed companies; a response an order of magnitude
// smaller means SEC served an error page or a truncated body — refuse to publish.
export const MIN_CIK_ENTRIES = 5000;

// SEC requires a declared User-Agent identifying the requester (no browser
// spoofing) — same convention as scripts/seed-regulatory-actions.mjs.
export const SEC_USER_AGENT = 'WorldMonitor/2.0 (monitor@worldmonitor.app)';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

// Raw shape: {"0": {cik_str: 320193, ticker: "AAPL", title: "Apple Inc."}, ...}
// keyed by arbitrary index. First occurrence of a ticker wins (the file lists
// primary listings before secondary share classes).
export function slimCikMap(raw) {
  const tickers = {};
  for (const entry of Object.values(raw ?? {})) {
    const ticker = String(entry?.ticker ?? '').trim().toUpperCase();
    const cik = Number(entry?.cik_str);
    const name = String(entry?.title ?? '').trim();
    if (!ticker || !Number.isFinite(cik) || cik <= 0 || !name) continue;
    if (!tickers[ticker]) tickers[ticker] = { cik, name };
  }
  return tickers;
}

async function fetchDirect() {
  const resp = await fetch(TICKERS_URL, {
    headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
  return resp.json();
}

export async function fetchCikMap({ fetchImpl = fetchDirect } = {}) {
  let raw;
  try {
    raw = await withRetry(fetchImpl, 2, 2000);
  } catch (err) {
    const proxyAuth = resolveProxy();
    if (!proxyAuth) throw err;
    console.warn(`  Direct SEC fetch failed (${err?.message}); retrying via proxy`);
    raw = JSON.parse(curlFetch(TICKERS_URL, proxyAuth, {
      'User-Agent': SEC_USER_AGENT,
      Accept: 'application/json',
    }));
  }
  return { tickers: slimCikMap(raw) };
}

export function validateCikMap(data) {
  return !!data?.tickers && Object.keys(data.tickers).length >= MIN_CIK_ENTRIES;
}

if (process.argv[1]?.endsWith('seed-sec-cik-map.mjs')) {
  runSeed('intelligence', 'sec-cik-map', SEC_CIK_MAP_KEY, fetchCikMap, {
    ttlSeconds: SEC_CIK_MAP_TTL_SECONDS,
    validateFn: validateCikMap,
    declareRecords: (data) => Object.keys(data?.tickers ?? {}).length,
    sourceVersion: 'sec-company-tickers-v1',
    schemaVersion: 1,
    maxStaleMin: SEC_CIK_MAP_MAX_STALE_MIN,
  });
}
