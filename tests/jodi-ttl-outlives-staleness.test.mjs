// JODI oil/gas data TTL must OUTLIVE the 40-day health STALE_SEED gate, and
// must cover one missed monthly publisher cycle (#7273).
//
// The defect: both seeders wrote a 35-day TTL while /api/health waited 40 days
// before calling the seeder stale, and the energy-sources bundle also throttles
// JODI at 35 days. One missed monthly publish therefore erased the payload at
// day 35 (EMPTY, crit) before health was willing to warn (STALE_SEED).
//
// The co-pin:
//   cadence        35d  (bundle intervalMs)
//   maxStaleMin    40d  (35d cadence + 5d late-publisher grace)
//   data/meta TTL  70d  (2× cadence: last-good survives one missed monthly publish)
//
// Escalation with data still served:
//   day 0–40   OK (or STALE_CONTENT if the upstream file is frozen)
//   day 40–70  STALE_SEED
//   day 70+    EMPTY
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JODI_TTL } from '../scripts/seed-jodi-oil.mjs';
import { GAS_TTL } from '../scripts/seed-jodi-gas.mjs';
import {
  MAX_JODI_CONTENT_AGE_MIN,
  MAX_JODI_GAS_CONTENT_AGE_MIN,
} from '../scripts/shared/jodi-content-age.mjs';
import { monthPeriodEnd } from '../scripts/shared/jodi-demand-change.mjs';
import { __testing__ } from '../api/health.js';
import {
  extractBundleSections,
  resolveExpr,
} from './helpers/bundle-section-parser.mjs';

const { classifyKey, STANDALONE_KEYS, SEED_META } = __testing__;

const DAY_SECONDS = 24 * 3600;
const DAY_MIN = 24 * 60;
const ONE_MIN_MS = 60_000;
const CADENCE_DAYS = 35;
const CADENCE_SECONDS = CADENCE_DAYS * DAY_SECONDS;
const NOW = Date.parse('2026-08-28T00:00:00.000Z');

const CHINA_ROW = {
  ok: false,
  reason: 'china-missing',
  dataMonth: null,
  ageMonths: null,
  unavailableSince: Date.parse('2026-06-01T00:00:00.000Z'),
};

const JODI_CHECKS = [
  { name: 'jodiOil', ttl: JODI_TTL, contentBudget: MAX_JODI_CONTENT_AGE_MIN },
  { name: 'jodiGas', ttl: GAS_TTL, contentBudget: MAX_JODI_GAS_CONTENT_AGE_MIN },
  { name: 'lngVulnerability', ttl: GAS_TTL, contentBudget: MAX_JODI_GAS_CONTENT_AGE_MIN },
];

function classify(name, {
  ageMin,
  present = true,
  newestMonth = '2026-07',
  maxContentAgeMin,
} = {}) {
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;
  const check = JODI_CHECKS.find((row) => row.name === name);
  return classifyKey(name, dataKey, {}, {
    keyStrens: new Map(present ? [[dataKey, 4096]] : []),
    keyErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify({
      fetchedAt: NOW - ageMin * ONE_MIN_MS,
      recordCount: 57,
      newestItemAt: Date.parse(monthPeriodEnd(newestMonth)),
      oldestItemAt: Date.parse(monthPeriodEnd('2024-01')),
      maxContentAgeMin: maxContentAgeMin ?? check.contentBudget,
      chinaRow: CHINA_ROW,
    })]]),
    keyMetaErrors: new Map(),
    now: NOW,
  });
}

function jodiBundleIntervals() {
  const bundleSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'seed-bundle-energy-sources.mjs'),
    'utf8',
  );
  const wanted = new Map([
    ['JODI-Gas', 'seed-jodi-gas.mjs'],
    ['JODI-Oil', 'seed-jodi-oil.mjs'],
  ]);
  const found = [];
  for (const section of extractBundleSections(bundleSrc)) {
    const script = wanted.get(section.label);
    if (script !== section.script) continue;
    found.push({
      label: section.label,
      intervalMs: resolveExpr(bundleSrc, section.intervalMsExpr),
    });
  }
  return found;
}

test('JODI oil, gas, and LNG data TTLs outlive the 40-day STALE_SEED gate', () => {
  for (const { name, ttl } of JODI_CHECKS) {
    const maxStaleSeconds = SEED_META[name].maxStaleMin * 60;
    assert.ok(
      ttl > maxStaleSeconds,
      `${name} TTL (${ttl}s) must exceed health maxStaleMin `
        + `(${SEED_META[name].maxStaleMin}min = ${maxStaleSeconds}s), or the payload `
        + 'expires before STALE_SEED can fire and a late publisher reports EMPTY',
    );
  }
});

test('JODI TTLs cover one missed 35-day publisher cycle', () => {
  // Bundle cadence is 35d. A missed monthly publish means the next successful
  // write is ~70d after the last one. Last-good must still be on the key when
  // health starts warning at 40d, and through that missed cycle.
  assert.ok(
    JODI_TTL >= 2 * CADENCE_SECONDS,
    `JODI_TTL (${JODI_TTL}s) must cover at least two 35-day cadences (${2 * CADENCE_SECONDS}s)`,
  );
  assert.ok(
    GAS_TTL >= 2 * CADENCE_SECONDS,
    `GAS_TTL (${GAS_TTL}s) must cover at least two 35-day cadences (${2 * CADENCE_SECONDS}s)`,
  );
});

test('the energy-sources bundle still throttles both JODI members at 35 days', () => {
  const intervals = jodiBundleIntervals();
  assert.equal(intervals.length, 2, 'expected JODI-Gas and JODI-Oil bundle sections');
  for (const { label, intervalMs } of intervals) {
    assert.equal(
      intervalMs,
      CADENCE_SECONDS * 1000,
      `${label} cadence drifted from the 35-day monthly throttle`,
    );
  }
});

test('oil and gas write seed-meta with the same TTL as the data keys', () => {
  const oilSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'seed-jodi-oil.mjs'),
    'utf8',
  );
  assert.match(
    oilSrc,
    /SET',\s*META_KEY,\s*JSON\.stringify\(metaPayload\),\s*'EX',\s*JODI_TTL/,
    'oil seed-meta must use JODI_TTL, not a shorter default that expires before STALE_SEED',
  );

  const gasSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'seed-jodi-gas.mjs'),
    'utf8',
  );
  assert.match(
    gasSrc,
    /ttlSeconds:\s*GAS_TTL/,
    'gas canonical TTL must stay pinned to GAS_TTL',
  );
  assert.match(
    gasSrc,
    /metaTtlSeconds:\s*GAS_TTL/,
    'gas seed-meta must use GAS_TTL so the heartbeat outlives the 40-day gate',
  );
});

test('the 35–40 day boundary keeps last-good and does not report EMPTY', () => {
  // Day 37: past the 35d cadence, still inside the 40d grace. Data is present
  // because TTL is 70d. Health must not jump to EMPTY.
  const ageMin = 37 * DAY_MIN;
  for (const { name } of JODI_CHECKS) {
    const entry = classify(name, { ageMin });
    assert.equal(
      entry.status,
      'OK',
      `${name} at day 37 (data present, seed inside 40d grace) must stay OK, got ${entry.status}`,
    );
    assert.deepEqual(entry.chinaRow, CHINA_ROW, `${name} must keep the China-row diagnostic`);
  }
});

test('a missed monthly publish reads STALE_SEED while last-good is still served', () => {
  // Day 41: past the 40d gate, well inside the 70d TTL. This is the warning
  // window a 35d TTL made unreachable (payload already gone at day 35).
  const ageMin = 40 * DAY_MIN + 1;
  for (const { name, ttl } of JODI_CHECKS) {
    assert.ok(
      ttl > ageMin * 60,
      `${name} TTL must still hold the payload when STALE_SEED fires`,
    );
    const entry = classify(name, { ageMin });
    assert.equal(
      entry.status,
      'STALE_SEED',
      `${name} at day 40+1min with data present must be STALE_SEED, got ${entry.status}`,
    );
    assert.deepEqual(entry.chinaRow, CHINA_ROW, `${name} must keep the China-row diagnostic`);
  }
});

test('a frozen upstream file still reads STALE_CONTENT when the seeder itself is on time', () => {
  // Content-age is a different clock. Pinning TTL/health must not swallow a
  // frozen JODI file into OK or EMPTY while seed-meta is fresh.
  const frozenMonth = '2025-11';
  for (const { name } of JODI_CHECKS) {
    const entry = classify(name, { ageMin: 60, newestMonth: frozenMonth });
    assert.equal(
      entry.status,
      'STALE_CONTENT',
      `${name} with a frozen file and a fresh seed must stay STALE_CONTENT, got ${entry.status}`,
    );
    assert.deepEqual(entry.chinaRow, CHINA_ROW, `${name} must keep the China-row diagnostic`);
  }
});
