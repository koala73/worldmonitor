import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { syncMissingExpectedKeys } from '../scripts/sync-locale-keys.mjs';
import {
  expectedKeysForLocale,
  findPluralBases,
  flatten,
  getPluralCategories,
} from '../scripts/translate-locales.mjs';

describe('locale key synchronization', () => {
  const english = {
    alerts_one: '{{count}} alert',
    alerts_other: '{{count}} alerts',
    title: 'Status',
  };
  const englishFlat = flatten(english);
  const pluralBases = findPluralBases(englishFlat);

  it('does not add an English singular variant to an other-only locale', () => {
    const expected = expectedKeysForLocale(
      englishFlat,
      pluralBases,
      getPluralCategories('ja'),
    );
    const synced = syncMissingExpectedKeys({ alerts_other: '通知' }, expected);

    assert.deepEqual(synced, { alerts_other: '通知', title: 'Status' });
  });

  it('adds every CLDR category required by a richer plural locale', () => {
    const expected = expectedKeysForLocale(
      englishFlat,
      pluralBases,
      getPluralCategories('ar'),
    );
    const synced = syncMissingExpectedKeys({}, expected);

    assert.deepEqual(Object.keys(synced).sort(), [
      'alerts_few',
      'alerts_many',
      'alerts_one',
      'alerts_other',
      'alerts_two',
      'alerts_zero',
      'title',
    ]);
  });
});
