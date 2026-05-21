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

// Heuristic for "freeze-prone time-series seeder": fetches a windowed slice of
// an upstream time series from a source that revises / retires series. ECB
// SDMX (data-api.ecb.europa.eu) is the exact family that froze in #3845; BIS
// (stats.bis.org) is the same shape; `lastNObservations=` is the SDMX windowed-
// fetch query parameter that marks a fixed-window time-series pull.
const FREEZE_PRONE_MARKERS = [
  /data-api\.ecb\.europa\.eu/,
  /stats\.bis\.org/,
  /lastNObservations=/,
];

// Seeders that match the heuristic but intentionally do NOT wire content-age.
// Every entry needs a concrete rationale — a placeholder is rejected by the
// "no stale EXEMPT entry" test below.
const EXEMPT = {
  'seed-ecb-short-rates.mjs':
    'Multi-frequency aggregate (daily €STR + monthly EURIBOR 3M/6M/1Y) writing ' +
    'four separate FRED-format keys via a hand-rolled main() with no runSeed / ' +
    'canonical key. A single maxContentAgeMin cannot model per-series freshness; ' +
    'per-series content-age tracking is a #3845 follow-up. Seeder liveness ' +
    '(seed-meta:economic:ecb-short-rates) still alerts on a stopped cron.',
  'seed-bis-extended.mjs':
    'Quarterly BIS multi-series seeder (DSR / SPP / CPP) that fans out to ' +
    'several afterPublish sub-keys. Correct content-age needs a per-series-aware ' +
    'contentMeta across those sub-keys; tracked as a #3845 follow-up. Seeder ' +
    'liveness (maxStaleMin) still alerts on a stopped cron.',
  'seed-bis-data.mjs':
    'Quarterly BIS multi-series seeder (policy / exchange / credit) with the ' +
    'same multi-key afterPublish shape as seed-bis-extended; same follow-up. ' +
    'Seeder liveness (maxStaleMin) still alerts on a stopped cron.',
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
