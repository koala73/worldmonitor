import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSanctionsName, screenSanctions } from '../server/_shared/sanctions-screen.ts';

const index = [
  { id: 'SDN:1', name: 'Café Maritime Holdings, LLC', et: 'entity', cc: ['RU'], pr: ['SDN'],
    al: ['Northern Star Shipping'], ids: ['imo:1234567'], sl: ['SDN'] },
  { id: 'SEMA:2', name: 'Alpha Trading Limited', et: 'entity', cc: ['IR'], pr: ['SEMA'], sl: ['SEMA'] },
];

test('folds diacritics, punctuation and trailing legal suffixes while retaining non-Latin names', () => {
  assert.equal(normalizeSanctionsName('  CAFÉ Maritime Holdings, L.L.C. '), 'cafe maritime holdings');
  assert.equal(normalizeSanctionsName('Alpha-Trading Ltd.'), 'alpha trading');
  assert.equal(normalizeSanctionsName('北京公司'), '北京公司');
  assert.equal(screenSanctions(index, 'Holdings Cafe Maritime')[0]?.score, 100);
});

test('screens exact aliases and reports the original matched text', () => {
  const [hit] = screenSanctions(index, 'Northern Star Shipping', 100);
  assert.equal(hit?.id, 'SDN:1');
  assert.equal(hit?.score, 100);
  assert.equal(hit?.matched_on, 'alias');
  assert.equal(hit?.matched_text, 'Northern Star Shipping');
});

test('prefers an exact alias over a primary name with an equal token-subset score', () => {
  const [hit] = screenSanctions([{ ...index[0], name: 'Northern Star Shipping', al: ['Northern Star'] }], 'Northern Star');
  assert.equal(hit?.matched_on, 'alias');
  assert.equal(hit?.matched_text, 'Northern Star');
});

test('a shared generic token does not make unrelated multi-token names strong matches', () => {
  assert.deepEqual(screenSanctions(index, 'Rosneft Trading'), []);
});

test('matches IMO identifiers exactly and does not fuzzy-match a different identifier', () => {
  for (const query of ['IMO 1234567', 'imo:1234567', '1234567']) {
    const [hit] = screenSanctions(index, query);
    assert.equal(hit?.score, 100);
    assert.equal(hit?.matched_on, 'identifier');
    assert.equal(hit?.matched_text, 'imo:1234567');
  }
  assert.deepEqual(screenSanctions(index, 'IMO 1234568'), []);
});

test('uses fuzzy token-set Jaro-Winkler scores and applies the threshold before returning sorted hits', () => {
  const matches = screenSanctions(index, 'Alfa Trading');
  assert.equal(matches[0]?.id, 'SEMA:2');
  assert.ok(matches[0]!.score >= 70 && matches[0]!.score < 100);
  assert.deepEqual(screenSanctions(index, 'Alfa Trading', 100), []);
  const all = screenSanctions(index, 'Maritime', 0);
  assert.equal(all.length, 2);
  assert.ok(all[0]!.score >= all[1]!.score);
});

test('supports legacy index records and rejects empty normalized searches and malformed cached rows', () => {
  assert.equal(screenSanctions(index, 'alpha trading')[0]?.matched_on, 'name');
  assert.deepEqual(screenSanctions(index, 'LLC'), []);
  assert.deepEqual(screenSanctions(index, '...'), []);
  assert.deepEqual(screenSanctions(null, 'Alpha'), []);
  assert.deepEqual(screenSanctions([null, {}, { name: 3 }], 'Alpha'), []);
});
