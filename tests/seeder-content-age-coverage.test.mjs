// Regression guard for the issue-#3845 bug class.
//
// Bug class: an upstream time series FREEZES — keeps returning HTTP 200 with
// the same observations indefinitely — and we serve the frozen value because
// no layer inspects the DATE of the newest observation. Seeder liveness
// (seed-meta.fetchedAt vs maxStaleMin) does not catch it: the cron runs, the
// fetch succeeds, validate() passes. The ECB legacy CISS series (SS_CI) froze
// in May 2025 and the FSI panel served a 12-month-old value for a year.
//
// The fix is the content-age contract — runSeed `contentMeta` + `maxContentAgeMin`
// (see scripts/_content-age-helpers.mjs) — which makes /api/health fire
// STALE_CONTENT. This test ensures every freeze-prone seeder either OPTS IN to
// that contract or is EXEMPT with a written rationale, so a NEW freeze-prone
// seeder cannot ship undetected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

// Heuristic for "freeze-prone time-series seeder": fetches from an official-
// statistics upstream that publishes on a cadence and can revise / retire /
// supersede series. These are the upstreams where a frozen-but-HTTP-200
// response is a real, observed failure mode (ECB did exactly this in #3845).
// Live-quote feeds (Yahoo market data, etc.) are deliberately excluded — a
// frozen live quote is a different risk profile with different detection.
const FREEZE_PRONE_MARKERS = [
  /data-api\.ecb\.europa\.eu/,   // ECB SDMX — froze in #3845
  /stats\.bis\.org/,             // BIS
  /api\.stlouisfed\.org/,        // FRED
  /\bfredFetchJson\b/,           // FRED (helper)
  /api\.imf\.org/,               // IMF SDMX
  /\bimfSdmxFetchIndicator\b/,   // IMF SDMX (helper)
  /api\.worldbank\.org/,         // World Bank
  /open-meteo-archive/,          // Open-Meteo ERA5 archive
  /lastNObservations=/,          // SDMX windowed-fetch query param
];

// Seeders that match the heuristic but intentionally do NOT wire content-age.
// Every entry needs a concrete rationale — a placeholder is rejected by the
// "no stale EXEMPT entry" test below. Two kinds of rationale:
//   - "content-age does not apply" — the payload has no newest-observation
//     semantics (forward-looking calendars, static baselines, normals).
//   - "tracked #3845 follow-up" — content-age IS applicable but the payload
//     shape needs a bespoke extractor (multi-series, multi-key, composite
//     scores, WEO forecast-year horizons). Seeder liveness still covers a
//     stopped cron in the meantime.
const EXEMPT = {
  'seed-ecb-short-rates.mjs':
    'Multi-frequency aggregate (daily €STR + monthly EURIBOR 3M/6M/1Y) writing ' +
    'four separate FRED-format keys via a hand-rolled main() with no runSeed / ' +
    'canonical key. A single maxContentAgeMin cannot model per-series freshness; ' +
    'per-series content-age tracking is a #3845 follow-up.',
  'seed-bis-extended.mjs':
    'Quarterly BIS multi-series seeder (DSR / SPP / CPP) that fans out to ' +
    'several afterPublish sub-keys. Correct content-age needs a per-series-aware ' +
    'contentMeta across those sub-keys; tracked as a #3845 follow-up.',
  'seed-bis-data.mjs':
    'Quarterly BIS multi-series seeder (policy / exchange / credit) with the ' +
    'same multi-key afterPublish shape as seed-bis-extended; same follow-up.',
  'seed-economy.mjs':
    'Composite economic score blended from multiple annual inputs at differing ' +
    'cadences. The published score has no single observation date; correct ' +
    'content-age needs per-input tracking. Tracked as a #3845 follow-up.',
  'seed-economic-calendar.mjs':
    'Forward-looking release calendar — its payload is UPCOMING economic events, ' +
    'not historical observations. Content-age does not apply; freshness is the ' +
    'seeder run itself (seed-meta liveness).',
  'seed-supply-chain-trade.mjs':
    'Composite supply-chain index blending FRED monthly series with UN Comtrade ' +
    'annual data at different cadences; a single maxContentAgeMin cannot model ' +
    'both. Per-series content-age is a #3845 follow-up.',
  'seed-national-debt.mjs':
    'Per-country annual debt dict sourced partly from IMF WEO, whose `year` can ' +
    'be a FORECAST horizon — the plain country-dict mapping would future-date ' +
    'it. Needs the WEO horizon-aware helper; tracked as a #3845 follow-up.',
  'seed-recovery-fiscal-space.mjs':
    'Per-country annual dict built from IMF WEO inputs (revenue / balance / ' +
    'debt), whose `year` can be a forecast horizon — same WEO future-dating ' +
    'trap as seed-national-debt. Needs the WEO horizon-aware helper; tracked ' +
    'as a #3845 follow-up.',
  'seed-resilience-static.mjs':
    'Static baseline dataset (per file name and design) — a reference snapshot ' +
    'refreshed infrequently, with no rolling observation date. Content-age does ' +
    'not apply.',
  'seed-sovereign-wealth.mjs':
    'Per-fund AUM figures from irregular official disclosures (ministry-of-' +
    'finance / central-bank annual reports) with no uniform observation date ' +
    'across funds. Content-age is ill-defined here; tracked as a #3845 follow-up.',
  'seed-wb-indicators.mjs':
    'Multi-indicator World Bank seeder with a per-indicator latest-year ' +
    'structure rather than the flat {countries:{year}} shape the shared helper ' +
    'expects. Wiring needs a per-indicator extractor; #3845 follow-up.',
  'seed-climate-zone-normals.mjs':
    'Climatological 30-year normals (WMO 1991–2020 baseline) — a fixed ' +
    'reference dataset recomputed monthly, not a live observation series. ' +
    'Content-age does not apply.',
};

function listSeeders() {
  return readdirSync(SCRIPTS_DIR).filter((f) => /^seed-.*\.mjs$/.test(f));
}

function isWired(src) {
  return /contentMeta/.test(src) && /maxContentAgeMin/.test(src);
}

test('every freeze-prone seeder wires content-age detection or is exempt with a rationale', () => {
  const offenders = [];
  for (const file of listSeeders()) {
    const src = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
    if (!FREEZE_PRONE_MARKERS.some((re) => re.test(src))) continue;
    const exempt = typeof EXEMPT[file] === 'string' && EXEMPT[file].trim().length > 40;
    if (!isWired(src) && !exempt) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `Freeze-prone seeder(s) without content-age detection: ${offenders.join(', ')}\n` +
      `Wire runSeed contentMeta + maxContentAgeMin (see scripts/_content-age-helpers.mjs ` +
      `and scripts/seed-fsi-eu.mjs for the pattern), or add an EXEMPT entry with a ` +
      `concrete rationale.`,
  );
});

test('content-age opt-in is complete — contentMeta always paired with maxContentAgeMin', () => {
  // runSeed hard-fails at config time on a half-wire, but only when the seeder
  // actually runs. This static check catches a half-wire in CI instead.
  const halfWired = [];
  for (const file of listSeeders()) {
    const src = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
    if (/contentMeta/.test(src) && !/maxContentAgeMin/.test(src)) halfWired.push(file);
  }
  assert.deepEqual(
    halfWired,
    [],
    `Seeder(s) reference contentMeta without maxContentAgeMin: ${halfWired.join(', ')}`,
  );
});

test('no EXEMPT entry is stale — every entry points at an existing, still-unwired seeder', () => {
  const seeders = new Set(listSeeders());
  for (const [file, reason] of Object.entries(EXEMPT)) {
    assert.ok(seeders.has(file), `EXEMPT lists ${file} but that seeder no longer exists — remove the entry.`);
    const src = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
    assert.ok(!isWired(src), `${file} is now wired for content-age — remove it from EXEMPT.`);
    assert.ok(typeof reason === 'string' && reason.trim().length > 40, `EXEMPT[${file}] needs a real rationale.`);
  }
});
