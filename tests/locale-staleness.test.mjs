import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  baselinePathFor,
  classifyKeys,
  expectedKeysForLocale,
  findPluralBases,
  flatten,
  getPluralCategories,
  mayAdvanceBaseline,
  pruneOrphans,
  translateLocale,
  unresolvedAfterRun,
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

  it('leaves a key with no recorded provenance alone while the baseline is being created', () => {
    // Adopting the baseline on an already-translated locale must not trigger a
    // full retranslation of everything it has never tracked.
    const result = classify({}, { a: 'Alpha' }, { a: 'Alfa' });
    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.untracked, ['a']);
  });

  it('treats a key the EXISTING baseline lost as stale, not fresh', () => {
    // The dangerous case. Locale files are written per batch, but the baseline
    // only advances on a fully clean pass, so "locales moved, baseline did not"
    // is the normal outcome of any partial run. If the English then changes,
    // that key is present in the locale, absent from the baseline — and calling
    // it fresh lets the next clean run record the OLD translation against the
    // NEW English, permanently certifying the rot.
    const baselineFlat = flatten({ a: 'Alpha' });
    const currentFlat = flatten({ a: 'Alpha', k: 'Bar' });
    const expected = expectedKeysForLocale(currentFlat, findPluralBases(currentFlat), ['one', 'other']);
    const baselineExpected = expectedKeysForLocale(baselineFlat, findPluralBases(baselineFlat), ['one', 'other']);
    const locale = flatten({ a: 'Alfa', k: 'translated from the older English' });

    const adopting = classifyKeys(locale, expected, baselineExpected, false);
    assert.deepEqual(adopting.untracked, ['k'], 'no baseline yet: adoption, leave it alone');

    const withBaseline = classifyKeys(locale, expected, baselineExpected, true);
    assert.deepEqual(withBaseline.stale, ['k'], 'baseline exists: unprovenanced means retranslate');
    assert.deepEqual(withBaseline.untracked, []);
  });

  it('reports a locale value the English no longer has as orphaned', () => {
    // #5633 from the opposite direction. Removing the LAST element of an English
    // array leaves every earlier index matching, so nothing is stale — and 24
    // languages keep advertising a bullet the tier no longer offers.
    const baseline = { features: ['A', 'B', 'C'] };
    const current = { features: ['A', 'B'] };
    const locale = { features: ['tA', 'tB', 'tC'] };

    const result = classify(baseline, current, locale);
    assert.deepEqual(result.orphan, ['features[2]']);
    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.missing, []);
  });

  it('carries orphans through the post-run scan, since translating cannot fix them', () => {
    const classification = { missing: [], stale: ['a'], orphan: ['features[9]'], untracked: [], fresh: [] };
    const left = unresolvedAfterRun(classification, new Set(['a']));
    assert.deepEqual(left.stale, [], 'refreshed stale keys clear');
    assert.deepEqual(left.orphan, ['features[9]'], 'orphans never clear by retranslation');
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

  it('discounts the stale keys a run actually refreshed', () => {
    // Staleness compares the baseline to en.json and never looks at the locale,
    // so a key stays stale for the rest of the run even once it has been
    // retranslated. Only the baseline retires it — and the baseline is only
    // allowed to advance when nothing is outstanding. Counting those keys as
    // outstanding deadlocks the pass: the scan never reaches zero, the baseline
    // never advances, and every subsequent run retranslates the same keys.
    const classification = { missing: ['b'], stale: ['a', 'c'], untracked: [], fresh: [] };

    const afterFullRefresh = unresolvedAfterRun(classification, new Set(['a', 'c']));
    assert.deepEqual(afterFullRefresh.stale, []);

    // A key the run failed to write is still outstanding, so the run still fails
    // and the baseline still refuses to advance.
    const afterPartialRefresh = unresolvedAfterRun(classification, new Set(['a']));
    assert.deepEqual(afterPartialRefresh.stale, ['c']);
    assert.deepEqual(afterPartialRefresh.missing, ['b']);

    // A locale the run never touched keeps every stale key outstanding.
    assert.deepEqual(unresolvedAfterRun(classification, new Set()).stale, ['a', 'c']);
  });

  it('keeps a separate baseline per locale root', () => {
    assert.equal(baselinePathFor(true), 'scripts/locale-baselines/pro-test.json');
    assert.equal(baselinePathFor(false), 'scripts/locale-baselines/app.json');
  });
});

describe('orphan pruning', () => {
  // Orphans are the one class retranslation cannot fix, so detection alone left
  // the pass permanently blocked behind manual JSON editing — and removing a
  // single English array element orphans every locale at once. Adopting the app
  // catalog would start 292 orphans deep.

  it('truncates an array to the length the English defines', () => {
    const raw = { pricing: { features: ['tA', 'tB', 'tC', 'tD'] } };
    pruneOrphans(raw, ['pricing.features[2]', 'pricing.features[3]']);
    assert.deepEqual(raw.pricing.features, ['tA', 'tB']);
  });

  it('removes an orphaned object key without disturbing its siblings', () => {
    const raw = { apiSection: { kept: 'ja', gone: 'nein' } };
    pruneOrphans(raw, ['apiSection.gone']);
    assert.deepEqual(raw.apiSection, { kept: 'ja' });
  });

  it('leaves earlier indices untouched when orphans arrive out of order', () => {
    // Deleting indices one at a time in ascending order would shift the array
    // under its own feet; truncating to the lowest orphan index cannot.
    const raw = { f: ['a', 'b', 'c', 'd', 'e'] };
    pruneOrphans(raw, ['f[4]', 'f[2]', 'f[3]']);
    assert.deepEqual(raw.f, ['a', 'b']);
  });

  it('is a no-op when there are no orphans', () => {
    const raw = { a: { b: ['x'] } };
    pruneOrphans(raw, []);
    assert.deepEqual(raw, { a: { b: ['x'] } });
  });

  it('survives a path that no longer exists', () => {
    const raw = { a: 'x' };
    assert.doesNotThrow(() => pruneOrphans(raw, ['nope.deep[3]', 'a.b.c']));
    assert.deepEqual(raw, { a: 'x' });
  });
});

describe('locale translate loop', () => {
  // Classification is only half the fix; this is the half that acts on it. A
  // reversed concat or a dropped `refreshed.add` here recreates #5633 while every
  // classification test stays green, so the wiring is exercised directly.
  const setup = (overrides = {}) => {
    const raw = { pricing: { features: ['old A', 'old B'] }, faq: { a1: 'old answer' } };
    const expected = {
      'pricing.features[0]': 'A',
      'pricing.features[1]': 'B',
      'faq.a1': 'Answer',
    };
    const writes = [];
    return {
      raw,
      expected,
      writes,
      run: (toTranslate, translate) =>
        translateLocale({
          loc: 'de',
          raw,
          expected,
          toTranslate,
          translate,
          persist: () => writes.push(JSON.parse(JSON.stringify(raw))),
          ...overrides,
        }),
    };
  };

  it('writes accepted translations to the right paths and reports them refreshed', async () => {
    const t = setup();
    const result = await t.run(
      ['pricing.features[1]', 'faq.a1'],
      batch => Object.fromEntries(batch.map(([k, en]) => [k, `de:${en}`])),
    );

    assert.equal(result.added, 2);
    assert.deepEqual([...result.refreshed].sort(), ['faq.a1', 'pricing.features[1]']);
    assert.deepEqual(t.raw.pricing.features, ['old A', 'de:B'], 'index 1 replaced in place, 0 untouched');
    assert.equal(t.raw.faq.a1, 'de:Answer');
  });

  it('does not count a key the model omitted as refreshed', async () => {
    const t = setup();
    const result = await t.run(['pricing.features[0]', 'faq.a1'], batch =>
      Object.fromEntries(batch.filter(([k]) => k === 'faq.a1').map(([k, en]) => [k, `de:${en}`])),
    );

    assert.equal(result.added, 1);
    assert.ok(!result.refreshed.has('pricing.features[0]'), 'an omitted key must stay outstanding');
    assert.equal(t.raw.pricing.features[0], 'old A', 'and its old value must survive untouched');
  });

  it('does not count a rejected translation as refreshed', async () => {
    const t = setup();
    // Dropping the interpolation token makes validateTranslation reject it.
    t.expected['faq.a1'] = 'Hello {{name}}';
    const result = await t.run(['faq.a1'], () => ({ 'faq.a1': 'Hallo' }));

    assert.equal(result.added, 0);
    assert.equal(result.rejected, 1);
    assert.equal(result.refreshed.size, 0);
    assert.equal(t.raw.faq.a1, 'old answer');
  });

  it('keeps earlier batches when a later one throws', async () => {
    const t = setup({ batchSize: 1 });
    let call = 0;
    const result = await t.run(['faq.a1', 'pricing.features[0]'], batch => {
      call += 1;
      if (call === 2) throw new Error('rate limited');
      return Object.fromEntries(batch.map(([k, en]) => [k, `de:${en}`]));
    });

    assert.equal(result.added, 1, 'the batch that succeeded is kept');
    assert.deepEqual([...result.refreshed], ['faq.a1']);
    assert.equal(t.raw.pricing.features[0], 'old A', 'the failed batch leaves its key outstanding');
  });

  it('persists after every batch so an interrupted run keeps its progress', async () => {
    const t = setup({ batchSize: 1 });
    await t.run(['faq.a1', 'pricing.features[0]'], batch =>
      Object.fromEntries(batch.map(([k, en]) => [k, `de:${en}`])),
    );
    assert.equal(t.writes.length, 2);
    assert.equal(t.writes[0].faq.a1, 'de:Answer', 'first write already carries the first batch');
  });
});

describe('baseline advance', () => {
  // Advancing the baseline is the one irreversible act: it declares "every
  // committed translation came from this English", and nothing ever re-examines
  // a key it has blessed. So the predicate is deliberately paranoid.
  const clean = { unresolved: 0, rejected: 0, untracked: 0, baselineExisted: true, dryRun: false };

  it('advances when every locale is complete and fresh', () => {
    assert.equal(mayAdvanceBaseline(clean).advance, true);
  });

  it('adopts a root for the first time only when asked to', () => {
    // A missing baseline is indistinguishable from a deleted one, so adoption
    // cannot be inferred from its absence: `rm` on the baseline plus a re-run
    // would otherwise re-adopt every current translation as correct, with no API
    // call and exit 0.
    const firstRun = { ...clean, baselineExisted: false, untracked: 5359 };
    const inferred = mayAdvanceBaseline(firstRun);
    assert.equal(inferred.advance, false);
    assert.match(inferred.reason, /--adopt-baseline/);

    assert.equal(mayAdvanceBaseline({ ...firstRun, adoptBaseline: true }).advance, true);
  });

  it('refuses when a key is still missing, stale or orphaned', () => {
    assert.equal(mayAdvanceBaseline({ ...clean, unresolved: 1 }).advance, false);
  });

  it('refuses when any translation was rejected', () => {
    assert.equal(mayAdvanceBaseline({ ...clean, rejected: 1 }).advance, false);
  });

  it('refuses when an existing baseline has lost entries', () => {
    // Deleting the baseline file — or resolving a merge conflict in it by
    // dropping a line — otherwise makes every key untracked, so a run that
    // performs zero translations exits 0 and re-adopts whatever the locales
    // currently say as correct. That is the unrecoverable failure.
    const verdict = mayAdvanceBaseline({ ...clean, untracked: 24 });
    assert.equal(verdict.advance, false);
    assert.match(verdict.reason, /lost entries/);
  });

  it('never advances on a dry run', () => {
    assert.equal(mayAdvanceBaseline({ ...clean, dryRun: true }).advance, false);
  });
});
