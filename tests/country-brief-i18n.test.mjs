import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function src(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function lookup(obj, key) {
  return key.split('.').reduce((cur, part) => cur?.[part], obj);
}

describe('country brief i18n keys', () => {
  const en = JSON.parse(src('src/locales/en.json'));

  it('keeps severity, trend, and fallback labels under the namespace used by country brief UI', () => {
    const keys = [
      'countryBrief.levels.critical',
      'countryBrief.levels.high',
      'countryBrief.levels.elevated',
      'countryBrief.levels.moderate',
      'countryBrief.levels.normal',
      'countryBrief.levels.low',
      'countryBrief.trends.rising',
      'countryBrief.trends.falling',
      'countryBrief.trends.stable',
      'countryBrief.fallback.instabilityIndex',
      'countryBrief.fallback.protestsDetected',
      'countryBrief.fallback.aircraftTracked',
      'countryBrief.fallback.vesselsTracked',
      'countryBrief.fallback.activeStrikes',
      'countryBrief.fallback.internetOutages',
      'countryBrief.fallback.recentEarthquakes',
      'countryBrief.fallback.stockIndex',
    ];

    for (const key of keys) {
      const value = lookup(en, key);
      assert.equal(typeof value, 'string', `${key} must resolve to a string`);
      assert.ok(value.trim().length > 0, `${key} must not be empty`);
    }
  });

  it('uses the locale namespace where severity, trend, and fallback labels are defined', () => {
    const files = [
      'src/app/country-intel.ts',
      'src/components/CountryBriefPage.ts',
      'src/components/CountryDeepDivePanel.ts',
    ];

    for (const file of files) {
      assert.match(src(file), /t\((?:'|"|`)countryBrief\.(?:levels|trends|fallback)\./, `${file} should use countryBrief for these labels`);
      assert.doesNotMatch(src(file), /t\((?:'|"|`)modals\.countryBrief\.(?:levels|trends|fallback)\./, `${file} should not use modals.countryBrief for these labels`);
    }
  });
});
