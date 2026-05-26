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
//             source: 'official' | 'ifswf' | 'wikipedia_list' | 'wikipedia_infobox',
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
//         expectedFunds: <number>,         // manifest count for this country
//         matchedFunds: <number>,          // funds whose AUM resolved
//         completeness: <number 0..1>,     // matchedFunds / expectedFunds
//       }
//     },
//     seededAt: <ISO8601>,
//     manifestVersion: <number>,
//     sourceMix: {
//       official: <count>, ifswf: <count>,
//       wikipedia_list: <count>, wikipedia_infobox: <count>,
//     },
//   }
//
// Countries WITHOUT an entry in the manifest are absent from this
// payload. The scorer is expected to treat "no entry in payload" as
// "no sovereign wealth fund" and score 0 with full coverage (plan
// §3.4 "What happens to no-SWF countries"). This is substantively
// different from IMPUTE fallback (which is "data-source-failed").

import { loadEnvFile, CHROME_UA, runSeed, readSeedSnapshot, SHARED_FX_FALLBACKS, getSharedFxRates, getBundleRunStartedAtMs } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };
import { groupFundsByCountry, loadSwfManifest } from './shared/swf-manifest-loader.mjs';

const REEXPORT_SHARE_CANONICAL_KEY = 'resilience:recovery:reexport-share:v1';
const REEXPORT_SHARE_META_KEY = 'seed-meta:resilience:recovery:reexport-share';

/**
 * Read the Comtrade-seeded re-export-share map from Redis, guarded by
 * bundle-run freshness. Returns an empty Map on any failure signal —
 * missing key, malformed payload, or seed-meta older than this bundle
 * run. The caller treats an empty map as "use gross imports for all
 * countries" (status-quo fallback).
 *
 * Why bundle-run freshness matters: the Reexport-Share seeder runs
 * immediately before this SWF seeder inside the resilience-recovery
 * bundle. If that seeder fails (Comtrade outage, 429 storm, timeout),
 * its Redis key still holds LAST MONTH's envelope — reading that
 * would silently apply stale shares to the current month's SWF data.
 * The bundle-freshness guard rejects any meta predating the current
 * bundle run, forcing a hard fallback to gross imports.
 *
 * @returns {Promise<Map<string, { reexportShareOfImports: number, year: number | null, sources: string[] }>>}
 */
export async function loadReexportShareFromRedis() {
  const map = new Map();
  const raw = await readSeedSnapshot(REEXPORT_SHARE_CANONICAL_KEY);
  if (!raw || typeof raw !== 'object') {
    console.warn('[seed-sovereign-wealth] reexport-share Redis key empty/malformed; falling back to gross-imports denominator for all countries');
    return map;
  }

  const metaRaw = await readSeedSnapshot(REEXPORT_SHARE_META_KEY);
  const fetchedAtMs = Number(metaRaw?.fetchedAt ?? 0);
  if (!fetchedAtMs) {
    // Meta absent or malformed — can't tell whether the peer seeder ran.
    // Safer to treat as outage than to trust the data key alone.
    console.warn('[seed-sovereign-wealth] reexport-share seed-meta absent/malformed; falling back to gross-imports denominator for all countries');
    return map;
  }
  const bundleStartMs = getBundleRunStartedAtMs();
  // Freshness gate applies ONLY when spawned by _bundle-runner.mjs (i.e.
  // `getBundleRunStartedAtMs()` returns a timestamp). Standalone runs
  // (manual invocation, operator debugging) return null and skip the
  // gate: the operator is responsible for running the peer seeder
  // first, and we trust any `fetchedAt` in that context. The gate's
  // purpose is protecting against across-bundle-tick staleness inside
  // a cron run, which has no analog outside a bundle.
  if (bundleStartMs != null && fetchedAtMs < bundleStartMs) {
    const ageMin = ((Date.now() - fetchedAtMs) / 60_000).toFixed(0);
    console.warn(`[seed-sovereign-wealth] reexport-share seed-meta NOT from this bundle run (age=${ageMin}min, bundleStart=${new Date(bundleStartMs).toISOString()}). Falling back to gross imports for all countries.`);
    return map;
  }

  const countries = raw.countries ?? {};
  for (const [iso2, entry] of Object.entries(countries)) {
    const share = entry?.reexportShareOfImports;
    // Numeric bounds check — NaN / Infinity / negative / ≥ 1 all pass
    // `typeof === 'number'`. computeNetImports requires share ∈ [0, 1).
    // The Comtrade seeder caps at 0.95 but this guard protects against
    // a rogue payload (e.g. a manual redis-cli write mid-migration).
    if (!Number.isFinite(share) || share < 0 || share > 0.95) {
      console.warn(`[seed-sovereign-wealth] ${iso2} share ${share} fails bounds check [0, 0.95]; skipping`);
      continue;
    }
    map.set(iso2, {
      reexportShareOfImports: share,
      year: entry?.year ?? null,
      sources: Array.isArray(entry?.sources) ? entry.sources : [],
    });
  }
  return map;
}

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'resilience:recovery:sovereign-wealth:v1';
const CACHE_TTL_SECONDS = 35 * 24 * 3600;
const WB_BASE = 'https://api.worldbank.org/v2';
const IMPORTS_INDICATOR = 'NE.IMP.GNFS.CD';

const WIKIPEDIA_URL = 'https://en.wikipedia.org/wiki/List_of_sovereign_wealth_funds';
export const WIKIPEDIA_SOURCE_ATTRIBUTION =
  'Wikipedia — List of sovereign wealth funds + per-fund articles (CC-BY-SA 4.0)';

// FX conversion uses the project-shared rate cache — Redis
// `shared:fx-rates:v1` (4h TTL, live Yahoo Finance source) with a static
// fallback table (`SHARED_FX_FALLBACKS`) that already carries every
// currency we can plausibly see in an SWF infobox (USD, SGD, NOK, EUR,
// GBP, AED, SAR, QAR, KWD, …). See scripts/_seed-utils.mjs and
// scripts/seed-grocery-basket.mjs / scripts/seed-fuel-prices.mjs for
// the consumer pattern. Small FX drift is absorbed by the saturating
// transform in the scorer (100 × (1 − exp(−effectiveMonths / 12))), so
// the shared cache's cadence suffices.
//
// Yahoo symbol convention: `<CCY>USD=X` returns the per-1-local-unit
// value in USD. We build the symbol map dynamically from any currency
// the infobox parser surfaces.

// Canonical currency code lookup keyed on the symbol / short-code that
// appears in Wikipedia infoboxes. Each entry maps to an ISO-4217 code
// used in FX_TO_USD above. Order matters — "US$" must be tested before
// "S$" and "$" so a "US$ 100B" row doesn't match the SGD / USD-fallback
// paths; `detectCurrency` below handles this by scanning longest-first.
const CURRENCY_SYMBOL_TO_ISO = [
  ['US$', 'USD'],
  ['USD', 'USD'],
  ['S$', 'SGD'],
  ['SGD', 'SGD'],
  ['NOK', 'NOK'],
  ['kr', 'NOK'],  // Norwegian krone — weak signal, only used when
                   // preceded by a space and no other symbol matches
  ['€', 'EUR'],
  ['EUR', 'EUR'],
  ['£', 'GBP'],
  ['GBP', 'GBP'],
  ['AED', 'AED'],
  ['SAR', 'SAR'],
  ['KWD', 'KWD'],
  ['QAR', 'QAR'],
  ['$', 'USD'],  // Bare `$` defaults to USD — last to avoid shadowing
                 // `US$` / `S$` / etc.
];

// ── World Bank: per-country annual imports (denominator for rawMonths) ──

// MRV lookback used in the bulk fetch. WB's `country/all?mrv=1` returns the
// SAME year across every country (the most recent year that any country
// reports) with `value: null` for countries that haven't published yet.
// KW/QA/AE report NE.IMP.GNFS.CD a year or two behind NO/SA/SG, so mrv=1
// returned null for them in the 2026-04-23 prod run (PR #3352 root cause).
// mrv=5 gives 5 years and lets us pick the most recent non-null per
// country, matching what the per-country endpoint returns naturally.
// Five years is deliberate — one is clearly insufficient, ten is overkill
// for a denominator that evolves on a yearly cadence (we also report back
// the year we picked, so the scorer can flag stale ones if it wants).
const IMPORTS_LOOKBACK_YEARS = 5;

/**
 * Collapse a WB multi-year bulk response into a per-country map keyed on
 * most-recent-non-null value. Exported so the mrv=5 + pick-latest logic
 * is unit-testable without mocking fetch.
 *
 * @param {Array<{ countryiso3code?: string, country?: { id?: string }, value: unknown, date: unknown }>} records
 * @returns {Record<string, { importsUsd: number, year: number }>}
 */
export function pickLatestPerCountry(records) {
  const imports = {};
  for (const record of records) {
    const rawCode = record?.countryiso3code ?? record?.country?.id ?? '';
    const iso2 = rawCode.length === 3 ? (iso3ToIso2[rawCode] ?? null) : (rawCode.length === 2 ? rawCode : null);
    if (!iso2) continue;
    // Defense-in-depth: explicit null-skip BEFORE Number() coercion.
    // Number(null) === 0 (not NaN). Today the `value <= 0` filter below
    // accidentally catches that (annual imports must be > 0), but the
    // protection is fragile — any future copy-paste of this picker for
    // an indicator where 0 is legitimate (e.g. % of GDP, % share) would
    // silently break. Per memory `feedback_wb_bulk_mrv1_null_coverage_trap`
    // and the compound-bug case study in PR #3427.
    if (record?.value == null) continue;
    const value = Number(record.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    const year = Number(record?.date);
    if (!Number.isFinite(year)) continue;
    const existing = imports[iso2];
    if (!existing || year > existing.year) {
      imports[iso2] = { importsUsd: value, year };
    }
  }
  return imports;
}

async function fetchAnnualImportsUsd() {
  const pages = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const url = `${WB_BASE}/country/all/indicator/${IMPORTS_INDICATOR}?format=json&per_page=2000&page=${page}&mrv=${IMPORTS_LOOKBACK_YEARS}`;
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
  return pickLatestPerCountry(pages);
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

// Depth-aware extraction of the first `<table class="wikitable...">`
// content. A simple lazy `[\s\S]*?</table>` would stop at the FIRST
// `</table>` encountered — but Wikipedia occasionally embeds mini-
// tables inside a row (sort helpers, footnote boxes). With a lazy
// match, any nested `</table>` before the real close silently drops
// all trailing rows. Walk the tag stream and close at matched depth.
function extractFirstWikitable(html) {
  const openRe = /<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>/g;
  const openMatch = openRe.exec(html);
  if (!openMatch) return null;
  const innerStart = openMatch.index + openMatch[0].length;

  const tagRe = /<(\/?)table\b[^>]*>/g;
  tagRe.lastIndex = innerStart;
  let depth = 1;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(innerStart, m.index);
  }
  return null; // unclosed table — treat as malformed
}

// Recursively remove complete nested `<table>…</table>` blocks from the
// extracted wikitable content before row parsing. Without this pass,
// the lazy row / cell regexes below bind across nested `</tr>` and
// `</td>` tags embedded in a cell's inner table, silently dropping the
// enclosing row. Uses depth tracking so a nested-inside-nested block
// is still removed as one unit.
function stripNestedTables(tableInner) {
  let out = tableInner;
  // Loop because stripping outer nested may reveal deeper ones; each
  // iteration strips the outermost complete <table>…</table>.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const openRe = /<table\b[^>]*>/g;
    const openMatch = openRe.exec(out);
    if (!openMatch) return out;
    const innerStart = openMatch.index + openMatch[0].length;
    const tagRe = /<(\/?)table\b[^>]*>/g;
    tagRe.lastIndex = innerStart;
    let depth = 1;
    let closeEnd = -1;
    let m;
    while ((m = tagRe.exec(out)) !== null) {
      depth += m[1] === '/' ? -1 : 1;
      if (depth === 0) { closeEnd = m.index + m[0].length; break; }
    }
    if (closeEnd === -1) return out; // unclosed nested — stop
    out = out.slice(0, openMatch.index) + out.slice(closeEnd);
  }
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
 * aumYear is null for list-article rows because the article does not
 * publish a per-row data-year annotation; consumers treating aumYear
 * as authoritative freshness must fall back to the infobox path.
 *
 * @param {string} html full article HTML
 * @returns {{ byAbbrev: Map<string, object[]>, byFundName: Map<string, object[]> }}
 */
export function parseWikipediaRankingsTable(html) {
  const rawTbl = extractFirstWikitable(html);
  if (rawTbl == null) throw new Error('Wikipedia article: wikitable not found');
  const tbl = stripNestedTables(rawTbl);

  const byAbbrev = new Map();
  const byFundName = new Map();

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

    // aumYear: null — the list article has no per-row data-year
    // annotation. Reporting the scrape year would mislead freshness
    // auditors (figures are usually prior-period).
    const record = { aum, aumYear: null, fundName, countryName, inceptionYear };

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
  return { aum: hit.aum, aumYear: hit.aumYear, source: 'wikipedia_list' };
}

// ── Tier 3b: per-fund Wikipedia article infobox fallback ──
//
// Some manifest funds (Temasek is the canonical case) are editorially
// excluded from Wikipedia's list article. For those, the fund's own
// Wikipedia article's infobox carries AUM. Infobox layout is relatively
// stable: a `<table class="infobox ...">` with rows of
// `<th>Label</th><td>Value</td>`. We look for rows labelled "Total
// assets" / "Assets under management" / "AUM" / "Net assets" and parse
// the value.

const INFOBOX_AUM_LABELS = [
  /^total\s+assets$/i,
  /^assets\s+under\s+management$/i,
  /^aum$/i,
  /^net\s+assets$/i,
  /^net\s+portfolio\s+value$/i,
];

/**
 * Detect the currency in a Wikipedia infobox value string.
 * Returns an ISO-4217 code (e.g. "SGD") or null if unrecognized.
 * Scans CURRENCY_SYMBOL_TO_ISO in order so longer/more-specific
 * prefixes (US$, S$) match before bare `$` / `kr`.
 */
export function detectCurrency(text) {
  const haystack = String(text || '');
  for (const [symbol, iso] of CURRENCY_SYMBOL_TO_ISO) {
    // `$` / `kr` are short + could false-match in rich text; require
    // either a space before or start-of-string immediately before the
    // token, and a digit (optional space) after.
    if (symbol === '$' || symbol === 'kr') {
      const re = new RegExp(`(^|\\s)${symbol.replace(/[$]/g, '\\$')}\\s*\\d`);
      if (re.test(haystack)) return iso;
      continue;
    }
    if (haystack.includes(symbol)) return iso;
  }
  return null;
}

/**
 * Parse a Wikipedia infobox HTML fragment for an AUM value. Returns
 * the NATIVE-currency value plus its ISO-4217 code so the caller can
 * apply the project-shared FX rates (`getSharedFxRates`) at orchestration
 * time. Returning raw-native avoids duplicating the FX conversion layer
 * already maintained in `scripts/_seed-utils.mjs` for seed-grocery-basket,
 * seed-fuel-prices, seed-bigmac, etc.
 *
 * Returns { valueNative: number, currencyNative: string, aumYear: number }
 * or null if no usable row.
 *
 * Exported pure so a committed fixture can exercise the parsing + currency
 * detection without a live fetch.
 */
export function parseWikipediaArticleInfobox(html) {
  const infoboxMatch = html.match(/<table[^>]*class="[^"]*infobox[^"]*"[^>]*>([\s\S]*?)<\/table>/);
  if (!infoboxMatch) return null;
  const box = infoboxMatch[1];

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(box)) !== null) {
    // Split the row into th (label) + td (value). Either can be missing
    // or out-of-order in edge cases, so use a two-pass extraction.
    const label = (rowMatch[1].match(/<th[^>]*>([\s\S]*?)<\/th>/)?.[1] ?? '');
    const value = (rowMatch[1].match(/<td[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? '');
    const labelText = stripHtmlInline(label);
    if (!INFOBOX_AUM_LABELS.some((re) => re.test(labelText))) continue;

    const valueText = stripHtmlInline(value);
    // Example values:
    //   "S$ 434 billion (2025) 2"
    //   "US$ 1,128 billion"
    //   "€ 500 million"
    //   "NOK 18.7 trillion (2025)"
    const numMatch = valueText.match(/([\d,]+(?:\.\d+)?)\s*(trillion|billion|million)/i);
    if (!numMatch) continue;
    const rawNum = parseFloat(numMatch[1].replace(/,/g, ''));
    if (!Number.isFinite(rawNum) || rawNum <= 0) continue;
    const unit = numMatch[2].toLowerCase();
    const unitMultiplier = unit === 'trillion'
      ? 1_000_000_000_000
      : unit === 'billion'
        ? 1_000_000_000
        : 1_000_000;
    const valueNative = rawNum * unitMultiplier;

    const currencyNative = detectCurrency(valueText) ?? 'USD';

    const yearMatch = valueText.match(/\((\d{4})\)/);
    const aumYear = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

    return { valueNative, currencyNative, aumYear };
  }
  return null;
}

/**
 * Look up the USD-per-unit rate for a currency from the shared FX map.
 * `fxRates` is the object returned by `getSharedFxRates()` (keys are
 * ISO-4217 codes). Falls back to SHARED_FX_FALLBACKS for any currency
 * not in the live map. Returns null if the currency is unknown — the
 * caller should treat that as "cannot convert, skip this fund" rather
 * than silently pretending the value is USD.
 */
export function lookupUsdRate(currency, fxRates) {
  if (currency === 'USD') return 1.0;
  const rate = fxRates?.[currency] ?? SHARED_FX_FALLBACKS[currency];
  return (rate != null && rate > 0) ? rate : null;
}

async function fetchWikipediaInfobox(fund, fxRates) {
  const articleUrl = fund.wikipedia?.articleUrl;
  if (!articleUrl) return null;
  const resp = await fetch(articleUrl, {
    headers: {
      'User-Agent': CHROME_UA,
      'Accept': 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    console.warn(`[seed-sovereign-wealth] ${fund.country}:${fund.fund} infobox fetch HTTP ${resp.status}`);
    return null;
  }
  const html = await resp.text();
  const hit = parseWikipediaArticleInfobox(html);
  if (!hit) return null;
  const usdRate = lookupUsdRate(hit.currencyNative, fxRates);
  if (usdRate == null) {
    console.warn(`[seed-sovereign-wealth] ${fund.country}:${fund.fund} infobox currency ${hit.currencyNative} has no FX rate; skipping`);
    return null;
  }
  return {
    aum: hit.valueNative * usdRate,
    aumYear: hit.aumYear,
    source: 'wikipedia_infobox',
    currencyNative: hit.currencyNative,
    fxRate: usdRate,
  };
}

// ── Aggregation ──

/**
 * Pure predicate: should this manifest fund be SKIPPED from the
 * SWF buffer calculation? Returns the skip reason string or null.
 *
 * Two skip conditions (Phase 1 §schema):
 *   - `excluded_overlaps_with_reserves: true` — AUM already counted
 *     in central-bank FX reserves (SAFE-IC, HKMA-EF). Excluding
 *     prevents double-counting against reserveAdequacy /
 *     liquidReserveAdequacy.
 *   - `aum_verified: false` — fund AUM not primary-source-confirmed.
 *     Loaded for documentation; excluded from scoring per the
 *     data-integrity rule (Codex Round 1 #7).
 *
 * Pure function — exported for tests.
 *
 * @param {{ classification?: { excludedOverlapsWithReserves?: boolean }, aumVerified?: boolean }} fund
 * @returns {'excluded_overlaps_with_reserves' | 'aum_unverified' | null}
 */
export function shouldSkipFundForBuffer(fund) {
  if (fund?.classification?.excludedOverlapsWithReserves === true) {
    return 'excluded_overlaps_with_reserves';
  }
  if (fund?.aumVerified === false) {
    return 'aum_unverified';
  }
  return null;
}

/**
 * Pure helper: apply the `aum_pct_of_audited` multiplier to a
 * resolved AUM value. When the fund's classification has no
 * `aum_pct_of_audited`, returns the AUM unchanged.
 *
 * Used for fund-of-funds split entries (e.g. KIA-GRF is ~5% of the
 * audited KIA total; KIA-FGF is ~95%).
 *
 * Pure function — exported for tests.
 *
 * @param {number} resolvedAumUsd
 * @param {{ classification?: { aumPctOfAudited?: number } }} fund
 * @returns {number}
 */
export function applyAumPctOfAudited(resolvedAumUsd, fund) {
  const pct = fund?.classification?.aumPctOfAudited;
  if (typeof pct === 'number' && pct > 0 && pct <= 1) {
    return resolvedAumUsd * pct;
  }
  return resolvedAumUsd;
}

async function fetchFundAum(fund, wikipediaCache, fxRates) {
  // Source priority: official → IFSWF → Wikipedia list → Wikipedia
  // per-fund infobox. Short-circuit on first non-null return so the
  // highest-confidence source wins. The infobox sub-tier is last
  // because it is per-fund fetch (N network round-trips, one per fund
  // that misses the list article) — amortizing over the list article
  // cache first minimizes live traffic.
  const official = await fetchOfficialDisclosure(fund);
  if (official) return official;
  const ifswf = await fetchIfswfFiling(fund);
  if (ifswf) return ifswf;
  const wikipediaList = await fetchWikipediaRanking(fund, wikipediaCache);
  if (wikipediaList) return wikipediaList;
  const wikipediaInfobox = await fetchWikipediaInfobox(fund, fxRates);
  if (wikipediaInfobox) return wikipediaInfobox;
  return null;
}

// Build the fxSymbols map getSharedFxRates expects. We request every
// currency the infobox parser can reasonably surface — this is a
// superset of what any single seed run will need, but it keeps the
// shared Redis FX cache warm for other seeders and costs one Yahoo
// fetch per uncached ccy. The set matches CURRENCY_SYMBOL_TO_ISO.
function buildFxSymbolsForSwf() {
  const ccys = new Set(CURRENCY_SYMBOL_TO_ISO.map(([, iso]) => iso));
  const symbols = {};
  for (const ccy of ccys) {
    if (ccy === 'USD') continue;
    symbols[ccy] = `${ccy}USD=X`;
  }
  return symbols;
}

/**
 * Net-imports denominator transformation for the SWF rawMonths
 * calculation.
 *
 *   netImports = grossImports × (1 − reexportShareOfImports)
 *
 * For countries without a re-export adjustment (reexportShareOfImports = 0),
 * netImports === grossImports — status-quo behaviour.
 *
 * For re-export hubs, the fraction of gross imports that flows through
 * as re-exports does not represent domestic consumption, so the SWF's
 * "months of imports covered" should be measured against the RESIDUAL
 * import stream that actually settles.
 *
 * Exported for unit tests that pin the denominator math independently
 * of live-API fixtures.
 *
 * @param {number} grossImportsUsd  Total annual imports in USD (WB NE.IMP.GNFS.CD)
 * @param {number} reexportShareOfImports  0..1 inclusive; 0 = no adjustment
 * @returns {number} Net annual imports in USD
 */
export function computeNetImports(grossImportsUsd, reexportShareOfImports) {
  if (!Number.isFinite(grossImportsUsd) || grossImportsUsd <= 0) {
    throw new Error(`computeNetImports: grossImportsUsd must be positive finite, got ${grossImportsUsd}`);
  }
  const share = Number.isFinite(reexportShareOfImports) ? reexportShareOfImports : 0;
  if (share < 0 || share >= 1) {
    throw new Error(`computeNetImports: reexportShareOfImports must be in [0, 1), got ${share}`);
  }
  return grossImportsUsd * (1 - share);
}

export async function fetchSovereignWealth() {
  const manifest = loadSwfManifest();
  // Re-export share: per-country fraction of gross imports that flow
  // through as re-exports without settling as domestic consumption.
  // Sourced from Comtrade via the sibling Reexport-Share seeder that
  // runs immediately before this one inside the resilience-recovery
  // bundle. loadReexportShareFromRedis() enforces bundle-run freshness
  // — if the sibling's seed-meta predates this bundle's start, all
  // countries fall back to gross imports (hard fail-safe). Countries
  // not in the returned map get netImports = grossImports (status-quo
  // behaviour). Absence MUST NOT throw or zero the denominator.
  const reexportShareByCountry = await loadReexportShareFromRedis();
  const [imports, wikipediaCache, fxRates] = await Promise.all([
    fetchAnnualImportsUsd(),
    loadWikipediaRankingsCache(),
    getSharedFxRates(buildFxSymbolsForSwf(), SHARED_FX_FALLBACKS),
  ]);

  const countries = {};
  const sourceMix = { official: 0, ifswf: 0, wikipedia_list: 0, wikipedia_infobox: 0 };
  const unmatched = [];
  // Provenance audit for the cohort-sanity report: which countries had a
  // net-imports adjustment applied, and by how much. Keeps the scorer
  // transparent about where denominators diverge from gross imports.
  const reexportAdjustments = [];

  for (const [iso2, funds] of groupFundsByCountry(manifest)) {
    const importsEntry = imports[iso2];
    if (!importsEntry) {
      // WB `NE.IMP.GNFS.CD` missing for this country (transient outage
      // or a country with spotty WB coverage). Silently dropping would
      // let the downstream scorer interpret the absence as "no SWF" and
      // score 0 with full coverage — substantively wrong. Log it
      // loudly and surface via the unmatched list so the seed-meta
      // observer can alert.
      console.warn(`[seed-sovereign-wealth] ${iso2} skipped: World Bank imports (${IMPORTS_INDICATOR}) missing — cannot compute rawMonths denominator`);
      for (const fund of funds) unmatched.push(`${fund.country}:${fund.fund} (no WB imports)`);
      continue;
    }

    // PR 3A net-imports denominator. For re-export hubs (UNCTAD-cited
    // entries in the manifest), replace the gross-imports denominator
    // with net imports via `computeNetImports`. Countries without a
    // manifest entry get grossImports unchanged (share=0 → identity).
    const reexportEntry = reexportShareByCountry.get(iso2);
    const reexportShare = reexportEntry?.reexportShareOfImports ?? 0;
    const denominatorImports = computeNetImports(importsEntry.importsUsd, reexportShare);
    if (reexportShare > 0) {
      reexportAdjustments.push({
        country: iso2,
        grossImportsUsd: importsEntry.importsUsd,
        reexportShareOfImports: reexportShare,
        netImportsUsd: denominatorImports,
        sourceYear: reexportEntry?.year ?? null,
      });
    }

    const fundRecords = [];
    for (const fund of funds) {
      const skipReason = shouldSkipFundForBuffer(fund);
      if (skipReason) {
        console.log(`[seed-sovereign-wealth]   ${fund.country}:${fund.fund} skipped — ${skipReason}`);
        continue;
      }

      // AUM resolution: prefer manifest-provided primary-source AUM
      // when verified; fall back to the existing Wikipedia/IFSWF
      // resolution chain otherwise (existing entries that pre-date
      // the schema extension still work unchanged).
      let aum = null;
      if (fund.aumVerified === true && typeof fund.aumUsd === 'number') {
        aum = { aum: fund.aumUsd, aumYear: fund.aumYear ?? null, source: 'manifest_primary' };
      } else {
        aum = await fetchFundAum(fund, wikipediaCache, fxRates);
      }
      if (!aum) {
        unmatched.push(`${fund.country}:${fund.fund}`);
        continue;
      }

      const adjustedAum = applyAumPctOfAudited(aum.aum, fund);
      const aumPct = fund.classification?.aumPctOfAudited;
      sourceMix[aum.source] = (sourceMix[aum.source] ?? 0) + 1;

      const { access, liquidity, transparency } = fund.classification;
      const rawMonths = (adjustedAum / denominatorImports) * 12;
      const effectiveMonths = rawMonths * access * liquidity * transparency;

      fundRecords.push({
        fund: fund.fund,
        aum: adjustedAum,
        aumYear: aum.aumYear,
        source: aum.source,
        ...(aumPct != null ? { aumPctOfAudited: aumPct } : {}),
        access,
        liquidity,
        transparency,
        rawMonths,
        effectiveMonths,
      });
    }

    if (fundRecords.length === 0) continue;
    const totalEffectiveMonths = fundRecords.reduce((s, f) => s + f.effectiveMonths, 0);
    // Completeness denominator excludes funds that were INTENTIONALLY
    // skipped from buffer scoring (excluded_overlaps_with_reserves OR
    // aum_verified=false). Without this, manifest entries that exist
    // for documentation only would artificially depress completeness
    // for countries with mixed scorable + non-scorable funds — e.g.
    // UAE (4 scorable + EIA unverified) would show completeness=0.8
    // even when every scorable fund matched, and CN (CIC + NSSF
    // scorable + SAFE-IC excluded) would show 0.67.
    //
    // The right denominator is "scorable funds for this country":
    // funds where shouldSkipFundForBuffer returns null. Documentation-
    // only entries are neither matched nor expected; they don't appear
    // in the ratio at all.
    const scorableFunds = funds.filter((f) => shouldSkipFundForBuffer(f) === null);
    const expectedFunds = scorableFunds.length;
    const matchedFunds = fundRecords.length;
    const completeness = expectedFunds > 0 ? matchedFunds / expectedFunds : 0;
    // `completeness` signals partial-seed on multi-fund countries (AE,
    // SG). Downstream scorer must derate the country when completeness
    // < 1.0 — silently emitting partial totalEffectiveMonths would
    // under-rank countries whose secondary fund transiently drifted on
    // Wikipedia. The country stays in the payload (so the scorer can
    // use the partial number for IMPUTE-level coverage), but only
    // completeness=1.0 countries count toward recordCount / health.
    if (completeness < 1.0) {
      console.warn(`[seed-sovereign-wealth] ${iso2} partial: ${matchedFunds}/${expectedFunds} scorable funds matched — completeness=${completeness.toFixed(2)}`);
    }
    countries[iso2] = {
      funds: fundRecords,
      totalEffectiveMonths,
      // `annualImports` preserved for backwards compatibility + audit.
      // `denominatorImports` (post-PR-3A) is the value ACTUALLY used in
      // rawMonths math. For countries without a re-export adjustment
      // the two are identical; for UNCTAD-cited re-export hubs the
      // latter is smaller.
      annualImports: importsEntry.importsUsd,
      denominatorImports,
      reexportShareOfImports: reexportShare,
      expectedFunds,
      matchedFunds,
      completeness,
    };
  }

  if (unmatched.length > 0) {
    console.warn(`[seed-sovereign-wealth] ${unmatched.length} fund(s) unmatched across all tiers: ${unmatched.join(', ')}`);
  }

  const summary = buildCoverageSummary(manifest, imports, countries);
  console.log(`[seed-sovereign-wealth] manifest coverage: ${summary.matchedFunds}/${summary.expectedFunds} funds across ${summary.expectedCountries} countries`);
  for (const row of summary.countryStatuses) {
    const tag = row.status === 'complete' ? 'OK  ' : row.status === 'partial' ? 'PART' : 'MISS';
    const extra = row.reason ? ` — ${row.reason}` : '';
    console.log(`[seed-sovereign-wealth]   ${tag} ${row.country} ${row.matched}/${row.expected}${extra}`);
  }

  if (reexportAdjustments.length > 0) {
    console.log(`[seed-sovereign-wealth] re-export adjustment applied to ${reexportAdjustments.length} country/countries:`);
    for (const adj of reexportAdjustments) {
      console.log(`[seed-sovereign-wealth]   ${adj.country} share=${adj.reexportShareOfImports.toFixed(2)} gross=$${(adj.grossImportsUsd / 1e9).toFixed(1)}B net=$${(adj.netImportsUsd / 1e9).toFixed(1)}B (source year ${adj.sourceYear ?? 'n/a'})`);
    }
  } else {
    console.log(`[seed-sovereign-wealth] re-export manifest is empty; all countries use gross imports as the rawMonths denominator (status-quo behaviour)`);
  }

  const usedWikipedia = sourceMix.wikipedia_list + sourceMix.wikipedia_infobox > 0;
  return {
    countries,
    seededAt: new Date().toISOString(),
    manifestVersion: manifest.manifestVersion,
    sourceMix,
    sourceAttribution: {
      wikipedia: usedWikipedia ? WIKIPEDIA_SOURCE_ATTRIBUTION : undefined,
    },
    summary,
    // PR 3A §net-imports. Published for downstream audit (cohort-
    // sanity release-gate + operator verification). Empty array means
    // the re-export manifest has no entries yet; follow-up PRs populate
    // it with UNCTAD-cited shares per country.
    reexportAdjustments,
  };
}

/**
 * Manifest-vs-seeded coverage summary. Exported so the enumeration logic
 * is unit-testable — previously, a country that failed (no WB imports +
 * no Wikipedia match) disappeared silently unless a log line happened to
 * emit on the specific code path. This function guarantees every
 * manifest country appears with an explicit status and reason.
 *
 * @param {{ funds: Array<{ country: string, fund: string }> }} manifest
 * @param {Record<string, unknown>} imports Per-country import entries from pickLatestPerCountry
 * @param {Record<string, { matchedFunds: number, expectedFunds: number, completeness: number }>} countries Seeded country payload
 */
export function buildCoverageSummary(manifest, imports, countries) {
  // Coverage denominator excludes manifest entries that are
  // documentation-only by design — funds with
  // `excluded_overlaps_with_reserves: true` (SAFE-IC, HKMA-EF) or
  // `aum_verified: false` (EIA). Counting them as "expected" would
  // depress the headline coverage ratio for countries with mixed
  // scorable + non-scorable fund rosters. Same fix as the per-country
  // completeness denominator above; see comment there.
  const scorableManifestFunds = manifest.funds.filter((f) => shouldSkipFundForBuffer(f) === null);
  const expectedFundsTotal = scorableManifestFunds.length;
  const expectedCountries = new Set(scorableManifestFunds.map((f) => f.country));
  let matchedFundsTotal = 0;
  for (const entry of Object.values(countries)) matchedFundsTotal += entry.matchedFunds;
  // Every status carries a `reason` field so downstream consumers that
  // iterate the persisted countryStatuses can safely dereference `.reason`
  // without defensive checks. `complete` and `partial` use `null` to make
  // the shape uniform; `missing` carries a human-readable string naming
  // which upstream the operator should investigate (WB imports vs
  // Wikipedia fund match).
  const countryStatuses = [];
  for (const iso2 of expectedCountries) {
    const entry = countries[iso2];
    if (entry && entry.completeness === 1.0) {
      countryStatuses.push({ country: iso2, status: 'complete', matched: entry.matchedFunds, expected: entry.expectedFunds, reason: null });
    } else if (entry) {
      countryStatuses.push({ country: iso2, status: 'partial', matched: entry.matchedFunds, expected: entry.expectedFunds, reason: null });
    } else {
      const reason = imports[iso2] ? 'no fund AUM matched' : 'missing WB imports';
      countryStatuses.push({
        country: iso2,
        status: 'missing',
        matched: 0,
        expected: countManifestFundsForCountry(manifest, iso2),
        reason,
      });
    }
  }
  countryStatuses.sort((a, b) => a.country.localeCompare(b.country));
  return {
    expectedCountries: expectedCountries.size,
    expectedFunds: expectedFundsTotal,
    matchedCountries: Object.keys(countries).length,
    matchedFunds: matchedFundsTotal,
    countryStatuses,
  };
}

function countManifestFundsForCountry(manifest, iso2) {
  // Counts SCORABLE funds for the given country (excludes documentation-
  // only entries: `excluded_overlaps_with_reserves: true` and
  // `aum_verified: false`). Used by buildCoverageSummary's missing-
  // country path so the "expected" figure on a missing country reflects
  // what the seeder would actually try to score, not all manifest
  // entries.
  let n = 0;
  for (const f of manifest.funds) {
    if (f.country !== iso2) continue;
    if (shouldSkipFundForBuffer(f) !== null) continue;
    n++;
  }
  return n;
}

export function validate(data) {
  // Tier 3 (Wikipedia) is now live; expected floor = 1 country once any
  // manifest fund matches. We keep the floor lenient (>=0) during the
  // first Railway-cron bake-in window so a transient Wikipedia fetch
  // failure does not poison seed-meta for 30 days (see
  // feedback_strict_floor_validate_fail_poisons_seed_meta.md). Once
  // the seeder has ~7 days of clean runs, tighten to `>= 1`.
  //
  // Strict null check: `typeof null === 'object'` is true in JS, so a
  // bare `typeof x === 'object'` would let `{ countries: null }` through
  // and downstream consumers would crash on property access. Accept
  // only a non-null plain object.
  const c = data?.countries;
  return c != null && typeof c === 'object' && !Array.isArray(c);
}

// Health-facing record count. Counts ONLY fully-matched countries
// (completeness === 1.0), so a scraper drift on a secondary fund (e.g.
// Mubadala while ADIA still matches, or Temasek while GIC still matches)
// drops the recordCount seed-health signal — catching the partial-seed
// silent-corruption class that an "any country that has any fund"
// count would miss. Per-country completeness stays in the payload for
// the scorer to derate; recordCount is the operational alarm.
export function declareRecords(data) {
  const countries = data?.countries ?? {};
  let fully = 0;
  for (const entry of Object.values(countries)) {
    if (entry?.completeness === 1.0) fully++;
  }
  return fully;
}

if (process.argv[1]?.endsWith('seed-sovereign-wealth.mjs')) {
  runSeed('resilience', 'recovery:sovereign-wealth', CANONICAL_KEY, fetchSovereignWealth, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL_SECONDS,
    sourceVersion: `swf-manifest-v1-${new Date().getFullYear()}`,
    // Health-facing recordCount delegates to declareRecords so the
    // seed-meta record_count stays consistent with the operational
    // alarm (only countries whose manifest funds all matched count).
    recordCount: declareRecords,
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
