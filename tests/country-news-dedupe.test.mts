import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dedupeHeadlines,
  normalizeHeadlineKey,
} from '../src/components/CountryDeepDivePanel-news-utils.ts';
import type { NewsItem } from '../src/types/index.ts';

function h(
  title: string,
  source: string,
  pubDate: string = '2026-04-12T00:00:00Z',
  tier?: number,
): NewsItem {
  const item: NewsItem = {
    title,
    link: `https://example.com/${encodeURIComponent(title)}::${source}`,
    source,
    pubDate: new Date(pubDate),
    isAlert: false,
  } as NewsItem;
  if (typeof tier === 'number') item.tier = tier;
  return item;
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

  it('returns empty string for titles with only short words (fallback handled by dedupeHeadlines)', () => {
    assert.equal(normalizeHeadlineKey('a of in'), '');
  });

  it('decodes HTML entities so encoded and plain titles normalize the same way', () => {
    const a = normalizeHeadlineKey('AT&amp;T announces new tower buildout');
    const b = normalizeHeadlineKey('AT&T announces new tower buildout');
    assert.equal(a, b);
  });
});

describe('dedupeHeadlines', () => {
  it('collapses same-story items from different sources and records extras', () => {
    const items = [
      h('Pentagon, FAA sign agreement on anti-drone laser system near Mexico', 'Military Times', '2026-04-12T00:00:00Z', 2),
      h('Pentagon FAA Sign Agreement on Anti-Drone Laser System Near Mexico', 'DefenseOne', '2026-04-12T00:00:00Z', 3),
      h('Unrelated headline about shipping delays in the Gulf', 'Reuters', '2026-04-12T00:00:00Z', 1),
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

  it('never drops items whose normalized key is empty (two-letter-only titles)', () => {
    const items = [
      h('UK PM in US', 'BBC'),
      h('US-EU in talks', 'FT'),
    ];
    const out = dedupeHeadlines(items);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.item.title, 'UK PM in US');
    assert.equal(out[1]!.item.title, 'US-EU in talks');
  });

  it('treats AT&T and AT&amp;T as the same story', () => {
    const items = [
      h('AT&T expands fiber rollout across the Southeast', 'Bloomberg'),
      h('AT&amp;T expands fiber rollout across the Southeast', 'SomeBlog'),
    ];
    const out = dedupeHeadlines(items);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.extraSources.length, 1);
  });

  it('caller re-sort by primary positions the displayed card, not the first-seen duplicate', () => {
    // Repro: A and B are duplicates. A is newer + higher-severity + tier 4 (low quality),
    // B is older + lower-severity + tier 1 (Reuters). C is unrelated, medium severity.
    // dedupeHeadlines picks B (tier 1) as primary for the A/B group. The caller must re-sort
    // by the chosen primary's severity/time; otherwise the group stays anchored at A's
    // pre-dedupe position and slice(0, N) picks the wrong cards.
    type Sev = 'high' | 'medium' | 'low';
    const SEV: Record<Sev, number> = { low: 0, medium: 1, high: 2 };
    const mk = (title: string, source: string, t: string, tier: number, sev: Sev) => {
      const it = h(title, source, t, tier) as NewsItem & { __sev: Sev };
      it.__sev = sev;
      return it;
    };

    const A = mk('Sanctions package advances in Brussels', 'RandoBlog', '2026-04-12T12:00:00Z', 4, 'high');
    const B = mk('Sanctions package advances in Brussels', 'Reuters', '2026-04-12T09:00:00Z', 1, 'low');
    const C = mk('Shipping lanes reopen near Hormuz', 'AP', '2026-04-12T10:00:00Z', 1, 'medium');

    const compare = (a: NewsItem, b: NewsItem) => {
      const sa = SEV[(a as NewsItem & { __sev: Sev }).__sev];
      const sb = SEV[(b as NewsItem & { __sev: Sev }).__sev];
      if (sb !== sa) return sb - sa;
      return new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime();
    };

    const sorted = [A, B, C].sort(compare);
    const deduped = dedupeHeadlines(sorted).sort((x, y) => compare(x.item, y.item));

    assert.equal(deduped.length, 2);
    // B (primary chosen for A/B group) is 'low', C is 'medium' — C must come first now.
    assert.equal(deduped[0]!.item.source, 'AP');
    assert.equal(deduped[1]!.item.source, 'Reuters');
    assert.deepEqual(deduped[1]!.extraSources, ['RandoBlog']);
  });

  it('picks the highest-tier source as primary even when a lower-tier item appears first', () => {
    // Lower tier number = better source. T4 arrives first/newer, T1 arrives second/older.
    const items = [
      h('Sanctions package advances in Brussels against major bank', 'RandoBlog', '2026-04-12T12:00:00Z', 4),
      h('Sanctions package advances in Brussels against major bank', 'Reuters', '2026-04-12T09:00:00Z', 1),
    ];
    const out = dedupeHeadlines(items);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.item.source, 'Reuters');
    assert.deepEqual(out[0]!.extraSources, ['RandoBlog']);
  });
});
