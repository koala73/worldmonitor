import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  LOCALES,
  baselinePathFor,
  classifyKeys,
  expectedKeysForLocale,
  findPluralBases,
  flatten,
  getPluralCategories,
  localesRootFor,
} from '../scripts/translate-locales.mjs';

const LOCALES_DIR = localesRootFor(false);
const BASELINE_PATH = baselinePathFor(false);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const enFlat = flatten(readJson(`${LOCALES_DIR}/en.json`));
const REFRESH_HINT =
  'Run the app translation pass, then regenerate zh-TW: ' +
  'ANTHROPIC_API_KEY=... node scripts/translate-locales.mjs && npm run locales:zh-tw';

const NEW_TRANSLATED_KEYS = [
  'popups.militaryFlight.climbRate',
  'popups.militaryFlight.manufacturer',
  'popups.militaryFlight.owner',
  'popups.militaryFlight.builtYear',
  'popups.militaryCluster.showLess',
  'preferences.panelFontScale',
  'preferences.followGlobalFontScale',
];

// Current English-identity counts plus three values of reviewable headroom.
// A translation improvement should lower its locale's ceiling. A legitimate
// English product term may raise one explicitly, but bulk placeholder copies
// must not pass only because their keys exist.
const ENGLISH_CEILING = {
  ar: 359, bg: 250, cs: 292, de: 276, el: 359, es: 433,
  fa: 2576, fr: 425, hi: 141, hr: 281, hu: 255, it: 242,
  ja: 390, ko: 239, nl: 513, pl: 460, pt: 466, ro: 390,
  ru: 377, sv: 490, sw: 393, th: 307, tr: 404, uk: 2708,
  vi: 185, zh: 358, 'zh-TW': 358,
};

function lookup(value, dotted) {
  return dotted.split('.').reduce((current, part) => current?.[part], value);
}

describe('app locale freshness', () => {
  it('tracks every shipped app locale', () => {
    const shipped = readdirSync(LOCALES_DIR)
      .filter((name) => name.endsWith('.json') && !['en.json', 'en.shell.json'].includes(name))
      .map((name) => name.replace(/\.json$/, ''))
      .sort();
    assert.deepEqual(shipped, [...LOCALES].sort());
  });

  it('keeps the English provenance baseline in step with en.json', () => {
    assert.ok(existsSync(BASELINE_PATH), `${BASELINE_PATH} is missing. ${REFRESH_HINT}`);
    const baseline = readJson(BASELINE_PATH);
    const drifted = Object.keys(enFlat).filter((key) => baseline[key] !== enFlat[key]);
    const dropped = Object.keys(baseline).filter((key) => !(key in enFlat));
    assert.deepEqual({ drifted, dropped }, { drifted: [], dropped: [] }, REFRESH_HINT);
  });

  it('ships every locale complete and free of stale or orphaned values', () => {
    const baseline = readJson(BASELINE_PATH);
    const pluralBases = findPluralBases(enFlat);
    const baselinePlurals = findPluralBases(baseline);
    const problems = [];

    for (const locale of LOCALES) {
      const categories = getPluralCategories(locale);
      const result = classifyKeys(
        flatten(readJson(`${LOCALES_DIR}/${locale}.json`)),
        expectedKeysForLocale(enFlat, pluralBases, categories),
        expectedKeysForLocale(baseline, baselinePlurals, categories),
        true,
      );
      if (result.missing.length || result.stale.length || result.orphan.length) {
        problems.push(
          `${locale}: ${result.missing.length} missing, ${result.stale.length} stale, ` +
          `${result.orphan.length} orphaned`,
        );
      }
    }

    assert.deepEqual(problems, [], REFRESH_HINT);
  });

  it('does not persist the seven new labels as English placeholders', () => {
    const en = readJson(`${LOCALES_DIR}/en.json`);
    const placeholders = [];
    for (const locale of LOCALES) {
      const translated = readJson(`${LOCALES_DIR}/${locale}.json`);
      for (const key of NEW_TRANSLATED_KEYS) {
        if (lookup(translated, key) === lookup(en, key)) placeholders.push(`${locale}:${key}`);
      }
    }
    assert.deepEqual(placeholders, [], 'translate these labels instead of copying English values');
  });

  it('does not let a locale drift toward untranslated English', () => {
    const overBudget = [];
    for (const locale of LOCALES) {
      const flat = flatten(readJson(`${LOCALES_DIR}/${locale}.json`));
      const identical = Object.keys(flat).filter((key) => key in enFlat && flat[key] === enFlat[key]);
      const ceiling = ENGLISH_CEILING[locale];
      if (ceiling === undefined || identical.length > ceiling) {
        overBudget.push(`${locale}: ${identical.length} English-identical values, ceiling ${ceiling ?? 'missing'}`);
      }
    }
    assert.deepEqual(overBudget, []);
  });
});
