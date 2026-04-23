#!/usr/bin/env node
//
// Seeder — Sovereign Wealth Fund AUM (for the `sovereignFiscalBuffer`
// resilience dimension, PR 2 §3.4).
//
// Source priority (per plan §3.4, amended 2026-04-23 — see
// "SWFI availability note" below):
//   1. Official fund disclosures (MoF, central bank, fund annual reports).
//      Hand-curated endpoint map; highest confidence. STUBBED in this
//      commit (per-fund scrape adapters added incrementally).
//   2. IFSWF member-fund filings. Santiago-principle compliant funds
//      publish audited AUM via the IFSWF secretariat. STUBBED.
//   3. WIKIPEDIA `List_of_sovereign_wealth_funds` — license-free public
//      fallback (CC-BY-SA, attribution required; see `SOURCE_ATTRIBUTION`
//      below). IMPLEMENTED. Wikipedia per-fund AUM is community-curated
//      with primary-source citations on the article; lower confidence than
//      tier 1 / 2 but sufficient for the `sovereignFiscalBuffer` score's
//      saturating transform (large relative errors in AUM get compressed
//      by the exponential in `score = 100 × (1 − exp(−effectiveMonths /
//      12))`, so tier-3 noise does not dominate ranking outcomes).
//
// SWFI availability note. The plan's original fallback target was the
// SWFI public fund-rankings page at
// https://www.swfinstitute.org/fund-rankings/sovereign-wealth-fund.
// Empirical check on 2026-04-23: the page's <tbody> is empty and AUM is
// gated behind a lead-capture form (name + company + job title). SWFI
// individual `/profile/<id>` pages are similarly barren. The "public
// fund-rankings" source is effectively no longer public. Scraping the
// lead-gated surface would require submitting fabricated contact info
// — a TOS violation and legally questionable — so we pivot tier 3 to
// Wikipedia, which is both legally clean (CC-BY-SA) and structurally
// scrapable. The SWFI Linaburg-Maduell transparency index mentioned in
// the manifest's `transparency` rationale text is a SEPARATE SWFI
// publication (public index scores), not the fund-rankings paywall —
// those citations stay valid.
//
// Cadence: quarterly (plan §3.4). Railway cron cadence: weekly refresh
// with ~35-day TTL (mirrors other recovery-domain seeders so stale data
// is caught by the seed-meta gate before it leaks into rankings).
//
// Output shape (Redis key `resilience:recovery:sovereign-wealth:v1`,
// enveloped through `_seed-utils.mjs`):
//
//   {
//     countries: {
//       [iso2]: {
//         funds: [
//           {
//             fund: 'gpfg',
//             aum: <number, USD>,
//             aumYear: <number>,
//             source: 'official' | 'ifswf' | 'wikipedia',
//             access: <number 0..1>,
//             liquidity: <number 0..1>,
//             transparency: <number 0..1>,
//             rawMonths: <number, = aum / annualImports × 12>,
//             effectiveMonths: <number, = rawMonths × access × liquidity × transparency>,
//           },
//           ...
//         ],
//         totalEffectiveMonths: <number>,  // Σ per-fund effectiveMonths
//         annualImports: <number, USD>,    // WB NE.IMP.GNFS.CD, for audit
//       }
//     },
//     seededAt: <ISO8601>,
//     manifestVersion: <number>,
//     sourceMix: { official: <count>, ifswf: <count>, wikipedia: <count> },
//   }
//
// Countries WITHOUT an entry in the manifest are absent from this
// payload. The scorer is expected to treat "no entry in payload" as
// "no sovereign wealth fund" and score 0 with full coverage (plan
// §3.4 "What happens to no-SWF countries"). This is substantively
// different from IMPUTE fallback (which is "data-source-failed").

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };
import { groupFundsByCountry, loadSwfManifest } from './shared/swf-manifest-loader.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'resilience:recovery:sovereign-wealth:v1';
const CACHE_TTL_SECONDS = 35 * 24 * 3600;
const WB_BASE = 'https://api.worldbank.org/v2';
const IMPORTS_INDICATOR = 'NE.IMP.GNFS.CD';

const WIKIPEDIA_URL = 'https://en.wikipedia.org/wiki/List_of_sovereign_wealth_funds';
export const WIKIPEDIA_SOURCE_ATTRIBUTION =
  'Wikipedia — List of sovereign wealth funds (CC-BY-SA 4.0)';

// ── World Bank: per-country annual imports (denominator for rawMonths) ──

async function fetchAnnualImportsUsd() {
  const pages = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const url = `${WB_BASE}/country/all/indicator/${IMPORTS_INDICATOR}?format=json&per_page=500&page=${page}&mrv=1`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`World Bank ${IMPORTS_INDICATOR}: HTTP ${resp.status}`);
    const json = await resp.json();
    const meta = json[0];
    const records = json[1] ?? [];
    totalPages = meta?.pages ?? 1;
    pages.push(...records);
    page++;
  }
  const imports = {};
  for (const record of pages) {
    const rawCode = record?.countryiso3code ?? record?.country?.id ?? '';
    const iso2 = rawCode.length === 3 ? (iso3ToIso2[rawCode] ?? null) : (rawCode.length === 2 ? rawCode : null);
    if (!iso2) continue;
    const value = Number(record?.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    const year = Number(record?.date);
    imports[iso2] = { importsUsd: value, year: Number.isFinite(year) ? year : null };
  }
  return imports;
}

// ── Tier 1: official disclosure endpoints (per-fund hand-curated) ──
//
// STUBBED. Each fund's annual-report / press-release page has a
// different structure; the scrape logic must be bespoke per fund.
// Added incrementally in follow-up commits.
//
// Returns { aum: number, aumYear: number, source: 'official' } or null.
async function fetchOfficialDisclosure(_fund) {
  return null;
}

// ── Tier 2: IFSWF secretariat filings ──
//
// STUBBED. IFSWF publishes member-fund AUM at
// https://www.ifswf.org/member-profiles/<slug> but layout varies per
// fund. Deferred to a follow-up commit.
//
// Returns { aum: number, aumYear: number, source: 'ifswf' } or null.
async function fetchIfswfFiling(_fund) {
  return null;
}

// ── Tier 3: Wikipedia fallback ──

// Wikipedia's country-name spelling for each manifest ISO-2. Used by the
// disambiguator to break abbrev collisions (e.g. "PIF" resolves to both
// Saudi Arabia's Public Investment Fund and Palestine's Palestine
// Investment Fund — without a country filter, the latter would silently
// shadow the former). Extend this map when adding a manifest entry
// whose country is new.
const ISO2_TO_WIKIPEDIA_COUNTRY_NAME = new Map([
  ['NO', 'norway'],
  ['AE', 'united arab emirates'],
  ['SA', 'saudi arabia'],
  ['KW', 'kuwait'],
  ['QA', 'qatar'],
  ['SG', 'singapore'],
]);

function normalizeAbbrev(value) {
  return String(value || '').toUpperCase().replace(/[-\s.]/g, '');
}

function normalizeFundName(value) {
  return String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizeCountryName(value) {
  return String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function pushIndexed(map, key, record) {
  if (!key) return;
  const list = map.get(key) ?? [];
  list.push(record);
  map.set(key, list);
}

function stripHtmlInline(value) {
  // HTML tags replace with a space (not empty) so inline markup like
  // `302.0<sup>41</sup>` becomes `302.0 41` — otherwise the decimal
  // value and its trailing footnote ref get welded into `302.041`,
  // which the Assets regex then mis-parses as a single number.
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[#\w]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse the Wikipedia wikitable HTML into lookup-by-abbrev / lookup-
 * by-fund-name caches. Exported so it can be unit-tested against a
 * committed fixture without a live fetch.
 *
 * Assumed columns (verified 2026-04-23 on the shipping article):
 *   [0] Country or region
 *   [1] Abbrev.
 *   [2] Fund name
 *   [3] Assets (in USD billions, optionally followed by a footnote
 *       reference like "2,117 37" — strip the trailing integer).
 *   [4] Inception year
 *   [5] Origin (Oil Gas / Non-commodity / etc.)
 *
 * Returns Maps keyed by normalized value → LIST of records. Multiple
 * records under one key is a real case: "PIF" resolves to both Saudi
 * Arabia's Public Investment Fund and Palestine's Palestine Investment
 * Fund. The matcher disambiguates via manifest country at lookup time
 * rather than letting Map.set silently overwrite.
 *
 * Record: { aum, aumYear, fundName, countryName, inceptionYear }.
 *
 * @param {string} html full article HTML
 * @returns {{ byAbbrev: Map<string, object[]>, byFundName: Map<string, object[]> }}
 */
export function parseWikipediaRankingsTable(html) {
  const tableMatch = html.match(/<table class="wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/);
  if (!tableMatch) throw new Error('Wikipedia article: wikitable not found');
  const tbl = tableMatch[1];

  const byAbbrev = new Map();
  const byFundName = new Map();
  const nowYear = new Date().getFullYear();

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(tbl)) !== null) {
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) cells.push(cellMatch[1]);
    if (cells.length < 5) continue;

    const countryName = stripHtmlInline(cells[0]);
    const abbrev = stripHtmlInline(cells[1]);
    const fundName = stripHtmlInline(cells[2]);
    const assetsCell = stripHtmlInline(cells[3]);
    const inceptionCell = stripHtmlInline(cells[4]);

    // "2,117 37" → 2117 billion (strip optional trailing footnote int)
    const assetsMatch = assetsCell.match(/^([\d,]+(?:\.\d+)?)(?:\s+\d+)?\s*$/);
    if (!assetsMatch) continue;
    const aumBillions = parseFloat(assetsMatch[1].replace(/,/g, ''));
    if (!Number.isFinite(aumBillions) || aumBillions <= 0) continue;
    const aum = aumBillions * 1_000_000_000;

    const inceptionYearMatch = inceptionCell.match(/(\d{4})/);
    const inceptionYear = inceptionYearMatch ? parseInt(inceptionYearMatch[1], 10) : null;

    const record = { aum, aumYear: nowYear, fundName, countryName, inceptionYear };

    pushIndexed(byAbbrev, normalizeAbbrev(abbrev), record);
    pushIndexed(byFundName, normalizeFundName(fundName), record);
  }

  return { byAbbrev, byFundName };
}

async function loadWikipediaRankingsCache() {
  const resp = await fetch(WIKIPEDIA_URL, {
    headers: {
      'User-Agent': CHROME_UA,
      'Accept': 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`Wikipedia SWF list: HTTP ${resp.status}`);
  const html = await resp.text();
  return parseWikipediaRankingsTable(html);
}

function pickByCountry(candidates, fundCountryIso2) {
  if (!candidates || candidates.length === 0) return null;
  // Single candidate → return it (country clash is not possible).
  if (candidates.length === 1) return candidates[0];
  // Multiple candidates → require a country-name match to pick one.
  // Returning null here is the safe choice: it means "ambiguous match",
  // which the seeder surfaces as an unmatched fund (logged), rather
  // than silently returning the wrong fund's AUM.
  const expectedCountryName = ISO2_TO_WIKIPEDIA_COUNTRY_NAME.get(fundCountryIso2);
  if (!expectedCountryName) return null;
  for (const record of candidates) {
    if (normalizeCountryName(record.countryName) === expectedCountryName) return record;
  }
  return null;
}

export function matchWikipediaRecord(fund, cache) {
  const hints = fund.wikipedia;
  if (!hints) return null;
  if (hints.abbrev) {
    const hit = pickByCountry(cache.byAbbrev.get(normalizeAbbrev(hints.abbrev)), fund.country);
    if (hit) return hit;
  }
  if (hints.fundName) {
    const hit = pickByCountry(cache.byFundName.get(normalizeFundName(hints.fundName)), fund.country);
    if (hit) return hit;
  }
  return null;
}

async function fetchWikipediaRanking(fund, cache) {
  const hit = matchWikipediaRecord(fund, cache);
  if (!hit) return null;
  return { aum: hit.aum, aumYear: hit.aumYear, source: 'wikipedia' };
}

// ── Aggregation ──

async function fetchFundAum(fund, wikipediaCache) {
  // Source priority: official → IFSWF → Wikipedia. Short-circuit on
  // first non-null return so the highest-confidence source wins.
  const official = await fetchOfficialDisclosure(fund);
  if (official) return official;
  const ifswf = await fetchIfswfFiling(fund);
  if (ifswf) return ifswf;
  const wikipedia = await fetchWikipediaRanking(fund, wikipediaCache);
  if (wikipedia) return wikipedia;
  return null;
}

export async function fetchSovereignWealth() {
  const manifest = loadSwfManifest();
  const [imports, wikipediaCache] = await Promise.all([
    fetchAnnualImportsUsd(),
    loadWikipediaRankingsCache(),
  ]);

  const countries = {};
  const sourceMix = { official: 0, ifswf: 0, wikipedia: 0 };
  const unmatched = [];

  for (const [iso2, funds] of groupFundsByCountry(manifest)) {
    const importsEntry = imports[iso2];
    if (!importsEntry) continue;

    const fundRecords = [];
    for (const fund of funds) {
      const aum = await fetchFundAum(fund, wikipediaCache);
      if (!aum) {
        unmatched.push(`${fund.country}:${fund.fund}`);
        continue;
      }
      sourceMix[aum.source] = (sourceMix[aum.source] ?? 0) + 1;

      const { access, liquidity, transparency } = fund.classification;
      const rawMonths = (aum.aum / importsEntry.importsUsd) * 12;
      const effectiveMonths = rawMonths * access * liquidity * transparency;

      fundRecords.push({
        fund: fund.fund,
        aum: aum.aum,
        aumYear: aum.aumYear,
        source: aum.source,
        access,
        liquidity,
        transparency,
        rawMonths,
        effectiveMonths,
      });
    }

    if (fundRecords.length === 0) continue;
    const totalEffectiveMonths = fundRecords.reduce((s, f) => s + f.effectiveMonths, 0);
    countries[iso2] = {
      funds: fundRecords,
      totalEffectiveMonths,
      annualImports: importsEntry.importsUsd,
    };
  }

  if (unmatched.length > 0) {
    console.warn(`[seed-sovereign-wealth] ${unmatched.length} fund(s) unmatched across all tiers: ${unmatched.join(', ')}`);
  }

  return {
    countries,
    seededAt: new Date().toISOString(),
    manifestVersion: manifest.manifestVersion,
    sourceMix,
    sourceAttribution: {
      wikipedia: sourceMix.wikipedia > 0 ? WIKIPEDIA_SOURCE_ATTRIBUTION : undefined,
    },
  };
}

function validate(data) {
  // Tier 3 (Wikipedia) is now live; expected floor = 1 country once any
  // manifest fund matches. We keep the floor lenient (>=0) during the
  // first Railway-cron bake-in window so a transient Wikipedia fetch
  // failure does not poison seed-meta for 30 days (see
  // feedback_strict_floor_validate_fail_poisons_seed_meta.md). Once
  // the seeder has ~7 days of clean runs, tighten to `>= 1`.
  return typeof data?.countries === 'object';
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

if (process.argv[1]?.endsWith('seed-sovereign-wealth.mjs')) {
  runSeed('resilience', 'recovery:sovereign-wealth', CANONICAL_KEY, fetchSovereignWealth, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL_SECONDS,
    sourceVersion: `swf-manifest-v1-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 86400,
    // Empty payload is still acceptable while tiers 1/2 are stubbed
    // and any transient Wikipedia outage occurs; downstream IMPUTE
    // path handles it.
    emptyDataIsFailure: false,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
