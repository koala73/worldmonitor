/**
 * Unit tests for the custom-news-category rotation + merge primitives
 * (src/app/news-feed-rotation.ts).
 *
 * Regression motivation — the concrete bug these fix (#5873):
 *
 * #5376 capped every per-feed fallback at `perFeedFallbackCategoryFeedLimit`
 * (3 feeds), custom categories included. For a PRESET category that cap is a
 * degraded-mode ceiling — it only applies while the server digest is down. A
 * CUSTOM category (a panel the user added from another variant) is never in the
 * per-variant digest, so direct fetch is its ONLY path and the cap is its
 * steady state. `selectLimitedFeeds` is a fixed prefix — `feeds.slice(0, 3)` —
 * so feeds 4..N of a customized panel were unreachable on EVERY load and EVERY
 * refresh, while the Sources manager still listed all N as enabled.
 *
 * Two primitives fix that without changing the per-load request budget:
 *
 *   • `selectRotatingFeedWindow` advances the window by `maxFeeds` each cycle,
 *     so the same 3 requests per load eventually reach every source.
 *   • `mergeRotatedNewsItems` accumulates across cycles instead of replacing,
 *     so rotation doesn't swap the panel's contents wholesale every refresh.
 *
 * The merge's cap is SOURCE-FAIR, not pure-recency, and that is load-bearing:
 * each cycle's 3 freshly-fetched sources carry current timestamps while the
 * previously-fetched ones are frozen at their fetch time, so a pure
 * newest-first cap evicts exactly the carry-over the merge exists to keep and
 * coverage plateaus instead of climbing. See the dedicated test below.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  countRepresentedSources,
  mergeRotatedNewsItems,
  nextRotationCycle,
  selectRotatingFeedWindow,
} from '../src/app/news-feed-rotation.ts';
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

describe('selectRotatingFeedWindow', () => {
  it('returns the leading prefix on cycle 0 — the pre-rotation behavior', () => {
    assert.deepEqual(selectRotatingFeedWindow(FEEDS, 3, 0), ['a', 'b', 'c']);
  });

  it('advances the window by the cap on each cycle', () => {
    assert.deepEqual(selectRotatingFeedWindow(FEEDS, 3, 1), ['d', 'e', 'f']);
    assert.deepEqual(selectRotatingFeedWindow(FEEDS, 3, 2), ['g', 'h', 'i']);
  });

  it('wraps around the end of the feed list rather than truncating', () => {
    // Cycle 3 starts at index 9 of 10 — the window must wrap, not return a
    // short slice, or the last cycle would fetch fewer feeds than the cap.
    assert.deepEqual(selectRotatingFeedWindow(FEEDS, 3, 3), ['j', 'a', 'b']);
  });

  it('always selects exactly the cap when the category has more feeds', () => {
    for (let cycle = 0; cycle < 25; cycle += 1) {
      assert.equal(
        selectRotatingFeedWindow(FEEDS, 3, cycle).length,
        3,
        `cycle ${cycle} must keep the per-load request budget at the cap`,
      );
    }
  });

  it('reaches every source within ceil(total / cap) cycles', () => {
    // The whole point of #5873: feeds 4..N must stop being unreachable.
    const seen = new Set<string>();
    for (let cycle = 0; cycle < Math.ceil(FEEDS.length / 3); cycle += 1) {
      for (const feed of selectRotatingFeedWindow(FEEDS, 3, cycle)) seen.add(feed);
    }
    assert.deepEqual([...seen].sort(), [...FEEDS].sort());
  });

  it('reaches every source for feed counts that share a factor with the cap', () => {
    // gcd(total, cap) > 1 is the case where a naive stride can orbit a subset
    // forever. Start-at-(cycle * cap) % total still covers because each window
    // is `cap` CONSECUTIVE feeds, not a single strided pick.
    for (const total of [4, 6, 7, 8, 9, 12, 48]) {
      const feeds = Array.from({ length: total }, (_, i) => `f${i}`);
      const seen = new Set<string>();
      for (let cycle = 0; cycle < Math.ceil(total / 3); cycle += 1) {
        for (const feed of selectRotatingFeedWindow(feeds, 3, cycle)) seen.add(feed);
      }
      assert.equal(seen.size, total, `total=${total} left ${total - seen.size} source(s) unreachable`);
    }
  });

  it('returns every feed unchanged when the category is at or under the cap', () => {
    assert.deepEqual(selectRotatingFeedWindow(['a', 'b'], 3, 0), ['a', 'b']);
    assert.deepEqual(selectRotatingFeedWindow(['a', 'b'], 3, 7), ['a', 'b']);
    assert.deepEqual(selectRotatingFeedWindow(['a', 'b', 'c'], 3, 4), ['a', 'b', 'c']);
  });

  it('does not mutate or alias the caller\'s feed array', () => {
    const feeds = ['a', 'b'];
    const window = selectRotatingFeedWindow(feeds, 3, 0);
    assert.notEqual(window, feeds, 'must return a copy so a caller cannot mutate config feeds');
    assert.deepEqual(feeds, ['a', 'b']);
  });

  it('is total for degenerate inputs rather than throwing or returning holes', () => {
    assert.deepEqual(selectRotatingFeedWindow([], 3, 5), []);
    assert.deepEqual(selectRotatingFeedWindow(FEEDS, 0, 1), []);
    assert.deepEqual(selectRotatingFeedWindow(FEEDS, -2, 1), []);
    // A corrupt persisted cycle must not produce `undefined` entries.
    assert.deepEqual(selectRotatingFeedWindow(FEEDS, 3, Number.NaN), ['a', 'b', 'c']);
    assert.deepEqual(selectRotatingFeedWindow(FEEDS, 3, -1), ['h', 'i', 'j']);
  });
});

describe('nextRotationCycle', () => {
  it('advances by one', () => {
    assert.equal(nextRotationCycle(0, 10), 1);
    assert.equal(nextRotationCycle(4, 10), 5);
  });

  it('wraps at the feed count so the persisted counter stays bounded', () => {
    // `start` is `(cycle * cap) % total`, so `total` is exactly the period —
    // wrapping there keeps localStorage small without shifting the window.
    assert.equal(nextRotationCycle(9, 10), 0);
    assert.deepEqual(selectRotatingFeedWindow(FEEDS, 3, 10), selectRotatingFeedWindow(FEEDS, 3, 0));
  });

  it('recovers from a corrupt persisted value instead of propagating it', () => {
    assert.equal(nextRotationCycle(Number.NaN, 10), 0);
    assert.equal(nextRotationCycle(-3, 10), 0);
    assert.equal(nextRotationCycle(Number.POSITIVE_INFINITY, 10), 0);
    assert.equal(nextRotationCycle(2, 0), 0);
  });
});

describe('mergeRotatedNewsItems', () => {
  const enabled = new Set(FEEDS);

  it('keeps carry-over items the current cycle did not re-fetch', () => {
    const carryOver = [item('a', 30), item('b', 40)];
    const fresh = [item('d', 1), item('e', 2)];
    const merged = mergeRotatedNewsItems(carryOver, fresh, { maxItems: 40, enabledSources: enabled });
    assert.deepEqual(
      [...new Set(merged.map(i => i.source))].sort(),
      ['a', 'b', 'd', 'e'],
    );
  });

  it('orders the merged result newest-first for display', () => {
    const merged = mergeRotatedNewsItems(
      [item('a', 30)],
      [item('d', 1), item('e', 90)],
      { maxItems: 40, enabledSources: enabled },
    );
    const ages = merged.map(i => i.pubDate.getTime());
    assert.deepEqual(ages, [...ages].sort((x, y) => y - x));
  });

  it('dedupes by link, preferring the freshly fetched copy', () => {
    // The rotation window wraps, so a source IS re-fetched periodically. Its
    // second fetch carries newer enrichment (threat classification, importance
    // score) that the carry-over copy predates.
    const stale = item('a', 30, 'shared');
    const refetched: NewsItem = { ...item('a', 30, 'shared'), importanceScore: 9 };
    const merged = mergeRotatedNewsItems([stale], [refetched], {
      maxItems: 40,
      enabledSources: enabled,
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.importanceScore, 9);
  });

  it('falls back to source+title when an item carries no link', () => {
    const a: NewsItem = { ...item('a', 5), link: '' };
    const b: NewsItem = { ...item('a', 5), link: '' };
    const merged = mergeRotatedNewsItems([a], [b], { maxItems: 40, enabledSources: enabled });
    assert.equal(merged.length, 1, 'link-less duplicates must not stack up across cycles');
  });

  it('drops carry-over from a source the user has since disabled', () => {
    // ctx.disabledSources is what the Sources manager mutates; a merge that
    // ignored it would keep a switched-off source on screen indefinitely,
    // which is the same "settings say one thing, panel does another" defect
    // #5873 is about, pointed the other way.
    const merged = mergeRotatedNewsItems(
      [item('a', 30), item('b', 40)],
      [item('d', 1)],
      { maxItems: 40, enabledSources: new Set(['b', 'd']) },
    );
    assert.deepEqual([...new Set(merged.map(i => i.source))].sort(), ['b', 'd']);
  });

  it('drops freshly fetched items from a disabled source too', () => {
    const merged = mergeRotatedNewsItems(
      [],
      [item('a', 1), item('d', 2)],
      { maxItems: 40, enabledSources: new Set(['d']) },
    );
    assert.deepEqual(merged.map(i => i.source), ['d']);
  });

  it('bounds the merged set', () => {
    const carryOver = Array.from({ length: 60 }, (_, i) => item('a', i + 100, `old-${i}`));
    const fresh = Array.from({ length: 60 }, (_, i) => item('d', i, `new-${i}`));
    const merged = mergeRotatedNewsItems(carryOver, fresh, { maxItems: 40, enabledSources: enabled });
    assert.equal(merged.length, 40);
  });

  it('gives every covered source a share of the cap instead of evicting by age alone', () => {
    // THE load-bearing case. Cycle N's freshly-fetched sources always carry
    // newer timestamps than sources fetched in earlier cycles, because those
    // are frozen at their fetch time. A pure newest-first cap therefore evicts
    // precisely the carry-over the merge exists to preserve — the panel would
    // fall back to showing only the current cycle's 3 sources and coverage
    // would never climb past the cap.
    const carryOver = [
      ...Array.from({ length: 20 }, (_, i) => item('a', 200 + i, `a-${i}`)),
      ...Array.from({ length: 20 }, (_, i) => item('b', 200 + i, `b-${i}`)),
    ];
    const fresh = Array.from({ length: 40 }, (_, i) => item('d', i, `d-${i}`));

    const merged = mergeRotatedNewsItems(carryOver, fresh, { maxItems: 12, enabledSources: enabled });

    assert.equal(merged.length, 12);
    assert.deepEqual(
      [...new Set(merged.map(i => i.source))].sort(),
      ['a', 'b', 'd'],
      'every source present in the merge input must survive the cap',
    );
  });

  it('climbs to full coverage over successive rotation cycles', () => {
    // End-to-end shape of the fix: 10 sources, 3 fetched per cycle, merged
    // panel contents. Coverage must reach 10/10 and STAY there — the failure
    // mode a pure-recency cap produces is a plateau at the per-cycle cap.
    const maxItems = 40;
    let panel: NewsItem[] = [];
    const coverage: number[] = [];

    for (let cycle = 0; cycle < 6; cycle += 1) {
      const window = selectRotatingFeedWindow(FEEDS, 3, cycle);
      // Each cycle's fetch returns current-timestamped items; older cycles'
      // items keep the timestamps they were fetched with.
      const fresh = window.flatMap(source =>
        Array.from({ length: 7 }, (_, i) => item(source, i, `${source}-c${cycle}-${i}`)),
      ).map(it => ({ ...it, pubDate: new Date(it.pubDate.getTime() + cycle * 20 * 60_000) }));

      panel = mergeRotatedNewsItems(panel, fresh, { maxItems, enabledSources: enabled });
      coverage.push(countRepresentedSources(panel));
      assert.ok(panel.length <= maxItems, `cycle ${cycle} exceeded the merged cap`);
    }

    assert.deepEqual(coverage.slice(0, 4), [3, 6, 9, 10]);
    assert.deepEqual(coverage.slice(4), [10, 10], 'coverage must hold once every source is represented');
  });

  it('returns fresh items unchanged in shape when there is no carry-over', () => {
    const fresh = [item('a', 2), item('b', 1)];
    const merged = mergeRotatedNewsItems([], fresh, { maxItems: 40, enabledSources: enabled });
    assert.deepEqual(merged.map(i => i.link), [fresh[1]?.link, fresh[0]?.link]);
  });

  it('ranks undated items last without dropping them', () => {
    // effectivePubDateMs returns 0 for pubDateMissing items (the U3 false-
    // freshness contract). They must still render — the display-time range
    // filter, not the merge, is what decides whether they are shown.
    const undated: NewsItem = { ...item('a', 0, 'undated'), pubDateMissing: true };
    const merged = mergeRotatedNewsItems([], [undated, item('b', 500)], {
      maxItems: 40,
      enabledSources: enabled,
    });
    assert.equal(merged.length, 2);
    assert.equal(merged[1]?.link, undated.link, 'undated items must not claim freshness');
  });
});

describe('countRepresentedSources', () => {
  it('counts distinct sources actually present in the rendered set', () => {
    assert.equal(countRepresentedSources([item('a', 1), item('a', 2), item('b', 3)]), 2);
  });

  it('is zero for an empty panel', () => {
    assert.equal(countRepresentedSources([]), 0);
  });
});
