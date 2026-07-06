// gpsjam.org restore (2026-07): the GPS-interference layer's source reverted
// from the quota-limited Wingbits API back to the free gpsjam.org daily CSV.
//
// The fetcher emits a SUPERSET hex so BOTH consumer paths keep working with no
// breaking change:
//   - web UI  (api/gpsjam.js → gps-interference.ts → map): the honest gpsjam.org
//     metric — pct + affected/total aircraft.
//   - public API (list-gps-interference.ts + gps_jamming.proto): the stable
//     np_avg/sample_count/aircraft_count contract (no proto regen).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toWebHex } from '../api/gpsjam.js';
import { processHexes } from '../scripts/_gpsjam-parse.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(repoRoot, p), 'utf8');

const CSV_HEADER = 'hex,count_good_aircraft,count_bad_aircraft';
const VALID_H3 = '841f41dffffffff'; // res-4 cell (from live gpsjam.org data)

describe('api/gpsjam.js toWebHex — normalizes every stored shape to the web-UI shape', () => {
  test('new gpsjam.org v2 hex passes pct/affected/total through', () => {
    const h = toWebHex({ h3: 'a', lat: 1, lon: 2, level: 'high', region: 'levant', pct: 15.3, affectedAircraft: 5, totalAircraft: 30, npAvg: 0.3, sampleCount: 5, aircraftCount: 30 });
    assert.deepEqual(h, { h3: 'a', lat: 1, lon: 2, level: 'high', region: 'levant', pct: 15.3, affectedAircraft: 5, totalAircraft: 30 });
  });

  test('legacy Wingbits v2 hex (npAvg, no pct) is converted during the transition window', () => {
    const h = toWebHex({ h3: 'b', lat: 1, lon: 2, level: 'high', region: 'other', npAvg: 0.3, sampleCount: 7, aircraftCount: 40 });
    assert.equal(h.pct, 15, 'npAvg<=0.5 → high bucket pct');
    assert.equal(h.affectedAircraft, 7, 'sampleCount → affectedAircraft');
    assert.equal(h.totalAircraft, 40, 'aircraftCount → totalAircraft');
  });

  test('v1 dual-write hex (good/bad/total) maps bad→affected, total→total', () => {
    const h = toWebHex({ h3: 'c', lat: 1, lon: 2, level: 'medium', region: 'ukraine-russia', pct: 8, good: 20, bad: 4, total: 24 });
    assert.equal(h.pct, 8);
    assert.equal(h.affectedAircraft, 4);
    assert.equal(h.totalAircraft, 24);
  });
});

describe('gpsjam.org restore — source wiring guards', () => {
  test('fetcher pulls gpsjam.org (free, no key)', () => {
    const src = read('scripts/fetch-gpsjam.mjs');
    assert.match(src, /BASE_URL = 'https:\/\/gpsjam\.org\/data'/);
    assert.doesNotMatch(src, /WINGBITS_API_KEY|customer-api\.wingbits\.com|x-api-key/, 'Wingbits dependency must be gone');
  });

  test('fetcher preserves last-good on failure (extendExistingTtl + exit 0), no fetchedAt refresh', () => {
    const src = read('scripts/fetch-gpsjam.mjs');
    assert.match(src, /extendExistingTtl\(\[REDIS_KEY_V2, REDIS_KEY_V1, 'seed-meta:intelligence:gpsjam'\]/);
    assert.match(src, /process\.exit\(0\)/);
  });

  test('web UI reads the gpsjam.org metric (pct), not npAvg', () => {
    assert.match(read('src/services/gps-interference.ts'), /pct: number;[\s\S]*affectedAircraft: number;[\s\S]*totalAircraft: number;/);
    assert.doesNotMatch(read('src/services/gps-interference.ts'), /npAvg/);
    assert.match(read('src/components/MapPopup.ts'), /Number\(data\.pct\)\.toFixed\(1\)/);
  });

  test('public proto API contract is unchanged (still reads npAvg / np_avg)', () => {
    assert.match(read('server/worldmonitor/intelligence/v1/list-gps-interference.ts'), /npAvg: toNumber\(hex\.npAvg\)/);
    assert.match(read('proto/worldmonitor/intelligence/v1/gps_jamming.proto'), /double np_avg = 5/);
  });
});

describe('gpsjam.org CSV parser (_gpsjam-parse.mjs)', () => {
  test('parses a row into the superset hex shape + classifies level by pct', () => {
    const csv = [
      CSV_HEADER,
      `${VALID_H3},0,10`, // 100% bad → high
      `${VALID_H3},1,1`,  // total 2 < minAircraft(3) → skipped low-sample
    ].join('\n');
    const { results, skippedLowSample } = processHexes(csv, 3);
    assert.equal(results.length, 1);
    assert.equal(skippedLowSample, 1);
    const h = results[0];
    // web-UI fields + public-API proto fields on the same hex.
    assert.deepEqual(
      { pct: h.pct, affectedAircraft: h.affectedAircraft, totalAircraft: h.totalAircraft, npAvg: h.npAvg, sampleCount: h.sampleCount, aircraftCount: h.aircraftCount, level: h.level },
      { pct: 100, affectedAircraft: 10, totalAircraft: 10, npAvg: 0.3, sampleCount: 10, aircraftCount: 10, level: 'high' },
    );
    assert.equal(typeof h.lat, 'number');
    assert.equal(typeof h.region, 'string');
  });

  test('coalesces an invalid minAircraft (NaN) to the default so the low-sample filter stays active', () => {
    const csv = [
      CSV_HEADER,
      `${VALID_H3},0,10`, // total 10 → high, kept
      `${VALID_H3},1,1`,  // total 2 → would leak in if the threshold were NaN
    ].join('\n');
    const { results, skippedLowSample } = processHexes(csv, NaN);
    assert.equal(skippedLowSample, 1, 'total-2 row must still be dropped under the default-3 threshold');
    assert.equal(results.length, 1);
  });

  test('drops <2% interference rows and rows below minAircraft', () => {
    const csv = [
      CSV_HEADER,
      `${VALID_H3},99,1`,  // 1% → below 2% → skipped low-interference
      `${VALID_H3},95,5`,  // 5% → medium
    ].join('\n');
    const { results, skippedLow } = processHexes(csv, 3);
    assert.equal(skippedLow, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].level, 'medium');
  });

  // Regression for the ce-code-review #4987 P2 finding: the h3-conversion abort
  // guard must use ATTEMPTED conversions as the denominator, not all CSV rows.
  // Here every attempted hex has an invalid H3, padded by many rows that never
  // attempt conversion — the old `> (lines.length-1) * 0.5` guard would never
  // trip; the `> h3Attempts * 0.5` guard must.
  test('aborts when a majority of ATTEMPTED h3 conversions fail (not vs all rows)', () => {
    const rows = [CSV_HEADER];
    for (let i = 0; i < 3; i++) rows.push(`not-a-valid-h3-${i},0,10`); // high, attempts h3, fails
    for (let i = 0; i < 50; i++) rows.push(`${VALID_H3},99,1`);        // 1% → never attempts h3
    assert.throws(() => processHexes(rows.join('\n'), 3), /attempted hexes failed h3 conversion \(3\/3\)/);
  });

  test('does NOT abort when failures are a minority of attempts', () => {
    const rows = [CSV_HEADER, `bad-h3,0,10`]; // 1 attempt, fails
    for (let i = 0; i < 4; i++) rows.push(`${VALID_H3},0,10`); // 4 attempts succeed
    const { results } = processHexes(rows.join('\n'), 3);
    assert.equal(results.length, 4); // 1/5 failure < 50% → no abort
  });
});
