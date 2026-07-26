import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LOCALES_DIR = join(ROOT, localesRootFor(true));
const BASELINE_PATH = join(ROOT, baselinePathFor(true));

const REFRESH_HINT =
  'Run: ANTHROPIC_API_KEY=... node scripts/translate-locales.mjs --pro-test  ' +
  '(then rebuild pro-test and commit public/pro/).';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const enFlat = flatten(readJson(join(LOCALES_DIR, 'en.json')));

// fa.json ships as an English placeholder: 25 languages are registered, but
// Persian was never actually translated, so 565 of its 582 values are the
// English string verbatim. Tracked in #5644 — the baseline cannot detect it,
// because those values genuinely were "translated from" the current English, so
// they read as fresh. The allowance is a ceiling: lower it as fa gets
// translated, never raise it. Every other locale sits at 7–18% English (brand
// names, acronyms, tier names), well under the general limit below.
//
// Set a little above fa's actual 565 rather than exactly on it: a newly added
// key whose translation is legitimately the English word (a brand or product
// name) would otherwise red CI on an unrelated PR. It still sits below the 571
// this pass started from, so the regression it exists to catch cannot pass.
const ENGLISH_PLACEHOLDER_ALLOWANCE = { fa: 570 };

describe('pro locale freshness', () => {
  it('tracks every shipped locale', () => {
    // Everything below iterates LOCALES. A language added to the app and given a
    // locale file but never added to the translator's list would be skipped by
    // all of it — present, untracked, and silently exempt from the gate.
    const shipped = readdirSync(LOCALES_DIR)
      .filter((name) => name.endsWith('.json') && name !== 'en.json')
      .map((name) => name.replace(/\.json$/, ''))
      .sort();
    assert.deepEqual(
      shipped,
      [...LOCALES].sort(),
      'a locale file exists that scripts/translate-locales.mjs does not know about (or vice versa) — add it to LOCALES so it is translated and gated',
    );
  });

  it('keeps the EN baseline in step with en.json', () => {
    // This is the assertion that catches #5633 recurring. English pricing copy
    // gets edited far more often than the translations get refreshed; when that
    // happens the baseline no longer describes what the locales were translated
    // from, and every stale string ships silently.
    assert.ok(existsSync(BASELINE_PATH), baselinePathFor(true) + ' is missing. ' + REFRESH_HINT);
    const baseline = readJson(BASELINE_PATH);

    const drifted = Object.keys(enFlat).filter((key) => baseline[key] !== enFlat[key]);
    const dropped = Object.keys(baseline).filter((key) => !(key in enFlat));
    assert.deepEqual(
      { drifted, dropped },
      { drifted: [], dropped: [] },
      'en.json changed without a translation pass, so ' +
        drifted.length +
        ' English string(s) no longer match what the locales were translated from. ' +
        REFRESH_HINT,
    );
  });

  it('ships every locale complete and free of stale translations', () => {
    const baseline = readJson(BASELINE_PATH);
    const pluralBases = findPluralBases(enFlat);
    const baselinePlurals = findPluralBases(baseline);

    const problems = [];
    for (const locale of LOCALES) {
      const file = join(LOCALES_DIR, locale + '.json');
      if (!existsSync(file)) continue;
      const categories = getPluralCategories(locale);
      const result = classifyKeys(
        flatten(readJson(file)),
        expectedKeysForLocale(enFlat, pluralBases, categories),
        expectedKeysForLocale(baseline, baselinePlurals, categories),
      );
      if (result.missing.length || result.stale.length) {
        problems.push(
          locale + ': ' + result.missing.length + ' missing, ' + result.stale.length + ' stale' +
            ' (e.g. ' + [...result.missing, ...result.stale].slice(0, 3).join(', ') + ')',
        );
      }
    }
    assert.deepEqual(problems, [], 'pro locales are out of date. ' + REFRESH_HINT);
  });

  it('does not let a locale ship as untranslated English', () => {
    // A locale whose values are mostly the English source is not a translation;
    // it renders as English while the language picker claims otherwise.
    const overBudget = [];
    for (const locale of LOCALES) {
      const file = join(LOCALES_DIR, locale + '.json');
      if (!existsSync(file)) continue;
      const flat = flatten(readJson(file));
      const shared = Object.keys(flat).filter((key) => key in enFlat);
      const english = shared.filter((key) => flat[key] === enFlat[key]);

      const allowance = ENGLISH_PLACEHOLDER_ALLOWANCE[locale];
      if (allowance !== undefined) {
        if (english.length > allowance) {
          overBudget.push(
            locale + ' has ' + english.length + ' untranslated English values, above its ' +
              allowance + ' allowance — the allowance is a ceiling and may only be lowered',
          );
        }
        continue;
      }
      // Brand names, acronyms and product tiers legitimately stay in English, so
      // this only catches a locale that is substantially untranslated.
      if (english.length * 2 > shared.length) {
        overBudget.push(
          locale + ' is ' + english.length + '/' + shared.length +
            ' identical to English — it is an English placeholder, not a translation',
        );
      }
    }
    assert.deepEqual(overBudget, []);
  });
});
