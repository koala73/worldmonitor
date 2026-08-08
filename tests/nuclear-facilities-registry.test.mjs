import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();

function src(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function parseArrayLiteral(source, declarationName) {
  const start = source.indexOf(`const ${declarationName} = [`);
  assert.notEqual(start, -1, `expected ${declarationName} declaration`);

  const arrayStart = source.indexOf('[', start);
  let depth = 0;
  for (let i = arrayStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return Function(`"use strict"; return (${source.slice(arrayStart, i + 1)});`)();
      }
    }
  }

  throw new Error(`unterminated ${declarationName} array`);
}

function parseNuclearFacilities() {
  const source = src('src/config/geo-map.ts');
  const start = source.indexOf('export const NUCLEAR_FACILITIES');
  assert.notEqual(start, -1, 'expected NUCLEAR_FACILITIES export');

  const assignment = source.indexOf('=', start);
  assert.notEqual(assignment, -1, 'expected NUCLEAR_FACILITIES assignment');
  const arrayStart = source.indexOf('[', assignment);
  let depth = 0;
  for (let i = arrayStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return Function(`"use strict"; return (${source.slice(arrayStart, i + 1)});`)();
      }
    }
  }

  throw new Error('unterminated NUCLEAR_FACILITIES array');
}

function lookup(obj, key) {
  return key.split('.').reduce((cur, part) => cur?.[part], obj);
}

function supportedLanguages() {
  const match = src('src/services/i18n.ts').match(/SUPPORTED_LANGUAGES = \[([^\]]+)\]/);
  assert.ok(match, 'expected SUPPORTED_LANGUAGES declaration');
  return Array.from(match[1].matchAll(/'([^']+)'/g), ([, language]) => language);
}

function nuclearTypeLabelKey(type) {
  return type === 'test-site' ? 'testSite' : type;
}

describe('nuclear facility registry invariants', () => {
  it('keeps high-risk site statuses from regressing', () => {
    const byId = new Map(parseNuclearFacilities().map((facility) => [facility.id, facility]));

    assert.equal(byId.get('zaporizhzhia')?.status, 'contested');
    assert.equal(byId.get('chernobyl')?.status, 'decommissioned');
    assert.equal(byId.get('west_valley')?.status, 'decommissioned');
    assert.equal(byId.get('ehemalige_uranerzaufbereitungsanlage_ellweiler')?.status, 'decommissioned');
    assert.equal(byId.get('tianwan')?.status, 'active');
  });

  it('keeps earthquake scoring limited to canonical nuclear-test centroids', () => {
    const seedSites = parseArrayLiteral(src('scripts/seed-earthquakes.mjs'), 'TEST_SITES');
    const seedNames = seedSites.map(({ name }) => name).sort();

    assert.deepEqual(seedNames, [
      'Chagai-II',
      'Fangataufa',
      'In Eker',
      'Lop Nur',
      'Moruroa',
      'Nevada National Security Site',
      'Novaya Zemlya',
      'Pokhran',
      'Punggye-ri Nuclear Test Site',
      'Reggane',
      'Semipalatinsk Test Site',
    ]);

    assert.deepEqual(
      seedNames.filter((name) => ['Sary Shagan', 'Kapustin Yar', 'Totsky shooting range', 'Salmon Site', 'Area 2', 'Degelen'].includes(name)),
      [],
    );

    const registryByName = new Map(parseNuclearFacilities().map((facility) => [facility.name, facility]));
    for (const site of seedSites) {
      assert.ok(registryByName.has(site.name), `${site.name} should stay backed by the nuclear registry`);
    }
  });

  it('deduplicates known stacked nuclear facility markers', () => {
    const facilities = parseNuclearFacilities();
    const byId = new Map(facilities.map((facility) => [facility.id, facility]));

    for (const removedId of ['gentilly_ca', 'marcoule_fr', 'tricastin_fr', 'pierrelatte_fr', 'pierrelatte_3', 'tokai_no', 'tokai_jp']) {
      assert.equal(byId.has(removedId), false, `${removedId} should be folded into a canonical site marker`);
    }

    assert.equal(byId.get('pierrelatte')?.name, 'Pierrelatte nuclear site (Comurhex/FBFC/Orano)');
    assert.equal(byId.get('tokai')?.name, 'Tokai Nuclear Power Site (Tokai-1/Tokai-2)');
    assert.equal(byId.get('kaiga_atomic_power_station')?.name, 'Kaiga Atomic Power Station');
    assert.equal(byId.has('bruce_nuclear_generating_stationc'), false);
    assert.equal(byId.get('bruce_nuclear_generating_station')?.name, 'Bruce Nuclear Generating Station');
  });

  it('styles every nuclear facility status used by the registry', () => {
    const css = src('src/styles/main.css');
    const statuses = Array.from(new Set(parseNuclearFacilities().map((facility) => facility.status))).sort();

    for (const status of statuses) {
      assert.match(css, new RegExp(`\\.nuclear-marker\\.${status}\\s*\\{`), `${status} needs a marker style`);
    }
  });

  it('defines popup labels for every nuclear facility type in every supported locale', () => {
    const requiredKeys = Array.from(
      new Set(parseNuclearFacilities().map((facility) => `popups.nuclear.types.${nuclearTypeLabelKey(facility.type)}`)),
    ).sort();

    const missing = [];
    for (const language of supportedLanguages()) {
      const locale = JSON.parse(src(`src/locales/${language}.json`));
      for (const key of requiredKeys) {
        const value = lookup(locale, key);
        if (typeof value !== 'string' || value.trim().length === 0) {
          missing.push(`${language}.json: ${key}`);
        }
      }
    }

    assert.equal(missing.length, 0, `missing nuclear popup type labels:\n  ${missing.join('\n  ')}`);
  });
});
