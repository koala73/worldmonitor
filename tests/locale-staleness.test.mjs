import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  baselinePathFor,
  classifyKeys,
  expectedKeysForLocale,
  findPluralBases,
  flatten,
  getPluralCategories,
} from '../scripts/translate-locales.mjs';

// Staleness is the whole point of the baseline: a translated key whose English
// source has since changed is indistinguishable, by shape alone, from a
// correctly translated one. Issue #5633 is exactly that — the /pro pricing
// restructure rewrote 14 English strings that every non-English locale already
// had translations for, so a missing-keys-only backfill skipped all of them.

function classify(baselineEn, currentEn, locale, categories = ['one', 'other']) {
  const baselineFlat = flatten(baselineEn);
  const currentFlat = flatten(currentEn);
  const expected = expectedKeysForLocale(currentFlat, findPluralBases(currentFlat), categories);
  const baselineExpected = expectedKeysForLocale(baselineFlat, findPluralBases(baselineFlat), categories);
  return classifyKeys(flatten(locale), expected, baselineExpected);
}

describe('locale staleness classification', () => {
  it('reports a key absent from the locale as missing', () => {
    const result = classify({ a: 'Alpha' }, { a: 'Alpha', b: 'Bravo' }, { a: 'Alfa' });
    assert.deepEqual(result.missing, ['b']);
    assert.deepEqual(result.stale, []);
  });

  it('reports a translated key whose English source is unchanged as fresh', () => {
    const result = classify({ a: 'Alpha' }, { a: 'Alpha' }, { a: 'Alfa' });
    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.fresh, ['a']);
  });

  it('reports a translated key whose English source changed as stale', () => {
    const result = classify(
      { pricing: { highlight: 'No commercial use' } },
      { pricing: { highlight: 'Commercial license — for your organization' } },
      { pricing: { highlight: 'Aucune utilisation commerciale' } },
    );
    assert.deepEqual(result.stale, ['pricing.highlight']);
    assert.deepEqual(result.missing, []);
  });

  it('catches every index an array insert shifted, not just the new tail slot', () => {
    // The pro.features regression: "10 custom dashboards (vs 3)" was inserted at
    // index 5, pushing MCP to 6 and "Priority data refresh" to 7. Index 7 is
    // genuinely new, but 5 and 6 now hold translations of the wrong English
    // string — and a missing-keys check sees both as present.
    const baseline = { features: ['Widget builder', 'MCP access', 'Priority data refresh'] };
    const current = { features: ['Widget builder', '10 custom dashboards', 'MCP access', 'Priority data refresh'] };
    const locale = { features: ['Constructeur de widgets', 'Accès MCP', 'Rafraîchissement prioritaire'] };

    const result = classify(baseline, current, locale);
    assert.deepEqual(result.stale, ['features[1]', 'features[2]']);
    assert.deepEqual(result.missing, ['features[3]']);
  });

  it('leaves a key with no recorded provenance alone rather than retranslating it', () => {
    // Adopting the baseline on an already-translated locale must not trigger a
    // full retranslation of everything it has never tracked.
    const result = classify({}, { a: 'Alpha' }, { a: 'Alfa' });
    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.untracked, ['a']);
  });

  it('marks only the affected CLDR plural categories stale', () => {
    const categories = getPluralCategories('ru');
    assert.deepEqual(categories, ['one', 'few', 'many', 'other']);

    const baseline = { alert_one: '{{count}} alert', alert_other: '{{count}} alerts' };
    const current = { alert_one: '{{count}} alert', alert_other: '{{count}} active alerts' };
    const locale = {
      alert_one: '{{count}} оповещение',
      alert_few: '{{count}} оповещения',
      alert_many: '{{count}} оповещений',
      alert_other: '{{count}} оповещения',
    };

    const result = classify(baseline, current, locale, categories);
    // _one still traces back to the unchanged English singular; every other
    // category is derived from _other, which changed.
    assert.deepEqual(result.fresh, ['alert_one']);
    assert.deepEqual(result.stale.sort(), ['alert_few', 'alert_many', 'alert_other']);
  });

  it('keeps a separate baseline per locale root', () => {
    assert.equal(baselinePathFor(true), 'scripts/locale-baselines/pro-test.json');
    assert.equal(baselinePathFor(false), 'scripts/locale-baselines/app.json');
  });
});
