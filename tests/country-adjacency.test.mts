import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  COUNTRY_ADJACENCY,
  LAND_BORDER_PAIRS,
  SEA_NEIGHBOUR_PAIRS,
  neighboursOf,
} from '../shared/country-adjacency.ts';

const VALID = new Set(Object.keys(JSON.parse(readFileSync(new URL('../shared/iso2-to-iso3.json', import.meta.url), 'utf8'))));
const pairKey = (a: string, b: string) => [a, b].sort().join('-');
const landNeighbours = (code: string) => LAND_BORDER_PAIRS
  .filter(([a, b]) => a === code || b === code)
  .map(([a, b]) => (a === code ? b : a))
  .sort();

test('every code in the pair lists and the derived table is a known ISO2', () => {
  for (const [a, b] of [...LAND_BORDER_PAIRS, ...SEA_NEIGHBOUR_PAIRS]) {
    assert.ok(VALID.has(a), `unknown code ${a}`);
    assert.ok(VALID.has(b), `unknown code ${b}`);
  }
  for (const [code, list] of Object.entries(COUNTRY_ADJACENCY)) {
    assert.ok(VALID.has(code), `unknown key ${code}`);
    for (const n of list) assert.ok(VALID.has(n), `unknown neighbour ${n} of ${code}`);
  }
  assert.ok(!('AQ' in COUNTRY_ADJACENCY));
});

test('table is symmetric, sorted, deduped and has no self-pairs', () => {
  for (const [code, list] of Object.entries(COUNTRY_ADJACENCY)) {
    assert.ok(!list.includes(code), `${code} lists itself`);
    assert.deepEqual([...list], [...new Set(list)].sort(), `${code} not sorted/unique`);
    for (const n of list) assert.ok(COUNTRY_ADJACENCY[n]?.includes(code), `${code}-${n} not symmetric`);
  }
  assert.ok(Object.isFrozen(COUNTRY_ADJACENCY));
});

test('pair lists hold no duplicates and no pair is both land and sea', () => {
  const land = LAND_BORDER_PAIRS.map(([a, b]) => pairKey(a, b));
  const sea = SEA_NEIGHBOUR_PAIRS.map(([a, b]) => pairKey(a, b));
  assert.equal(new Set(land).size, land.length, 'duplicate land pair');
  assert.equal(new Set(sea).size, sea.length, 'duplicate sea pair');
  for (const [a, b] of [...LAND_BORDER_PAIRS, ...SEA_NEIGHBOUR_PAIRS]) assert.notEqual(a, b);
  const landSet = new Set(land);
  for (const p of sea) assert.ok(!landSet.has(p), `${p} is in both land and sea lists`);
});

test('land border spot checks', () => {
  for (const n of ['KH', 'LA', 'MM', 'MY']) assert.ok(neighboursOf('TH').includes(n), `TH-${n}`);
  for (const n of ['CN', 'KH', 'LA']) assert.ok(neighboursOf('VN').includes(n), `VN-${n}`);
  assert.deepEqual(landNeighbours('ID'), ['MY', 'PG', 'TL']);
  assert.deepEqual(landNeighbours('SG'), []);
  assert.deepEqual(landNeighbours('PT'), ['ES']);
  assert.deepEqual(landNeighbours('DE'), ['AT', 'BE', 'CH', 'CZ', 'DK', 'FR', 'LU', 'NL', 'PL']);
  assert.deepEqual(landNeighbours('ES'), ['AD', 'FR', 'GI', 'MA', 'PT']);
  assert.deepEqual(landNeighbours('FR'), ['AD', 'BE', 'CH', 'DE', 'ES', 'IT', 'LU', 'MC']);
  // 14 sovereign land neighbours, plus the HK and MO special administrative regions.
  assert.equal(landNeighbours('CN').filter((c) => c !== 'HK' && c !== 'MO').length, 14);
  assert.ok(landNeighbours('CN').includes('HK') && landNeighbours('CN').includes('MO'));
  assert.deepEqual(landNeighbours('KR'), ['KP']);
  assert.deepEqual(landNeighbours('XK'), ['AL', 'ME', 'MK', 'RS']);
  assert.deepEqual(landNeighbours('PS'), ['EG', 'IL', 'JO']);
});

test('sea neighbours are included in the derived table', () => {
  assert.deepEqual([...neighboursOf('SG')].sort(), ['ID', 'MY']);
  assert.ok(neighboursOf('MY').includes('PH'));
  assert.ok(neighboursOf('PH').includes('MY'));
  const sea = new Set(SEA_NEIGHBOUR_PAIRS.map(([a, b]) => pairKey(a, b)));
  assert.ok(sea.has('ID-SG'));
  assert.ok(sea.has('MY-PH'));
});

test('neighboursOf is case-insensitive and returns [] for unknown or isolated codes', () => {
  assert.deepEqual(neighboursOf('th'), neighboursOf('TH'));
  assert.deepEqual(neighboursOf('IS'), []);
  assert.deepEqual(neighboursOf('ZZ'), []);
  assert.deepEqual(neighboursOf(''), []);
});
