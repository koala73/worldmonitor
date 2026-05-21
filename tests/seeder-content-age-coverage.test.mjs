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

// Seeders that match the heuristic but do NOT wire content-age. Every entry
// needs a concrete STRUCTURAL rationale — these are not "do it later" punts,
// they are seeders where content-age either does not apply or cannot be
// computed without first reshaping the seeder's output. A placeholder is
// rejected by the "no stale EXEMPT entry" test below.
const EXEMPT = {
  'seed-economic-calendar.mjs':
    'Forward-looking release calendar — its payload is UPCOMING economic events, ' +
    'not historical observations. Content-age does not apply; freshness is the ' +
    'seeder run itself (seed-meta liveness).',
  'seed-resilience-static.mjs':
    'Static baseline dataset (per file name and design) — a reference snapshot ' +
    'refreshed infrequently, with no rolling observation date. Content-age does ' +
    'not apply.',
  'seed-climate-zone-normals.mjs':
    'Climatological 30-year normals (WMO 1991–2020 baseline) — a fixed ' +
    'reference dataset recomputed monthly, not a live observation series. ' +
    'Content-age does not apply.',
  'seed-economy.mjs':
    'Composite economic stress score — its `components` carry {id, label, ' +
    'rawValue, score, weight} with NO observation date or year. The published ' +
    'score has no datable newest observation; content-age would require every ' +
    'component fetcher to also surface its source vintage (a seeder-shape ' +
    'change beyond content-age wiring).',
  'seed-national-debt.mjs':
    'The only date signal in the payload (`entries[].baselineTs`) is derived ' +
    'from deriveWeoYear() = max WEO year WITH DATA, which includes y+1 FORECAST ' +
    'vintages — not a historical observation. Correct content-age needs the ' +
    'seeder to first expose a newest non-forecast data year per entry.',
  'seed-wb-indicators.mjs':
    'Hand-rolled main() seeder with no runSeed / writeFreshnessMetadata path — ' +
    'content-age requires its freshness-metadata write path to be established ' +
    'first (a seeder-structure change beyond content-age wiring).',
  'seed-sovereign-wealth.mjs':
    'Per-fund `aumYear` is null for every Wikipedia-list-sourced fund (the list ' +
    'article carries no per-row data-year). Content-age over only the official / ' +
    'IFSWF subset would mislabel the dataset; needs per-fund vintage coverage first.',
};

function listSeeders() {
  return readdirSync(SCRIPTS_DIR).filter((f) => /^seed-.*\.mjs$/.test(f));
}

// A seeder is "wired" if it references the camelCase `maxContentAgeMin` —
// present in the runSeed opt AND in the writeFreshnessMetadata content-age
// trio used by non-runSeed seeders (e.g. seed-ecb-short-rates). The
// SCREAMING_CASE budget consts (IMF_WEO_MAX_CONTENT_AGE_MIN, …) do not match,
// so this only fires on a real opt-in.
function isWired(src) {
  return /maxContentAgeMin/.test(src);
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
