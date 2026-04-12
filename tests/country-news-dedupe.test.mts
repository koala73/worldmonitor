import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dedupeHeadlines,
  normalizeHeadlineKey,
} from '../src/components/CountryDeepDivePanel-news-utils.ts';
import type { NewsItem } from '../src/types/index.ts';

function h(title: string, source: string, pubDate = '2026-04-12T00:00:00Z'): NewsItem {
  return {
    title,
    link: `https://example.com/${encodeURIComponent(title)}`,
    source,
    pubDate,
  } as NewsItem;
}

describe('normalizeHeadlineKey', () => {
  it('produces identical keys for near-duplicate titles across punctuation and casing', () => {
    const a = normalizeHeadlineKey('Pentagon, FAA sign agreement on deploying anti-drone laser system near Mexico');
    const b = normalizeHeadlineKey('Pentagon FAA Sign Agreement On Deploying Anti Drone Laser System Near Mexico');
    assert.equal(a, b);
    assert.ok(a.length > 0);
  });

  it('strips diacritics so accented duplicates collapse', () => {
    const a = normalizeHeadlineKey('México reaches new trade pact');
    const b = normalizeHeadlineKey('Mexico reaches new trade pact');
    assert.equal(a, b);
  });

  it('returns empty string for titles with only short words', () => {
    assert.equal(normalizeHeadlineKey('a of in'), '');
  });
});

describe('dedupeHeadlines', () => {
  it('collapses same-story items from different sources and records extras', () => {
    const items = [
      h('Pentagon, FAA sign agreement on anti-drone laser system near Mexico', 'Military Times'),
      h('Pentagon FAA Sign Agreement on Anti-Drone Laser System Near Mexico', 'DefenseOne'),
      h('Unrelated headline about shipping delays in the Gulf', 'Reuters'),
    ];
    const out = dedupeHeadlines(items);
    assert.equal(out.length, 2);
    const primary = out[0]!;
    assert.equal(primary.item.source, 'Military Times');
    assert.deepEqual(primary.extraSources, ['DefenseOne']);
    assert.equal(out[1]!.extraSources.length, 0);
  });

  it('does not count the same source twice in extras', () => {
    const items = [
      h('Shared headline text here', 'SourceA'),
      h('Shared headline text here', 'SourceA'),
      h('Shared headline text here', 'SourceB'),
    ];
    const [only] = dedupeHeadlines(items);
    assert.deepEqual(only!.extraSources, ['SourceB']);
  });
});
