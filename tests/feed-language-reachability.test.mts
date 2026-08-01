/**
 * Unit tests for reachable-feed filtering (src/services/feed-language.ts).
 *
 * `fetchCategoryFeeds` silently drops feeds whose declared `lang` is not the
 * current UI language. That is invisible for a preset category — it is
 * digest-backed and the server does not language-filter — but it is load-bearing
 * for a CUSTOM category, which rotates a capped window through its sources and
 * prints the resulting coverage on its badge (#5873).
 *
 * If either the rotation or the badge counts the ENABLED set instead of the
 * REACHABLE one, the fix regresses into a new version of the bug it fixes: the
 * `europe` category declares 47 feeds of which only 6 are fetchable for an
 * English user, so most twenty-minute cycles would fetch nothing at all and the
 * badge would read "6/47 sources" forever while claiming to rotate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { filterFeedsByLanguage, isFeedInLanguage } from '../src/services/feed-language.ts';
import { selectRotatingFeedWindow } from '../src/app/news-feed-rotation.ts';
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
});

describe('rotation over the reachable set (the #5873 regression guard)', () => {
  // Shaped like the real `europe` category: a handful of universal feeds buried
  // in a long tail of language-specific ones.
  const europeish: Feed[] = [
    feed('Reuters Europe'),
    feed('Tagesschau', 'de'),
    feed('Bild', 'de'),
    feed('Der Spiegel', 'de'),
    feed('El Pais', 'es'),
    feed('El Mundo', 'es'),
    feed('ANSA', 'it'),
    feed('Le Monde', 'fr'),
    feed('BBC Europe'),
    feed('Politico EU'),
  ];

  it('rotating the ENABLED set spends most cycles fetching nothing', () => {
    // The failure this guards against. Documents the broken behavior so the
    // assertion below has something to be measured against.
    let emptyCycles = 0;
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const window = selectRotatingFeedWindow(europeish, 3, cycle);
      if (filterFeedsByLanguage(window, 'en').length === 0) emptyCycles += 1;
    }
    assert.ok(emptyCycles > 0, 'fixture must actually exhibit the wasted-cycle problem');
  });

  it('rotating the REACHABLE set fetches real feeds every cycle', () => {
    const reachable = filterFeedsByLanguage(europeish, 'en');
    assert.equal(reachable.length, 3);

    for (let cycle = 0; cycle < 6; cycle += 1) {
      const window = selectRotatingFeedWindow(reachable, 3, cycle);
      assert.equal(
        window.length,
        3,
        `cycle ${cycle} must spend its whole budget on feeds the fetch will actually attempt`,
      );
      assert.equal(
        filterFeedsByLanguage(window, 'en').length,
        3,
        `cycle ${cycle} selected a feed the fetch would silently discard`,
      );
    }
  });

  it('the reachable set is the honest denominator for the coverage badge', () => {
    // "3/3 sources" (silent, full coverage) rather than "3/10 sources" pinned
    // forever against seven feeds this user can never receive.
    const reachable = filterFeedsByLanguage(europeish, 'en');
    assert.equal(reachable.length, 3);
    assert.notEqual(reachable.length, europeish.length);
  });

  it('a German user reaches the German feeds the English user cannot', () => {
    const reachable = filterFeedsByLanguage(europeish, 'de');
    assert.deepEqual(
      reachable.map(f => f.name),
      ['Reuters Europe', 'Tagesschau', 'Bild', 'Der Spiegel', 'BBC Europe', 'Politico EU'],
    );

    const seen = new Set<string>();
    for (let cycle = 0; cycle < Math.ceil(reachable.length / 3); cycle += 1) {
      for (const f of selectRotatingFeedWindow(reachable, 3, cycle)) seen.add(f.name);
    }
    assert.equal(seen.size, reachable.length, 'rotation must still reach every reachable source');
  });
});
