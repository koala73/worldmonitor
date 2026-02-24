import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const geojson = JSON.parse(readFileSync(resolve(__dirname, '../public/data/countries.geojson'), 'utf-8'));
const features = geojson.features;

describe('countries.geojson data integrity', () => {
  it('all feature names are unique', () => {
    const names = features.map(f => f.properties.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepStrictEqual(dupes, [], `Duplicate names found: ${dupes.join(', ')}`);
  });

  it('major countries have correct ISO codes', () => {
    const expected = {
      France: { a2: 'FR', a3: 'FRA' },
      Norway: { a2: 'NO', a3: 'NOR' },
      Kosovo: { a2: 'XK', a3: 'XKX' },
      Germany: { a2: 'DE', a3: 'DEU' },
      'United States of America': { a2: 'US', a3: 'USA' },
      'United Kingdom': { a2: 'GB', a3: 'GBR' },
      Japan: { a2: 'JP', a3: 'JPN' },
      China: { a2: 'CN', a3: 'CHN' },
      Brazil: { a2: 'BR', a3: 'BRA' },
      India: { a2: 'IN', a3: 'IND' },
    };

    for (const [name, codes] of Object.entries(expected)) {
      const feat = features.find(f => f.properties.name === name);
      assert.ok(feat, `${name} not found in GeoJSON`);
      assert.equal(feat.properties['ISO3166-1-Alpha-2'], codes.a2, `${name} Alpha-2 should be ${codes.a2}`);
      assert.equal(feat.properties['ISO3166-1-Alpha-3'], codes.a3, `${name} Alpha-3 should be ${codes.a3}`);
    }
  });

  it('no major country has -99 ISO code', () => {
    const majorCountries = [
      'France', 'Norway', 'Kosovo', 'Germany', 'United States of America',
      'United Kingdom', 'Japan', 'China', 'Brazil', 'India', 'Canada',
      'Australia', 'Russia', 'Italy', 'Spain', 'South Korea', 'Mexico',
      'Turkey', 'Saudi Arabia', 'Israel', 'Ukraine', 'Poland', 'Iran',
    ];

    for (const name of majorCountries) {
      const feat = features.find(f => f.properties.name === name);
      if (!feat) continue;
      assert.notEqual(feat.properties['ISO3166-1-Alpha-2'], '-99', `${name} should not have -99 Alpha-2`);
      assert.notEqual(feat.properties['ISO3166-1-Alpha-3'], '-99', `${name} should not have -99 Alpha-3`);
    }
  });

  it('-99 count stays bounded (max 25)', () => {
    const minus99 = features.filter(f => f.properties['ISO3166-1-Alpha-2'] === '-99');
    assert.ok(minus99.length <= 25, `Expected <=25 features with -99, got ${minus99.length}: ${minus99.map(f => f.properties.name).join(', ')}`);
    assert.ok(minus99.length > 0, 'Expected some -99 features for unrecognized territories');
  });
});
