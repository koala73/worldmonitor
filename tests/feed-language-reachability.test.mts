/**
 * Unit tests for reachable-feed filtering (src/services/feed-language.ts).
 *
 * `fetchCategoryFeeds` silently drops feeds whose declared `lang` is not the
 * current UI language, so the desktop outage fallback caps the REACHABLE set:
 * capping the enabled set could spend the whole budget on feeds the fetch then
 * discards.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { filterFeedsByLanguage, isFeedInLanguage } from '../src/services/feed-language.ts';
import type { Feed } from '../src/types/index.ts';

const feed = (name: string, lang?: string): Feed =>
  (lang ? { name, url: `https://example.test/${name}`, lang } : { name, url: `https://example.test/${name}` });

describe('isFeedInLanguage', () => {
  it('treats a feed with no declared language as universal', () => {
    assert.equal(isFeedInLanguage(feed('Reuters'), 'en'), true);
    assert.equal(isFeedInLanguage(feed('Reuters'), 'de'), true);
  });

  it('keeps a feed whose declared language matches', () => {
    assert.equal(isFeedInLanguage(feed('Tagesschau', 'de'), 'de'), true);
  });

  it('drops a feed declared for another language', () => {
    assert.equal(isFeedInLanguage(feed('Tagesschau', 'de'), 'en'), false);
  });

  it('keeps a strategic feed declared for another language', () => {
    const strategic = {
      name: 'Polsat News',
      url: 'https://example.test/polsat-news',
      lang: 'pl',
      strategicDefault: true,
    } satisfies Feed;
    assert.equal(isFeedInLanguage(strategic, 'en'), true);
  });
});

describe('filterFeedsByLanguage', () => {
  it('keeps universal and matching feeds, in order', () => {
    const feeds = [feed('Reuters'), feed('Tagesschau', 'de'), feed('El Pais', 'es'), feed('BBC')];
    assert.deepEqual(
      filterFeedsByLanguage(feeds, 'en').map(f => f.name),
      ['Reuters', 'BBC'],
    );
    assert.deepEqual(
      filterFeedsByLanguage(feeds, 'de').map(f => f.name),
      ['Reuters', 'Tagesschau', 'BBC'],
    );
  });

  it('does not mutate the input', () => {
    const feeds = [feed('Reuters'), feed('Tagesschau', 'de')];
    filterFeedsByLanguage(feeds, 'en');
    assert.equal(feeds.length, 2);
  });

  it('returns empty when every feed belongs to another language', () => {
    assert.deepEqual(filterFeedsByLanguage([feed('Tagesschau', 'de'), feed('Bild', 'de')], 'en'), []);
  });

  it('retains strategic feeds alongside universal feeds for a mismatched language', () => {
    const strategic = {
      name: 'Yonhap News',
      url: 'https://example.test/yonhap-news',
      lang: 'ko',
      strategicDefault: true,
    } satisfies Feed;
    assert.deepEqual(
      filterFeedsByLanguage([feed('Reuters'), strategic, feed('Tagesschau', 'de')], 'en').map(f => f.name),
      ['Reuters', 'Yonhap News'],
    );
  });
});
