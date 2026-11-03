/**
 * #9213: alert and digest text render the corroboration verdict that
 * assessCorroboration computes. The relay and the digest cron are CommonJS
 * runtimes that cannot import the TypeScript rule, so these tests hold the
 * CommonJS helpers to it.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import {
  assessCorroboration,
  evidenceFromItem,
  toCorroborationJson,
  type Corroboration,
} from '../server/_shared/corroboration';
import { encodeStoryCorroboration, STORY_CORROBORATION_FIELD } from '../server/_shared/label-history';

const require = createRequire(import.meta.url);
const {
  corroborationFromItemCount,
  parseCorroboration,
  corroborationText,
  mergeCorroboration,
} = require('../scripts/lib/corroboration-text.cjs');

const COUNTS: unknown[] = [undefined, null, 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1, 1.9, 2, 3, 7.2, 40];

describe('corroborationFromItemCount', () => {
  for (const count of COUNTS) {
    it(`matches assessCorroboration(evidenceFromItem) for corroborationCount=${String(count)}`, () => {
      for (const source of ['Reuters', 'Some Blog', '']) {
        const verdict = toCorroborationJson(assessCorroboration(evidenceFromItem({
          source,
          corroborationCount: count as number | undefined,
        })));
        const expected = verdict.state === 'unknown' ? null : verdict;
        assert.deepEqual(corroborationFromItemCount(count), expected);
      }
    });
  }
});

describe('parseCorroboration', () => {
  const verdicts: Corroboration[] = [
    { state: 'corroborated', publishers: 4 },
    { state: 'single-publisher', publishers: 1 },
    { state: 'tier4-only', publishers: 2 },
    { state: 'unknown' },
  ];

  it('reads every story-track value the digest writes', () => {
    for (const verdict of verdicts) {
      const json = toCorroborationJson(verdict);
      const expected = json.state === 'unknown' ? null : json;
      assert.deepEqual(parseCorroboration(encodeStoryCorroboration(verdict)), expected, JSON.stringify(verdict));
    }
  });

  it('reads the MCP and webhook object form', () => {
    for (const verdict of verdicts) {
      const json = toCorroborationJson(verdict);
      assert.deepEqual(parseCorroboration(json), json.state === 'unknown' ? null : json);
    }
  });

  it('rejects malformed and inconsistent values instead of guessing', () => {
    for (const value of [
      '', 'corroborated', 'corroborated|', 'corroborated|x', 'corroborated|1', 'single-publisher|2',
      'tier4-only|1', 'corroborated|2|3', 'verified|3', 'corroborated|-2', 'corroborated|2.5',
      { state: 'corroborated', publishers: 1 }, { state: 'single-publisher', publishers: 3 },
      { state: 'corroborated' }, { state: 'unknown', publishers: null }, 3, null, undefined, [],
    ]) {
      assert.equal(parseCorroboration(value), null, JSON.stringify(value));
    }
  });
});

describe('corroborationText', () => {
  it('renders one short token per known state, and nothing for unknown', () => {
    assert.equal(corroborationText({ state: 'corroborated', publishers: 3 }), '3 independent publishers');
    assert.equal(corroborationText('single-publisher|1'), 'single publisher');
    assert.equal(corroborationText('tier4-only|2'), '2 publishers, all tier 4');
    assert.equal(corroborationText('unknown'), '');
    assert.equal(corroborationText(null), '');
  });

  it('describes coverage, never accuracy', () => {
    for (const value of ['corroborated|5', 'single-publisher|1', 'tier4-only|3']) {
      assert.doesNotMatch(corroborationText(value), /verif|confirm|true|false|accura|corroborated/i);
    }
  });
});

describe('STORY_CORROBORATION_FIELD', () => {
  it('is scoped per digest variant and language', () => {
    assert.equal(STORY_CORROBORATION_FIELD('full', 'en'), 'corroboration:full:en');
    assert.notEqual(STORY_CORROBORATION_FIELD('tech', 'en'), STORY_CORROBORATION_FIELD('full', 'en'));
  });
});

describe('mergeCorroboration — a digest story merged from several story clusters', () => {
  it('keeps a lone story\'s own verdict', () => {
    assert.deepEqual(mergeCorroboration(['corroborated|3'], 2), { state: 'corroborated', publishers: 3 });
    assert.deepEqual(mergeCorroboration(['tier4-only|2'], 2), { state: 'tier4-only', publishers: 2 });
    assert.deepEqual(mergeCorroboration(['single-publisher|1'], 1), { state: 'single-publisher', publishers: 1 });
  });

  it('a superset of a corroborated story stays corroborated, with the largest count', () => {
    assert.deepEqual(
      mergeCorroboration(['single-publisher|1', 'corroborated|4', 'unknown', 'tier4-only|2'], 6),
      { state: 'corroborated', publishers: 4 },
    );
  });

  it('tier-4-only members stay tier4-only', () => {
    assert.deepEqual(mergeCorroboration(['tier4-only|2', 'tier4-only|3'], 4), { state: 'tier4-only', publishers: 3 });
  });

  it('single-publisher members are one publisher only when their sources are one family', () => {
    assert.deepEqual(mergeCorroboration(['single-publisher|1', 'single-publisher|1'], 1), { state: 'single-publisher', publishers: 1 });
    assert.equal(mergeCorroboration(['single-publisher|1', 'single-publisher|1'], 2), null);
    assert.deepEqual(
      mergeCorroboration(['single-publisher|1'], 2),
      { state: 'single-publisher', publishers: 1 },
      'an unmerged story keeps the server verdict: its feed labels can include reprints the same-copy check folded',
    );
  });

  it('does not call merged single-publisher stories one publisher when their sources are unread', () => {
    assert.equal(mergeCorroboration(['single-publisher|1', 'single-publisher|1'], 0), null);
    assert.deepEqual(
      mergeCorroboration(['single-publisher|1'], 0),
      { state: 'single-publisher', publishers: 1 },
      'an unmerged story keeps the verdict the server stored for it',
    );
  });

  it('states nothing it would need source tiers to judge', () => {
    assert.equal(mergeCorroboration(['single-publisher|1', 'tier4-only|2'], 3), null);
    assert.equal(mergeCorroboration(['single-publisher|1', 'unknown'], 1), null);
    assert.equal(mergeCorroboration([], 0), null);
    assert.equal(mergeCorroboration([undefined, 'garbage'], 0), null);
  });
});
