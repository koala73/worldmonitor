import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  SCOPE_ISO2_CODES,
  SCOPE_MAX_COUNTRIES,
  isValidScopeIso2,
  normalizeScope,
  scopeEquals,
  scopeStatus,
  type TabScope,
} from '../shared/tab-scope.ts';
import { resolveScope } from '../shared/tab-scope-resolve.ts';

const JSON_CODES = Object.keys(JSON.parse(readFileSync(new URL('../shared/iso2-to-iso3.json', import.meta.url), 'utf8'))).sort();

test('tab-scope stays free of the adjacency table (the tab store loads it at first paint)', () => {
  const source = readFileSync(new URL('../shared/tab-scope.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b(?!\s+type\b).*country-adjacency/m);
});

test('the inlined ISO2 list matches shared/iso2-to-iso3.json exactly', () => {
  assert.deepEqual([...SCOPE_ISO2_CODES], JSON_CODES);
});

test('isValidScopeIso2 accepts only uppercase known codes', () => {
  assert.equal(isValidScopeIso2('TH'), true);
  assert.equal(isValidScopeIso2('XK'), true);
  assert.equal(isValidScopeIso2('th'), false);
  assert.equal(isValidScopeIso2('ZZ'), false);
  assert.equal(isValidScopeIso2('THA'), false);
  assert.equal(isValidScopeIso2(42), false);
  assert.equal(isValidScopeIso2(null), false);
  assert.equal(isValidScopeIso2('constructor'), false);
});

test('normalizeScope accepts a valid scope and returns a fresh object', () => {
  const raw = { countries: ['TH', 'VN'], neighbours: false, start: '2026-11-01', end: '2026-11-20' };
  const out = normalizeScope(raw);
  assert.deepEqual(out, raw);
  assert.notEqual(out, raw);
  assert.notEqual(out?.countries, raw.countries);
});

test('normalizeScope uppercases, trims, dedupes and drops invalid codes', () => {
  assert.deepEqual(normalizeScope({ countries: ['th', ' vn ', 'TH', 'ZZ', 7, 'id'] }), {
    countries: ['TH', 'VN', 'ID'], neighbours: true,
  });
});

test('normalizeScope rejects empty, all-invalid, oversized and malformed input', () => {
  assert.equal(normalizeScope(null), null);
  assert.equal(normalizeScope('TH'), null);
  assert.equal(normalizeScope([]), null);
  assert.equal(normalizeScope({}), null);
  assert.equal(normalizeScope({ countries: 'TH' }), null);
  assert.equal(normalizeScope({ countries: [] }), null);
  assert.equal(normalizeScope({ countries: ['ZZ', 'QQ'] }), null);
  const thirteen = SCOPE_ISO2_CODES.filter((c) => c !== 'AQ').slice(0, 13);
  assert.equal(normalizeScope({ countries: thirteen }), null);
  assert.equal(normalizeScope({ countries: thirteen.slice(0, SCOPE_MAX_COUNTRIES) })?.countries.length, 12);
  // 13 entries that dedupe down to 12 are fine.
  assert.equal(normalizeScope({ countries: [...thirteen.slice(0, 12), thirteen[0]] })?.countries.length, 12);
});

test('normalizeScope defaults neighbours to true unless it is a boolean', () => {
  assert.equal(normalizeScope({ countries: ['TH'] })?.neighbours, true);
  assert.equal(normalizeScope({ countries: ['TH'], neighbours: 'no' })?.neighbours, true);
  assert.equal(normalizeScope({ countries: ['TH'], neighbours: false })?.neighbours, false);
  assert.equal(normalizeScope({ countries: ['TH'], neighbours: true })?.neighbours, true);
});

test('normalizeScope keeps only real calendar dates and drops an inverted range', () => {
  const dates = (start: unknown, end: unknown) => {
    const s = normalizeScope({ countries: ['TH'], start, end });
    return { start: s?.start, end: s?.end, hasStart: s ? 'start' in s : false, hasEnd: s ? 'end' in s : false };
  };
  assert.deepEqual(dates('2026-11-01', '2026-11-01'), { start: '2026-11-01', end: '2026-11-01', hasStart: true, hasEnd: true });
  assert.deepEqual(dates('2026-02-30', '2026-03-01'), { start: undefined, end: '2026-03-01', hasStart: false, hasEnd: true });
  assert.deepEqual(dates('2028-02-29', undefined), { start: '2028-02-29', end: undefined, hasStart: true, hasEnd: false });
  assert.deepEqual(dates('2026-11-01', '2026-13-01'), { start: '2026-11-01', end: undefined, hasStart: true, hasEnd: false });
  assert.deepEqual(dates('2026-11-20', '2026-11-01'), { start: undefined, end: undefined, hasStart: false, hasEnd: false });
  for (const bad of ['2026-1-01', '26-11-01', '2026-11-01T00:00:00Z', 20261101, '0000-01-01', '2026-00-10']) {
    assert.equal(dates(bad, undefined).hasStart, false, String(bad));
  }
});

test('resolveScope returns chosen in order and the union of neighbours minus chosen', () => {
  const { chosen, neighbours } = resolveScope({ countries: ['TH', 'VN', 'ID'], neighbours: true });
  assert.deepEqual(chosen, ['TH', 'VN', 'ID']);
  for (const c of ['TH', 'VN', 'ID']) assert.ok(!neighbours.includes(c), `${c} is chosen`);
  for (const n of ['LA', 'KH', 'MM', 'MY', 'CN', 'PG', 'TL', 'SG']) assert.ok(neighbours.includes(n), `missing ${n}`);
  assert.deepEqual(neighbours, [...new Set(neighbours)].sort());
});

test('resolveScope returns no neighbours when neighbours is off', () => {
  assert.deepEqual(resolveScope({ countries: ['TH', 'VN'], neighbours: false }), { chosen: ['TH', 'VN'], neighbours: [] });
});

test('neighbours do not count against the 12-country limit', () => {
  const twelve = ['CN', 'RU', 'DE', 'FR', 'BR', 'TH', 'IN', 'IR', 'TR', 'SA', 'CD', 'TZ'];
  const scope = normalizeScope({ countries: twelve });
  assert.ok(scope);
  const resolved = resolveScope(scope);
  assert.equal(resolved.chosen.length, 12);
  assert.ok(resolved.neighbours.length > SCOPE_MAX_COUNTRIES);
});

test('scopeStatus compares calendar days in UTC', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  const s = (start?: string, end?: string): TabScope => ({ countries: ['TH'], neighbours: true, ...(start ? { start } : {}), ...(end ? { end } : {}) });
  assert.equal(scopeStatus(s(), now), 'none');
  assert.equal(scopeStatus(s('2026-11-01', '2026-11-20'), now), 'open');
  assert.equal(scopeStatus(s('2026-11-11', '2026-11-11'), now), 'open');
  assert.equal(scopeStatus(s('2026-11-01', '2026-11-10'), now), 'ended');
  assert.equal(scopeStatus(s('2026-11-12', '2026-11-20'), now), 'upcoming');
  assert.equal(scopeStatus(s('2026-11-01'), now), 'open');
  assert.equal(scopeStatus(s('2026-11-12'), now), 'upcoming');
  assert.equal(scopeStatus(s(undefined, '2026-11-11'), now), 'open');
  assert.equal(scopeStatus(s(undefined, '2026-11-10'), now), 'ended');
  assert.equal(scopeStatus(s('2026-11-01', '2026-11-20'), new Date(Number.NaN)), 'none');
});

test('scopeEquals compares order, flags and dates', () => {
  const a: TabScope = { countries: ['TH', 'VN'], neighbours: true, start: '2026-11-01' };
  assert.equal(scopeEquals(a, { ...a, countries: ['TH', 'VN'] }), true);
  assert.equal(scopeEquals(a, { ...a, countries: ['VN', 'TH'] }), false);
  assert.equal(scopeEquals(a, { ...a, neighbours: false }), false);
  assert.equal(scopeEquals(a, { ...a, start: '2026-11-02' }), false);
  assert.equal(scopeEquals(a, { ...a, end: '2026-11-20' }), false);
  assert.equal(scopeEquals(a, { countries: ['TH', 'VN'], neighbours: true, start: '2026-11-01', end: undefined }), true);
  assert.equal(scopeEquals(null, undefined), true);
  assert.equal(scopeEquals(a, null), false);
  assert.equal(scopeEquals(undefined, a), false);
});
