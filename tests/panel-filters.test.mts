import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PANEL_FILTER_MAX_ENTRIES,
  PANEL_FILTER_MAX_VALUE_LENGTH,
  filtersFromEntries,
  filtersToEntries,
  normalizePanelFilters,
  planPanelFilterApply,
  setPanelFilter,
} from '../src/services/panel-filters.ts';

test('normalizePanelFilters keeps well-formed string choices', () => {
  assert.deepEqual(normalizePanelFilters({ forecast: 'asia', 'live-webcams': 'europe' }), {
    forecast: 'asia',
    'live-webcams': 'europe',
  });
});

test('normalizePanelFilters returns undefined for nothing usable', () => {
  assert.equal(normalizePanelFilters(undefined), undefined);
  assert.equal(normalizePanelFilters(null), undefined);
  assert.equal(normalizePanelFilters('x'), undefined);
  assert.equal(normalizePanelFilters([]), undefined);
  assert.equal(normalizePanelFilters({}), undefined);
});

test('normalizePanelFilters drops keys and values the server would refuse', () => {
  const long = 'x'.repeat(PANEL_FILTER_MAX_VALUE_LENGTH + 1);
  assert.deepEqual(
    normalizePanelFilters({
      ok: 'a',
      '': 'a',
      'bad key': 'a',
      number: 3,
      nested: { a: 1 },
      long,
      __proto__: 'x',
    }),
    { ok: 'a' },
  );
});

test('normalizePanelFilters caps the number of entries', () => {
  const raw: Record<string, string> = {};
  for (let i = 0; i < PANEL_FILTER_MAX_ENTRIES + 10; i++) raw[`panel${i}`] = 'v';
  assert.equal(Object.keys(normalizePanelFilters(raw)!).length, PANEL_FILTER_MAX_ENTRIES);
});

test('setPanelFilter sets, replaces and removes a choice without touching the input', () => {
  const start = { a: '1' };
  const set = setPanelFilter(start, 'b', '2');
  assert.deepEqual(set, { a: '1', b: '2' });
  assert.deepEqual(start, { a: '1' });
  assert.deepEqual(setPanelFilter(set, 'a', '9'), { a: '9', b: '2' });
  assert.deepEqual(setPanelFilter(set, 'a', null), { b: '2' });
  assert.equal(setPanelFilter({ a: '1' }, 'a', null), undefined);
  assert.equal(setPanelFilter(undefined, 'a', null), undefined);
});

test('setPanelFilter refuses a key or value the server would refuse', () => {
  assert.deepEqual(setPanelFilter({ a: '1' }, 'bad key', 'x'), { a: '1' });
  assert.deepEqual(setPanelFilter({ a: '1' }, 'b', 'x'.repeat(PANEL_FILTER_MAX_VALUE_LENGTH + 1)), { a: '1' });
});

test('entries round trip in a stable order', () => {
  const entries = filtersToEntries({ b: '2', a: '1' });
  assert.deepEqual(entries, [{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
  assert.deepEqual(filtersFromEntries(entries), { a: '1', b: '2' });
  assert.deepEqual(filtersToEntries(undefined), []);
  assert.equal(filtersFromEntries([]), undefined);
  assert.equal(filtersFromEntries(undefined), undefined);
});

test('planPanelFilterApply hands a tab its choices and records which panels it set', () => {
  const plan = planPanelFilterApply(['forecast', 'live-webcams', 'markets'], { forecast: 'asia' }, new Set());
  assert.deepEqual(plan.updates, [{ key: 'forecast', value: 'asia' }]);
  assert.deepEqual([...plan.applied], ['forecast']);
});

test('planPanelFilterApply resets a panel the previous tab set and this tab does not', () => {
  const plan = planPanelFilterApply(['forecast', 'live-webcams'], { 'live-webcams': 'europe' }, new Set(['forecast', 'live-webcams']));
  assert.deepEqual(plan.updates, [
    { key: 'forecast', value: null },
    { key: 'live-webcams', value: 'europe' },
  ]);
  assert.deepEqual([...plan.applied], ['live-webcams']);
});

test('planPanelFilterApply leaves a panel alone when neither tab chose for it (a saved browser preference stays)', () => {
  const plan = planPanelFilterApply(['live-webcams'], undefined, new Set());
  assert.deepEqual(plan.updates, []);
  assert.equal(plan.applied.size, 0);
});

test('planPanelFilterApply keeps a tab key for a panel that is not mounted yet', () => {
  const plan = planPanelFilterApply(['forecast'], { 'live-webcams': 'europe' }, new Set());
  assert.deepEqual(plan.updates, []);
  assert.deepEqual([...plan.applied], ['live-webcams']);
});
