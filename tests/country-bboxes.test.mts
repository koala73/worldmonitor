import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import COUNTRY_BBOXES from '../shared/country-bboxes.js';
import { countryBox, inBox, splitCountryBox } from '../shared/country-bbox.ts';

test('the bbox generator preserves dateline containment and all committed copies', () => {
  const root = new URL('../', import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), 'country-bbox-generator-'));
  try {
    for (const path of ['scripts/shared', 'shared', 'public/data']) mkdirSync(join(dir, path), { recursive: true });
    for (const path of ['scripts/generate-country-bboxes.cjs', 'public/data/countries.geojson']) {
      cpSync(new URL(path, root), join(dir, path));
    }
    execFileSync(process.execPath, [join(dir, 'scripts/generate-country-bboxes.cjs')]);
    for (const path of ['shared/country-bboxes.js', 'shared/country-bboxes.json', 'shared/country-bboxes.d.ts', 'scripts/shared/country-bboxes.json']) {
      assert.equal(readFileSync(join(dir, path), 'utf8'), readFileSync(new URL(path, root), 'utf8'), path);
    }
    const generated = JSON.parse(readFileSync(join(dir, 'shared/country-bboxes.json'), 'utf8'));
    assert.deepEqual(generated.RU, [41.21, 19.6, 81.29, -169.7]);
    assert.deepEqual(generated.AQ, [-90, -180, -64.38, 180], 'polar geometry legitimately covers every longitude');
    assert.deepEqual(Object.entries(generated).filter(([, b]) => (b as number[])[3]! - (b as number[])[1]! >= 360).map(([code]) => code), ['AQ']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every represented Russian vertex fits the wrapped bounds, including both dateline edges', () => {
  const geo = JSON.parse(readFileSync(new URL('../public/data/countries.geojson', import.meta.url), 'utf8'));
  const russia = geo.features.find((f: { properties: Record<string, string> }) => f.properties['ISO3166-1-Alpha-2'] === 'RU');
  const box = countryBox('RU')!;
  // Existing latitude bounds round to the nearest 0.01 degree.
  for (const [lon, lat] of russia.geometry.coordinates.flat(2)) {
    assert.equal(inBox({ ...box, south: box.south - 0.005, north: box.north + 0.005 }, lat, lon), true, `${lat},${lon}`);
  }
  assert.deepEqual(splitCountryBox(box), [
    { south: 41.21, west: 19.6, north: 81.29, east: 180 },
    { south: 41.21, west: -180, north: 81.29, east: -169.7 },
  ]);
  assert.deepEqual(splitCountryBox({ south: 41, west: -180, north: 82, east: 180 }), []);
  assert.deepEqual(splitCountryBox(countryBox('AQ')!), [], 'polar containment must not enable globe-spanning flight queries');
});

test('the source has bounded FJ/NZ/US extents and no Kiribati geometry to invent', () => {
  for (const code of ['FJ', 'NZ', 'US']) {
    const box = countryBox(code)!;
    assert.ok(box && box.west < box.east && box.east - box.west < 180, code);
  }
  assert.equal(COUNTRY_BBOXES.KI, undefined);
  assert.equal(countryBox('KI'), null);
});
