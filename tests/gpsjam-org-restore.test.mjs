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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(repoRoot, p), 'utf8');

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
  test('fetcher pulls gpsjam.org (free, no key) and emits the superset shape', () => {
    const src = read('scripts/fetch-gpsjam.mjs');
    assert.match(src, /BASE_URL = 'https:\/\/gpsjam\.org\/data'/);
    assert.doesNotMatch(src, /WINGBITS_API_KEY|customer-api\.wingbits\.com|x-api-key/, 'Wingbits dependency must be gone');
    // superset: web-UI fields + public-API proto fields on the same hex.
    for (const field of ['pct', 'affectedAircraft', 'totalAircraft', 'npAvg', 'sampleCount', 'aircraftCount']) {
      assert.match(src, new RegExp(`${field}[,:]`), `fetcher hex must carry ${field}`);
    }
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
