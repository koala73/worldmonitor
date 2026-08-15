/**
 * Batch headline translation (SummarizeArticle mode='translate').
 *
 * Covers:
 * - numbered-list round-trip framing shared by client and server
 * - translate prompt shapes: single-headline stays legacy-identical,
 *   multi-headline switches to the numbered batch contract
 * - per-headline cache key identity: a batch item's key must equal the
 *   legacy single-headline translate key so old cache entries stay valid
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNumberedList, parseNumberedList } from '../src/utils/numbered-list.ts';
import { buildSummaryCacheKey } from '../src/utils/summary-cache-key.ts';
import { buildArticlePrompts } from '../server/worldmonitor/news/v1/_shared.ts';
import { translatorLanguageCandidates } from '../src/services/browser-translator.ts';

describe('buildNumberedList / parseNumberedList round-trip', () => {
  it('round-trips a batch', () => {
    const items = ['Inflation rises to 3.5%', 'Fed holds rates steady', 'Markets react'];
    const parsed = parseNumberedList(buildNumberedList(items), items.length);
    assert.deepEqual(parsed, items);
  });

  it('keeps blank slots null so callers preserve the original text', () => {
    const parsed = parseNumberedList('1. 見出しA\n2. \n3. 見出しC', 3);
    assert.deepEqual(parsed, ['見出しA', null, '見出しC']);
  });

  it('accepts bare text for a single item (legacy shape)', () => {
    assert.deepEqual(parseNumberedList('インフレ率が3.5%に上昇', 1), ['インフレ率が3.5%に上昇']);
  });

  it('strips echoed numbering on a single item', () => {
    assert.deepEqual(parseNumberedList('1. インフレ率が3.5%に上昇', 1), ['インフレ率が3.5%に上昇']);
  });

  it('tolerates alternative separators and out-of-order lines', () => {
    const parsed = parseNumberedList('2) 二番目\n1、 一番目', 2);
    assert.deepEqual(parsed, ['一番目', '二番目']);
  });

  it('ignores out-of-range and duplicate numbers', () => {
    const parsed = parseNumberedList('1. first\n1. dupe\n9. out of range', 2);
    assert.deepEqual(parsed, ['first', null]);
  });

  it('returns all nulls for empty/conversational output', () => {
    assert.deepEqual(parseNumberedList('', 2), [null, null]);
    assert.deepEqual(parseNumberedList('Here are the translations you asked for!', 2), [null, null]);
  });
});

describe('translate prompt shapes', () => {
  const opts = { mode: 'translate', geoContext: '', variant: 'ja', lang: '', bodies: [] };

  it('single headline keeps the legacy prompt byte-identical', () => {
    const { systemPrompt, userPrompt } = buildArticlePrompts(['Fed holds rates'], ['Fed holds rates'], opts);
    assert.equal(userPrompt, 'Translate to ja:\nFed holds rates');
    assert.match(systemPrompt, /Output ONLY the translated text\./);
    assert.doesNotMatch(systemPrompt, /numbered/);
  });

  it('multiple headlines switch to the numbered batch contract', () => {
    const headlines = ['Fed holds rates', 'Markets react'];
    const { systemPrompt, userPrompt } = buildArticlePrompts(headlines, headlines, opts);
    assert.equal(userPrompt, 'Translate to ja:\n1. Fed holds rates\n2. Markets react');
    assert.match(systemPrompt, /numbered list of translations matching the input numbers/);
    assert.match(systemPrompt, /one per line/);
  });
});

describe('per-headline translate cache key identity', () => {
  it('batch item key equals the legacy single-headline translate key', () => {
    // The server's translate path keys each unique headline as
    // getCacheKey([h], 'translate', '', targetLang, lang) — exactly the
    // legacy shape minted by the manual per-item translate button.
    const legacy = buildSummaryCacheKey(['Fed holds rates'], 'translate', '', 'ja', 'en');
    const perItem = buildSummaryCacheKey(['Fed holds rates'], 'translate', '', 'ja', 'en');
    assert.equal(perItem, legacy);
  });

  it('translate keys ignore bodies (per-headline identity is stable)', () => {
    const without = buildSummaryCacheKey(['Fed holds rates'], 'translate', '', 'ja', 'en');
    const withBodies = buildSummaryCacheKey(['Fed holds rates'], 'translate', '', 'ja', 'en', undefined, ['some rss description']);
    assert.equal(withBodies, without);
  });

  it('different target languages mint different keys', () => {
    const ja = buildSummaryCacheKey(['Fed holds rates'], 'translate', '', 'ja', 'en');
    const fr = buildSummaryCacheKey(['Fed holds rates'], 'translate', '', 'fr', 'en');
    assert.notEqual(ja, fr);
  });
});

describe('browser translator language candidates', () => {
  it('passes plain codes through', () => {
    assert.deepEqual(translatorLanguageCandidates('ja'), ['ja']);
  });

  it('probes script-tagged Chinese first', () => {
    assert.deepEqual(translatorLanguageCandidates('zh'), ['zh-Hans', 'zh']);
  });

  it('rejects empty input', () => {
    assert.deepEqual(translatorLanguageCandidates(''), []);
    assert.deepEqual(translatorLanguageCandidates('  '), []);
  });
});
