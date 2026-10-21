#!/usr/bin/env node
/**
 * Audit every symbol declared in `marketCountryStockIndexes` against Yahoo
 * Finance, through the same helper and URL shape the seeder uses (#6240).
 *
 * Reports, per country, how many finite daily closes the 1-month chart carries
 * and whether `buildCountryStockIndexSnapshot` — the builder the seeder publishes
 * through — accepts the chart. A chart it rejects is a country the RPC can only
 * ever answer `available: false`.
 *
 * Exit status:
 *   1  the contract disagrees with Yahoo in either direction:
 *        - a serviceable entry produced no snapshot (flag it, or fix the symbol), or
 *        - an `unavailable` entry now produces one (lift the flag).
 *   2  no disagreement, but at least one probe failed (rate limit, timeout,
 *      proxy error). A failed probe says nothing about the symbol, so it never
 *      counts toward either verdict above; re-run before changing a flag.
 *   0  every probe succeeded and matched the contract.
 *
 * Network-bound, so it is not part of `npm run test:data`; run it by hand when
 * adding a country or revisiting a flag:
 *
 *   node scripts/audit-country-stock-index-symbols.mjs
 *
 * Like the seeder, it loads `.env.local` so `fetchYahooJson` can fall back to the
 * PROXY_URL curl path when Yahoo rate-limits the direct request.
 */
import { loadDeclaredCountryStockIndexes } from './_country-stock-index-registry.mjs';
import { buildCountryStockIndexSnapshot } from './_country-stock-index.mjs';
import { loadEnvFile } from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';
import { isMainModule } from './lib/main-module.mjs';

// Same stagger as YAHOO_DELAY_MS in scripts/seed-market-quotes.mjs.
const YAHOO_DELAY_MS = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function chartUrl(symbol) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
}

export function countFiniteCloses(chart) {
  const closes = chart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
  return Array.isArray(closes) ? closes.filter((value) => Number.isFinite(value)).length : 0;
}

/**
 * Classify one declared entry against its probe result. Pure, so the decision
 * table is unit-testable without touching the network.
 *
 * @returns {'ok' | 'flagged-still-dead' | 'dead-but-serviceable' | 'flag-can-lift' | 'probe-error'}
 */
export function classify(index, { snapshot, error }) {
  if (error) return 'probe-error';
  if (index.unavailable) return snapshot ? 'flag-can-lift' : 'flagged-still-dead';
  return snapshot ? 'ok' : 'dead-but-serviceable';
}

/** @returns {0 | 1 | 2} see the exit status table in the file header. */
export function exitCodeFor(rows) {
  if (rows.some((row) => row.verdict === 'dead-but-serviceable' || row.verdict === 'flag-can-lift')) return 1;
  if (rows.some((row) => row.verdict === 'probe-error')) return 2;
  return 0;
}

export async function auditCountryStockIndexes({
  indexes = loadDeclaredCountryStockIndexes(),
  fetchJson = fetchYahooJson,
  delayMs = YAHOO_DELAY_MS,
} = {}) {
  const rows = [];
  for (const index of indexes) {
    let probe;
    try {
      if (rows.length > 0) await sleep(delayMs);
      const chart = await fetchJson(chartUrl(index.symbol), { label: `${index.code} country index audit` });
      const closes = countFiniteCloses(chart);
      probe = { closes, snapshot: Boolean(buildCountryStockIndexSnapshot(chart, undefined, index)), error: null };
    } catch (err) {
      probe = { closes: 0, snapshot: false, error: err?.message || String(err) };
    }
    rows.push({ ...index, ...probe, verdict: classify(index, probe) });
  }
  return rows;
}

function formatRow(row) {
  const flag = row.unavailable ? `unavailable since ${row.unavailable.checked}` : '';
  const detail = row.error ? `error: ${row.error}` : `${row.closes} closes`;
  return `${row.code.padEnd(3)} ${row.symbol.padEnd(12)} ${detail.padEnd(28)} ${row.verdict.padEnd(22)} ${flag}`;
}

const codesWith = (rows, verdict) => rows.filter((row) => row.verdict === verdict).map((row) => row.code);

async function main() {
  loadEnvFile(import.meta.url);
  const rows = await auditCountryStockIndexes();
  for (const row of rows) console.log(formatRow(row));
  console.log(
    `\n${rows.length} declared, ${codesWith(rows, 'ok').length} serving, `
    + `${rows.filter((row) => row.unavailable).length} flagged unavailable.`,
  );
  const dead = codesWith(rows, 'dead-but-serviceable');
  const liftable = codesWith(rows, 'flag-can-lift');
  const inconclusive = codesWith(rows, 'probe-error');
  if (dead.length > 0) {
    console.error(`\nServiceable entries Yahoo cannot serve — fix the symbol or flag them: ${dead.join(', ')}`);
  }
  if (liftable.length > 0) {
    console.error(`\nFlagged entries that now return closes — lift the flag: ${liftable.join(', ')}`);
  }
  if (inconclusive.length > 0) {
    console.error(`\nProbes failed, no verdict — re-run before changing any flag: ${inconclusive.join(', ')}`);
  }
  process.exitCode = exitCodeFor(rows);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
