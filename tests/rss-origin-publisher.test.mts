/**
 * #6430 — the RSS <source> element names the originating publisher, and the
 * digest's corroboration counts must prefer it over the feed label.
 *
 * Google News feeds back 154 of the 366 server digest labels and stamp
 * <source url="...">Name</source> per item. Before this, parseRssXml dropped
 * the element and stamped `item.source = feed.name`, so a Reuters wire
 * arriving through the "Oil & Gas" keyword feed and through "Reuters Energy"
 * counted as two publishers — cross-publisher syndication was the documented
 * known limit of #6428's family counting.
 *
 * `item.source` itself is deliberately untouched: it is what the UI credits,
 * links, and tiers. Only the corroboration counts read originPublisher.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publisherFamilyFor } from '../shared/publisher-families.js';
import { assignStoryIdentity } from '../server/worldmonitor/news/v1/dedup.mjs';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest.ts';

const {
  parseRssXml,
  computeEntityCorroborationSignals,
  computeItemCredibilityScore,
} = __testing__;

const FEED = { url: 'https://news.google.com/rss/search?q=oil', name: 'Oil & Gas', lang: 'en' };

function rss(itemsXml: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel>${itemsXml}</channel></rss>`;
}

describe('parseRssXml carries the RSS <source> element (#6430)', () => {
  it('extracts the originating publisher, entity-decoded, leaving item.source as the feed label', () => {
    const xml = rss(`<item>
      <title>Oil prices climb as supply concerns mount</title>
      <link>https://example.com/a</link>
      <pubDate>Tue, 07 Jul 2026 12:00:00 GMT</pubDate>
      <source url="https://www.spglobal.com">S&amp;P Global</source>
    </item>`);
    const parsed = parseRssXml(xml, FEED, 'full');
    assert.ok(parsed && parsed.items.length === 1);
    assert.equal(parsed.items[0]!.originPublisher, 'S&P Global');
    assert.equal(parsed.items[0]!.source, 'Oil & Gas');
  });

  it('stamps an empty originPublisher when the element is absent', () => {
    const xml = rss(`<item>
      <title>Oil prices climb as supply concerns mount</title>
      <link>https://example.com/a</link>
      <pubDate>Tue, 07 Jul 2026 12:00:00 GMT</pubDate>
    </item>`);
    const parsed = parseRssXml(xml, FEED, 'full');
    assert.ok(parsed && parsed.items.length === 1);
    assert.equal(parsed.items[0]!.originPublisher, '');
  });

  it('never reads Atom <source>, which is a metadata container, not a name', () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>Oil prices climb as supply concerns mount</title>
      <link href="https://example.com/a"/>
      <published>2026-07-07T12:00:00Z</published>
      <source><title>Republished Origin Feed</title><id>urn:x</id></source>
    </entry></feed>`;
    const parsed = parseRssXml(xml, FEED, 'full');
    assert.ok(parsed && parsed.items.length === 1);
    assert.equal(parsed.items[0]!.originPublisher, '');
  });
});

describe('publisherFamilyFor resolves curated publisher names (#6430)', () => {
  it('folds an origin NAME into the family of the labels it syndicates through', () => {
    assert.equal(publisherFamilyFor('Reuters'), publisherFamilyFor('Reuters Energy'));
    assert.equal(publisherFamilyFor('Associated Press'), publisherFamilyFor('AP News'));
    assert.equal(publisherFamilyFor('associated press'), publisherFamilyFor('AP News'));
  });

  it('keeps unknown origin names as their own singleton family (fail closed)', () => {
    assert.equal(publisherFamilyFor('Some Independent Blog'), 'label:some independent blog');
  });

  it('leaves feed-label resolution unchanged', () => {
    assert.equal(publisherFamilyFor('Reuters World'), 'reuters');
    assert.equal(publisherFamilyFor('BBC Persian'), publisherFamilyFor('BBC World'));
    assert.equal(publisherFamilyFor('Brand New Feed'), 'label:brand new feed');
  });
});

describe('credibility scoring prefers canonical publisher identity (#6597)', () => {
  it('scores configured Reuters aliases and syndicated Reuters items as Reuters', () => {
    assert.equal(
      computeItemCredibilityScore({ source: 'Reuters Asia', originPublisher: '' }, 1),
      84,
    );
    assert.equal(
      computeItemCredibilityScore({ source: 'Oil & Gas', originPublisher: 'Reuters' }, 1),
      84,
    );
  });

  it('applies the high-risk cap to state media syndicated through a generic feed', () => {
    assert.ok(
      computeItemCredibilityScore({ source: 'Oil & Gas', originPublisher: 'RT' }, 5) <= 40,
    );
  });
});

describe('story-identity corroboration prefers originPublisher (#6430)', () => {
  const TITLE_A = 'Missile attack kills troops in border strike officials say';
  const TITLE_B = 'Missile attack kills troops in border strike officials add';

  it('one wire under a keyword feed and its own feed counts as ONE publisher', async () => {
    const items = [
      { title: TITLE_A, source: 'Oil & Gas', originPublisher: 'Reuters', publishedAt: 1 },
      { title: TITLE_B, source: 'Reuters Energy', originPublisher: '', publishedAt: 2 },
    ];
    const assignment = await assignStoryIdentity(items, (t: string) => t.toLowerCase(), async (t: string) => t);
    assert.equal(assignment.get(items[0]!)!.corroborationCount, 1);
  });

  it('the same pair WITHOUT origin attribution still counts two — the pre-#6430 inflation', async () => {
    const items = [
      { title: TITLE_A, source: 'Oil & Gas', originPublisher: '', publishedAt: 1 },
      { title: TITLE_B, source: 'Reuters Energy', originPublisher: '', publishedAt: 2 },
    ];
    const assignment = await assignStoryIdentity(items, (t: string) => t.toLowerCase(), async (t: string) => t);
    assert.equal(assignment.get(items[0]!)!.corroborationCount, 2);
  });

  it('genuinely independent origins through one keyword feed count in full', async () => {
    const items = [
      { title: TITLE_A, source: 'Oil & Gas', originPublisher: 'Reuters', publishedAt: 1 },
      { title: TITLE_B, source: 'Oil & Gas', originPublisher: 'Al Jazeera', publishedAt: 2 },
    ];
    const assignment = await assignStoryIdentity(items, (t: string) => t.toLowerCase(), async (t: string) => t);
    assert.equal(assignment.get(items[0]!)!.corroborationCount, 2);
  });
});

describe('entity corroboration prefers originPublisher (#6430)', () => {
  const now = 1_745_000_000_000;
  const base = {
    link: '',
    isAlert: false,
    level: 'info',
    category: 'world',
    confidence: 0,
    classSource: 'keyword',
    importanceScore: 0,
    corroborationCount: 1,
    entityCorroborationCount: 0,
    lang: 'en',
    description: '',
    isOpinion: false,
    isFeelGood: false,
    isEphemeralLiveCoverage: false,
    tickers: [],
  };

  type EntityItems = Parameters<typeof computeEntityCorroborationSignals>[0];

  it('one wire under two labels emits no signal; two origins do', () => {
    const oneWire = [
      { ...base, source: 'Oil & Gas', originPublisher: 'Reuters', title: 'US and Iran close deal to ease Hormuz tensions', titleHash: 'h-1', publishedAt: now },
      { ...base, source: 'Reuters Energy', originPublisher: '', title: 'Iran deal could calm oil markets after Hormuz alarm', titleHash: 'h-2', publishedAt: now },
    ] as unknown as EntityItems;
    assert.equal(
      computeEntityCorroborationSignals(oneWire, now).get('h-1'),
      undefined,
      'a Reuters wire syndicated through a keyword feed must not corroborate Reuters',
    );

    const twoPublishers = [
      { ...base, source: 'Oil & Gas', originPublisher: 'Reuters', title: 'US and Iran close deal to ease Hormuz tensions', titleHash: 'h-1', publishedAt: now },
      { ...base, source: 'Oil & Gas', originPublisher: 'Al Jazeera', title: 'Iran deal could calm oil markets after Hormuz alarm', titleHash: 'h-2', publishedAt: now },
    ] as unknown as EntityItems;
    assert.deepEqual(computeEntityCorroborationSignals(twoPublishers, now).get('h-1'), {
      sourceCount: 2,
      tier12SourceCount: 0,
    });
  });
});
