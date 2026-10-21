import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const LOCALES_DIR = 'src/locales';

function src(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function lookup(obj, key) {
  return key.split('.').reduce((cur, part) => cur?.[part], obj);
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function loadLocales() {
  return readdirSync(join(ROOT, LOCALES_DIR))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, data: JSON.parse(src(`${LOCALES_DIR}/${file}`)) }));
}

const COUNTRY_BRIEF_KEYS = [
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

describe('country brief i18n keys', () => {
  it('resolves severity, trend, and fallback labels in every locale', () => {
    const locales = loadLocales();
    assert.ok(locales.length > 0, `expected at least one locale in ${LOCALES_DIR}`);

    const missing = [];
    for (const { file, data } of locales) {
      for (const key of COUNTRY_BRIEF_KEYS) {
        const value = lookup(data, key);
        if (typeof value !== 'string' || value.trim().length === 0) {
          missing.push(`${file}: ${key}`);
        }
      }
    }

    assert.equal(
      missing.length,
      0,
      `country brief labels missing or empty:\n  ${missing.join('\n  ')}`,
    );
  });

  it('uses the locale namespace where severity, trend, and fallback labels are defined', () => {
    const files = [
      'src/app/country-intel.ts',
      'src/components/CountryBriefPage.ts',
      'src/components/CountryDeepDivePanel.ts',
    ];

    for (const file of files) {
      const body = stripComments(src(file));
      assert.match(body, /t\((?:'|"|`)countryBrief\.(?:levels|trends|fallback)\./, `${file} should use countryBrief for these labels`);
      assert.doesNotMatch(body, /t\((?:'|"|`)modals\.countryBrief\.(?:levels|trends|fallback)\./, `${file} should not use modals.countryBrief for these labels`);
    }
  });
});
