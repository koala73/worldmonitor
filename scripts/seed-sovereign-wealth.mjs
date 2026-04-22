#!/usr/bin/env node
//
// Seeder — Sovereign Wealth Fund AUM (for the `sovereignFiscalBuffer`
// resilience dimension, PR 2 §3.4).
//
// STATUS: SCAFFOLDING. The fetch pipeline is structured but the three
// data-source tiers are stubs. Wiring the actual scraper is a follow-
// up commit after external-reviewer sign-off on
// `docs/methodology/swf-classification-manifest.yaml`.
//
// Source priority (per plan §3.4):
//   1. Official fund disclosures (MoF, central bank, fund annual reports)
//      — hand-curated endpoint map per fund. Highest confidence.
//   2. IFSWF member-fund filings — Santiago-principle compliant funds
//      publish audited AUM via IFSWF secretariat.
//   3. SWFI public fund-rankings page — LICENSE-FREE fallback; scraped
//      from https://www.swfinstitute.org/fund-rankings/sovereign-wealth-fund
//      with the transparency haircut already baked into the manifest's
//      transparency classification (SWFI-sourced entries naturally score
//      lower there). Respects robots.txt + gentle rate limiting.
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
//             source: 'official' | 'ifswf' | 'swfi',
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
//     sourceMix: { official: <count>, ifswf: <count>, swfi: <count> },
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

// Polite-fetch budget for the SWFI scrape tier. SWFI's fund-rankings
// table is a single paginated page (~10 requests max) so a global
// interval suffices — no need for per-fund concurrency control.
const SWFI_MIN_REQUEST_INTERVAL_MS = 2500;

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
// Not implemented in this commit. Each fund's annual-report / press-
// release page has a different structure; the scrape logic must be
// bespoke per fund. This is the highest-confidence tier and will be
// filled in incrementally in follow-up commits as each fund's disclosure
// path is validated by the external reviewer.
//
// Returns { aum: number, aumYear: number, source: 'official' } or null.
async function fetchOfficialDisclosure(_fund) {
  return null; // TODO: per-fund curated endpoints
}

// ── Tier 2: IFSWF secretariat filings ──
//
// IFSWF publishes member-fund AUM at
// https://www.ifswf.org/member-profiles/<slug> but the data layout is
// HTML-only and varies per fund. Deferred to a follow-up commit.
//
// Returns { aum: number, aumYear: number, source: 'ifswf' } or null.
async function fetchIfswfFiling(_fund) {
  return null; // TODO: member-profile scraper
}

// ── Tier 3: SWFI public fund-rankings page ──
//
// Planned scrape target:
//   https://www.swfinstitute.org/fund-rankings/sovereign-wealth-fund
//
// The page is a paginated HTML table listing fund name, country, rank,
// AUM (in $B), inception year, and region. SWFI's TOS permits non-
// commercial research use of public ranking data; we include a SWFI
// attribution string in the seed-meta `source` field and respect a
// 2.5s inter-request delay (see SWFI_MIN_REQUEST_INTERVAL_MS).
//
// Implementation deferred to the next commit. This stub returns null
// so the seeder currently publishes an empty payload (which the
// scorer must treat as "dimension data not yet available" — see
// `sovereignFiscalBuffer` scorer IMPUTE fallback, landing in a
// follow-up commit).
//
// Returns { aum: number, aumYear: number, source: 'swfi' } or null.
async function fetchSwfiRanking(_fund, _rankingsCache) {
  return null; // TODO: parse SWFI fund-rankings HTML table
}

// Cached fetch of the SWFI rankings page so N funds share a single
// round-trip per seeder run. Stubbed for now.
async function loadSwfiRankingsCache() {
  // TODO: fetch https://www.swfinstitute.org/fund-rankings/sovereign-wealth-fund
  //       parse HTML table → Map<normalized-fund-name, { aum, year }>
  //       respect SWFI_MIN_REQUEST_INTERVAL_MS between paginated requests
  return new Map();
}

// ── Aggregation ──

async function fetchFundAum(fund, swfiCache) {
  // Source priority: official → IFSWF → SWFI. Short-circuit on first
  // non-null return so the highest-confidence source wins.
  const official = await fetchOfficialDisclosure(fund);
  if (official) return official;
  const ifswf = await fetchIfswfFiling(fund);
  if (ifswf) return ifswf;
  const swfi = await fetchSwfiRanking(fund, swfiCache);
  if (swfi) return swfi;
  return null;
}

export async function fetchSovereignWealth() {
  const manifest = loadSwfManifest();
  const [imports, swfiCache] = await Promise.all([
    fetchAnnualImportsUsd(),
    loadSwfiRankingsCache(),
  ]);

  const countries = {};
  const sourceMix = { official: 0, ifswf: 0, swfi: 0 };

  for (const [iso2, funds] of groupFundsByCountry(manifest)) {
    const importsEntry = imports[iso2];
    if (!importsEntry) continue;

    const fundRecords = [];
    for (const fund of funds) {
      const aum = await fetchFundAum(fund, swfiCache);
      if (!aum) continue;
      sourceMix[aum.source] = (sourceMix[aum.source] ?? 0) + 1;

      const { access, liquidity, transparency } = fund.classification;
      const rawMonths = (aum.aum / importsEntry.importsUsd) * 12;
      const effectiveMonths = rawMonths * access * liquidity * transparency;

      fundRecords.push({
        fund: fund.fund,
        aum: aum.aum,
        aumYear: aum.aumYear,
        source: aum.source,
        access, liquidity, transparency,
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

  return {
    countries,
    seededAt: new Date().toISOString(),
    manifestVersion: manifest.manifestVersion,
    sourceMix,
  };
}

function validate(data) {
  // During scaffolding, the three source tiers are stubbed and return
  // null — the seeder correctly publishes a well-formed empty payload.
  // Once any tier is wired, the floor below should tighten (to at
  // least the 8 manifest-listed funds). Treating `emptyDataIsFailure`
  // as false here, otherwise the bootstrap health gate would flag the
  // pre-wiring cron runs as STALE_SEED and poison seed-meta for 30 days
  // (see feedback_strict_floor_validate_fail_poisons_seed_meta.md).
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
    // Pre-wiring: empty payload is EXPECTED until the source tiers
    // are implemented. Do NOT treat emptyData as failure; see the
    // comment on `validate` above.
    emptyDataIsFailure: false,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
