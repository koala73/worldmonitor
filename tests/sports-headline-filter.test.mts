import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NewsItem } from '@/types';
import { filterSportsHeadlineNoise, isOffTopicSportsPoliticalHeadline } from '@/services/sports-headline-filter';

function makeItem(title: string, source = 'Reuters Sports'): NewsItem {
  return {
    source,
    title,
    link: 'https://example.com/story',
    pubDate: new Date('2026-04-13T08:00:00Z'),
    isAlert: false,
    threat: {
      level: 'low',
      category: 'general',
      confidence: 0.3,
      source: 'keyword',
    },
  };
}

describe('sports headline noise filter', () => {
  it('flags political headlines that lack sports context', () => {
    const item = makeItem('Election campaign enters final week as parliament debates coalition plan');
    assert.equal(isOffTopicSportsPoliticalHeadline(item), true);
  });

  it('keeps sports headlines even when political words appear', () => {
    const item = makeItem('FIFA president confirms World Cup qualifying format');
    assert.equal(isOffTopicSportsPoliticalHeadline(item), false);
  });

  it('removes only off-topic political items', () => {
    const items = [
      makeItem('NBA playoff bracket tightens after dramatic game seven'),
      makeItem('Government unveils new election policy ahead of national vote'),
      makeItem('Champions League quarter-final draw sets up major clash'),
    ];

    const filtered = filterSportsHeadlineNoise(items);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every((item) => !item.title.includes('Government unveils')));
  });
});
