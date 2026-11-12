/**
 * Dashboard focus (#10453): the partition every filtering panel renders from.
 * Chosen countries first, then neighbours, each in source order; items in
 * other countries are counted, never listed; items with no country are kept
 * apart and counted, never dropped.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { partitionByScope } from '../src/components/panel-scope-partition.ts';
import type { ResolvedScope } from '../src/services/tab-focus.ts';

interface Row {
  id: string;
  country: string | string[] | null;
}

const SCOPE: ResolvedScope = {
  scope: { countries: ['TH', 'VN', 'ID'], neighbours: true },
  chosen: ['TH', 'VN', 'ID'],
  neighbours: ['KH', 'LA', 'MM', 'MY', 'CN', 'TL', 'PG'],
};

const NO_NEIGHBOURS: ResolvedScope = {
  scope: { countries: ['TH', 'VN', 'ID'], neighbours: false },
  chosen: ['TH', 'VN', 'ID'],
  neighbours: [],
};

const ROWS: Row[] = [
  { id: 'us-1', country: 'US' },
  { id: 'la-1', country: 'LA' },
  { id: 'th-1', country: 'TH' },
  { id: 'none-1', country: null },
  { id: 'vn-1', country: 'VN' },
  { id: 'kh-1', country: 'KH' },
  { id: 'fr-1', country: 'FR' },
  { id: 'none-2', country: [] },
  { id: 'th-2', country: 'th' },
];

const countryOf = (row: Row) => row.country;
const ids = (rows: Array<{ item: Row }>) => rows.map((r) => r.item.id);

describe('partitionByScope', () => {
  it('lists chosen-country items before neighbour items, each in source order', () => {
    const { shown } = partitionByScope(ROWS, countryOf, SCOPE);
    assert.deepEqual(ids(shown), ['th-1', 'vn-1', 'th-2', 'la-1', 'kh-1']);
    assert.deepEqual(shown.map((r) => r.relation), ['chosen', 'chosen', 'chosen', 'neighbour', 'neighbour']);
    assert.deepEqual(shown.map((r) => r.country), ['TH', 'VN', 'TH', 'LA', 'KH']);
  });

  it('counts items in other countries without listing them', () => {
    const result = partitionByScope(ROWS, countryOf, SCOPE);
    assert.equal(result.hiddenCount, 2); // US, FR
  });

  it('keeps items with no country apart, counted and in source order, never dropped', () => {
    const result = partitionByScope(ROWS, countryOf, SCOPE);
    assert.deepEqual(result.unattributed.map((r) => r.id), ['none-1', 'none-2']);
    assert.equal(
      result.shown.length + result.hiddenCount + result.unattributed.length,
      ROWS.length,
      'every item lands in exactly one bucket',
    );
  });

  it('counts neighbour items as hidden when neighbours are switched off', () => {
    const result = partitionByScope(ROWS, countryOf, NO_NEIGHBOURS);
    assert.deepEqual(ids(result.shown), ['th-1', 'vn-1', 'th-2']);
    assert.equal(result.hiddenCount, 4); // US, LA, KH, FR
    assert.equal(result.unattributed.length, 2);
  });

  it('an item naming several countries is chosen if any is chosen, else a neighbour if any is', () => {
    const rows: Row[] = [
      { id: 'kh-th', country: ['KH', 'TH'] },
      { id: 'us-la', country: ['US', 'LA'] },
      { id: 'us-fr', country: ['US', 'FR'] },
    ];
    const result = partitionByScope(rows, countryOf, SCOPE);
    assert.deepEqual(result.shown.map((r) => [r.item.id, r.relation, r.country]), [
      ['kh-th', 'chosen', 'TH'],
      ['us-la', 'neighbour', 'LA'],
    ]);
    assert.equal(result.hiddenCount, 1);
  });

  it('is the identity without a focus', () => {
    const result = partitionByScope(ROWS, countryOf, null);
    assert.deepEqual(ids(result.shown), ROWS.map((r) => r.id));
    assert.equal(result.hiddenCount, 0);
    assert.deepEqual(result.unattributed, []);
  });

  it('handles an empty list', () => {
    const result = partitionByScope([], countryOf, SCOPE);
    assert.deepEqual(result, { shown: [], hiddenCount: 0, unattributed: [] });
  });
});
