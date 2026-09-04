import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GENERATED_LOCALES,
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
  '(the deploy rebuilds /pro itself since #6898 — commit only the locales).';

// The locales below iterate LOCALES, which keeps zh-TW so the freshness gate
// still covers it. The command in REFRESH_HINT no longer writes it: zh-TW is
// converted from zh.json by scripts/convert-zh-tw.py, and translate-locales.mjs
// skips generated locales on the write path (it even rejects --only=zh-TW). A
// reader who follows the hint on a stale zh-TW gets a run that reports the same
// gap and changes nothing.
const GENERATED_HINT =
  'Generated locales (' +
  [...GENERATED_LOCALES].sort().join(', ') +
  ') are not written by that command — regenerate with: npm run locales:zh-tw';

/** Appended only when a generated locale is actually implicated. */
const hintFor = (locales) =>
  locales.some((locale) => GENERATED_LOCALES.has(locale))
    ? REFRESH_HINT + '  ' + GENERATED_HINT
    : REFRESH_HINT;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const enFlat = flatten(readJson(join(LOCALES_DIR, 'en.json')));

// How many values may still be the English source, per locale.
//
// Some English is correct: brand names, acronyms, product tiers ("Claude
// Desktop", "MCP", "PostgreSQL"). So the check cannot be "zero" — but it also
// cannot be a shared percentage. A 50%-of-catalog rule sounds strict and is
// unreachable: at 582 shared keys it only fires above 291, so `ar` could gain
// 251 raw-English values — 43% of the catalog — and still pass. Nothing that
// can happen would trip it.
//
// These are each locale's real count plus 8 keys of headroom, so a normal PR
// adding a few brand-heavy strings does not red CI while a genuine regression
// does. They are ceilings: lower them as translations improve. If one legitimately
// needs raising, that should be a visible line in a diff, not a silent drift.
//
// fa is the outlier by three orders of magnitude: 565 of its 582 values ARE the
// English source. It is registered as a supported language but was never
// translated (#5644). The baseline cannot detect that — those values genuinely
// were "translated from" the current English, so they read as fresh — which is
// exactly why this ceiling exists.
const ENGLISH_CEILING = {
  ar: 49, bg: 50, cs: 58, de: 61, el: 60, es: 53,
  fa: 573, fr: 66, hi: 115, hr: 55, hu: 51, it: 61,
  ja: 51, ko: 49, nl: 67, pl: 55, pt: 55, ro: 61,
  ru: 51, sv: 61, sw: 45, th: 54, tr: 51, uk: 574, vi: 53, zh: 49,
  'zh-TW': 49,
};

describe('pro locale freshness', () => {
  it('tracks every shipped locale', () => {
    // Everything below iterates LOCALES. A language added to the app and given a
    // locale file but never added to the translator's list would be skipped by
    // all of it — present, untracked, and silently exempt from the gate.
    const shipped = readdirSync(LOCALES_DIR)
      .filter((name) => name.endsWith('.json') && name !== 'en.json')
      .map((name) => name.replace(/\.json$/, ''))
      .sort();
    // Containment, not equality. LOCALES is shared by both roots, and
    // translate-locales.mjs deliberately skips a locale with no file in the
    // active root ("a locale added to main may not yet have a pro-test
    // counterpart... placeholders trigger the pro-bundle freshness hook").
    // Requiring equality would red CI on the supported way to add an app
    // language and push the author into creating exactly the placeholder file
    // the script warns against.
    const untracked = shipped.filter((locale) => !LOCALES.includes(locale));
    assert.deepEqual(
      untracked,
      [],
      'these locale files exist but scripts/translate-locales.mjs does not know about them, so nothing translates or gates them — add them to LOCALES',
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
    const problemLocales = [];
    for (const locale of LOCALES) {
      const file = join(LOCALES_DIR, locale + '.json');
      if (!existsSync(file)) continue;
      const categories = getPluralCategories(locale);
      const result = classifyKeys(
        flatten(readJson(file)),
        expectedKeysForLocale(enFlat, pluralBases, categories),
        expectedKeysForLocale(baseline, baselinePlurals, categories),
      );
      if (result.missing.length || result.stale.length || result.orphan.length) {
        problemLocales.push(locale);
        problems.push(
          locale + ': ' + result.missing.length + ' missing, ' + result.stale.length + ' stale, ' +
            result.orphan.length + ' orphaned (e.g. ' +
            [...result.missing, ...result.stale, ...result.orphan].slice(0, 3).join(', ') + ')',
        );
      }
    }
    assert.deepEqual(problems, [], 'pro locales are out of date. ' + hintFor(problemLocales));
  });

  it('does not let a locale drift back toward untranslated English', () => {
    // A locale whose values are the English source is not a translation; it
    // renders as English while the language picker claims otherwise. This is a
    // live failure mode, not a hypothetical: validateTranslation accepts a
    // "translation" identical to its English source, so a truncated or degraded
    // model reply that echoes the input is written to disk, counted as
    // refreshed, and blessed by the next baseline advance.
    const overBudget = [];
    for (const locale of LOCALES) {
      const file = join(LOCALES_DIR, locale + '.json');
      if (!existsSync(file)) continue;
      const flat = flatten(readJson(file));
      const shared = Object.keys(flat).filter((key) => key in enFlat);
      const english = shared.filter((key) => flat[key] === enFlat[key]);
      const ceiling = ENGLISH_CEILING[locale];

      if (ceiling === undefined) {
        overBudget.push(
          locale + ' has no entry in ENGLISH_CEILING — add one at its current count plus a little headroom',
        );
      } else if (english.length > ceiling) {
        overBudget.push(
          locale + ' has ' + english.length + '/' + shared.length + ' values identical to English, above its ceiling of ' +
            ceiling + ' — translations regressed, or the ceiling needs a deliberate, reviewed raise',
        );
      }
    }
    assert.deepEqual(overBudget, []);
  });
});
