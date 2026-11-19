/**
 * Unit tests for the cross-edition panel merge (src/app/news-source-merge.ts).
 *
 * A category placed in several editions gets items from each edition's
 * digest. The merge dedupes them and caps the panel SOURCE-FAIR, so one
 * fast-publishing source cannot crowd the others out.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mergeSourceFairNewsItems } from '../src/app/news-source-merge.ts';
import type { NewsItem } from '../src/types/index.ts';

const FEEDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

function item(source: string, minutesAgo: number, id = `${source}-${minutesAgo}`): NewsItem {
  return {
    source,
    title: `${source} headline ${id}`,
    link: `https://example.test/${id}`,
    pubDate: new Date(Date.UTC(2026, 6, 30, 12, 0, 0) - minutesAgo * 60_000),
    isAlert: false,
  };
}

describe('mergeSourceFairNewsItems', () => {
  const enabled = new Set(FEEDS);

  it('orders the merged result newest-first for display', () => {
    const merged = mergeSourceFairNewsItems([item('a', 30), item('d', 1), item('e', 90)], { maxItems: 40, enabledSources: enabled });
    const ages = merged.map(i => i.pubDate.getTime());
    assert.deepEqual(ages, [...ages].sort((x, y) => y - x));
  });

  it('dedupes an item two edition digests both carry', () => {
    const merged = mergeSourceFairNewsItems([item('a', 30, 'shared'), item('a', 30, 'shared')], {
      maxItems: 40,
      enabledSources: enabled,
    });
    assert.equal(merged.length, 1);
  });

  it('falls back to source+title when an item carries no link', () => {
    const a: NewsItem = { ...item('a', 5), link: '' };
    const b: NewsItem = { ...item('a', 5), link: '' };
    const merged = mergeSourceFairNewsItems([a, b], { maxItems: 40, enabledSources: enabled });
    assert.equal(merged.length, 1, 'link-less duplicates must not stack up');
  });

  it('drops items from a source the user disabled', () => {
    const merged = mergeSourceFairNewsItems([item('a', 1), item('d', 2)], { maxItems: 40, enabledSources: new Set(['d']) });
    assert.deepEqual(merged.map(i => i.source), ['d']);
  });

  it('bounds the merged set', () => {
    const items = [
      ...Array.from({ length: 60 }, (_, i) => item('a', i + 100, `old-${i}`)),
      ...Array.from({ length: 60 }, (_, i) => item('d', i, `new-${i}`)),
    ];
    assert.equal(mergeSourceFairNewsItems(items, { maxItems: 40, enabledSources: enabled }).length, 40);
  });

  it('gives every source a share of the cap instead of evicting by age alone', () => {
    // One edition's source publishes faster than every other; a newest-first
    // cap would show only it.
    const items = [
      ...Array.from({ length: 20 }, (_, i) => item('a', 200 + i, `a-${i}`)),
      ...Array.from({ length: 20 }, (_, i) => item('b', 200 + i, `b-${i}`)),
      ...Array.from({ length: 40 }, (_, i) => item('d', i, `d-${i}`)),
    ];

    const merged = mergeSourceFairNewsItems(items, { maxItems: 12, enabledSources: enabled });

    assert.equal(merged.length, 12);
    assert.deepEqual([...new Set(merged.map(i => i.source))].sort(), ['a', 'b', 'd']);
  });

  it('ranks undated items last without dropping them', () => {
    // effectivePubDateMs returns 0 for pubDateMissing items. They must still
    // render: the display-time range filter decides whether they are shown.
    const undated: NewsItem = { ...item('a', 0, 'undated'), pubDateMissing: true };
    const merged = mergeSourceFairNewsItems([undated, item('b', 500)], { maxItems: 40, enabledSources: enabled });
    assert.equal(merged.length, 2);
    assert.equal(merged[1]?.link, undated.link, 'undated items must not claim freshness');
  });

  it('is empty for a non-positive cap', () => {
    assert.deepEqual(mergeSourceFairNewsItems([item('a', 1)], { maxItems: 0, enabledSources: enabled }), []);
  });
});
