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
    assert.equal(parsed.items[0]!.originPublisherTrusted, true);
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
    assert.equal(parsed.items[0]!.originPublisherTrusted, true);
  });

  it('does not trust RSS <source> from an ordinary configured feed', () => {
    const xml = rss(`<item>
      <title>Oil prices climb as supply concerns mount</title>
      <link>https://example.com/a</link>
      <pubDate>Tue, 07 Jul 2026 12:00:00 GMT</pubDate>
      <source>Invented Outlet</source>
    </item>`);
    const parsed = parseRssXml(xml, { url: 'https://ordinary.example/rss.xml', name: 'Ordinary Feed' }, 'full');
    assert.ok(parsed && parsed.items.length === 1);
    assert.equal(parsed.items[0]!.originPublisher, 'Invented Outlet');
    assert.equal(parsed.items[0]!.originPublisherTrusted, false);
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
    assert.equal(parsed.items[0]!.originPublisherTrusted, false);
  });
});

describe('parseRssXml publisher-link gate (#8398)', () => {
  it('blanks a digest link that leaves its publisher domain while keeping the title signal', () => {
    const xml = rss(`<item>
      <title>Oil prices climb as supply concerns mount</title>
      <link>https://evil.example/phish</link>
      <pubDate>Tue, 07 Jul 2026 12:00:00 GMT</pubDate>
      <source url="https://www.spglobal.com">S&amp;P Global</source>
    </item>`);
    const parsed = parseRssXml(xml, FEED, 'full');
    assert.ok(parsed && parsed.items.length === 1);
    assert.equal(parsed.items[0]!.link, '');
    // Title signal survives: corroboration/brief still see the story.
    assert.equal(parsed.items[0]!.title, 'Oil prices climb as supply concerns mount');
  });

  it('keeps a digest link on the trusted origin publisher domain', () => {
    const xml = rss(`<item>
      <title>Oil prices climb as supply concerns mount</title>
      <link>https://www.spglobal.com/commodityinsights/en/market-insights/x</link>
      <pubDate>Tue, 07 Jul 2026 12:00:00 GMT</pubDate>
      <source url="https://www.spglobal.com">S&amp;P Global</source>
    </item>`);
    const parsed = parseRssXml(xml, FEED, 'full');
    assert.ok(parsed && parsed.items.length === 1);
    assert.equal(parsed.items[0]!.link, 'https://www.spglobal.com/commodityinsights/en/market-insights/x');
  });

  it('keeps a digest link on the feed URL host', () => {
    const direct = { url: 'https://feeds.npr.org/1001/rss.xml', name: 'NPR News', lang: 'en' };
    const xml = rss(`<item>
      <title>NPR headline about a newsworthy event</title>
      <link>https://feeds.npr.org/story/x</link>
      <pubDate>Tue, 07 Jul 2026 12:00:00 GMT</pubDate>
    </item>`);
    const parsed = parseRssXml(xml, direct, 'full');
    assert.ok(parsed && parsed.items.length === 1);
    assert.equal(parsed.items[0]!.link, 'https://feeds.npr.org/story/x');
  });

  it('keeps a WSJ digest link on the publisher apex, not the delivery host (#8398 review)', () => {
    // The WSJ feed URL is a Dow Jones delivery host
    // (feeds.content.dowjones.io) but item links point at wsj.com. The
    // feed-host leg alone would blank every WSJ link; the domain-only
    // 'wsj' family carries the apex allowance.
    const wsj = { url: 'https://feeds.content.dowjones.io/public/rss/RSSUSnews', name: 'Wall Street Journal', lang: 'en' };
    const xml = rss(`<item>
      <title>Markets rally on trade optimism</title>
      <link>https://www.wsj.com/articles/markets-rally-x</link>
      <pubDate>Tue, 07 Jul 2026 12:00:00 GMT</pubDate>
    </item>`);
    const parsed = parseRssXml(xml, wsj, 'full');
    assert.ok(parsed && parsed.items.length === 1);
    assert.equal(parsed.items[0]!.link, 'https://www.wsj.com/articles/markets-rally-x');
  });

  it('drops a country-pool item whose link leaves its publisher domain', () => {
    // Six same-host items: five fill the digest window, the sixth lands in
    // the country pool, then the hostile seventh is dropped by the
    // country-pool branch of the gate.
    const good = (n: number) =>
      `<item><title>Headline ${n} about Kenya talks</title><link>https://feeds.npr.org/kenya-${n}</link><pubDate>Tue, 07 Jul 2026 12:00:00 GMT</pubDate></item>`;
    const xml = rss(
      good(1) + good(2) + good(3) + good(4) + good(5) + good(6)
        + `<item><title>Late hostile headline about Kenya talks</title><link>https://evil.example/phish</link><pubDate>Tue, 07 Jul 2026 12:00:00 GMT</pubDate></item>`,
    );
    const direct = { url: 'https://feeds.npr.org/1001/rss.xml', name: 'NPR News', lang: 'en' };
    const parsed = parseRssXml(xml, direct, 'full');
    assert.ok(parsed);
    assert.deepEqual((parsed.countryItems ?? []).map(item => item.link), [
      'https://feeds.npr.org/kenya-6',
    ]);
  });

  it('does not let an untrusted RSS <source> attest a foreign link', () => {
    const xml = rss(`<item>
      <title>Oil prices climb as supply concerns mount</title>
      <link>https://www.spglobal.com/x</link>
      <pubDate>Tue, 07 Jul 2026 12:00:00 GMT</pubDate>
      <source>S&amp;P Global</source>
    </item>`);
    const parsed = parseRssXml(
      xml,
      { url: 'https://ordinary.example/rss.xml', name: 'Ordinary Feed' },
      'full',
    );
    assert.ok(parsed && parsed.items.length === 1);
    // The untrusted <source> cannot self-attest spglobal.com, and the feed
    // host (ordinary.example) does not match either — link is blanked.
    assert.equal(parsed.items[0]!.link, '');
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
      computeItemCredibilityScore({ source: 'Oil & Gas', originPublisher: 'Reuters', originPublisherTrusted: true }, 1),
      84,
    );
  });

  it('applies the high-risk cap to state media syndicated through a generic feed', () => {
    assert.ok(
      computeItemCredibilityScore({ source: 'Oil & Gas', originPublisher: 'RT', originPublisherTrusted: true }, 5) <= 40,
    );
  });
});

describe('story-identity corroboration prefers originPublisher (#6430)', () => {
  const TITLE_A = 'Missile attack kills troops in border strike officials say';
  const TITLE_B = 'Missile attack kills troops in border strike officials add';

  it('one wire under a keyword feed and its own feed counts as ONE publisher', async () => {
    const items = [
      { title: TITLE_A, source: 'Oil & Gas', originPublisher: 'Reuters', originPublisherTrusted: true, publishedAt: 1 },
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
      { title: TITLE_A, source: 'Oil & Gas', originPublisher: 'Reuters', originPublisherTrusted: true, publishedAt: 1 },
      { title: TITLE_B, source: 'Oil & Gas', originPublisher: 'Al Jazeera', originPublisherTrusted: true, publishedAt: 2 },
    ];
    const assignment = await assignStoryIdentity(items, (t: string) => t.toLowerCase(), async (t: string) => t);
    assert.equal(assignment.get(items[0]!)!.corroborationCount, 2);
  });

  it('ignores invented origin labels from one feed, while genuine feed labels corroborate', async () => {
    const invented = [
      { title: TITLE_A, source: 'Farm A', originPublisher: 'Fabricated One', publishedAt: 1 },
      { title: TITLE_B, source: 'Farm A', originPublisher: 'Fabricated Two', publishedAt: 2 },
    ];
    const inventedAssignment = await assignStoryIdentity(
      invented,
      (t: string) => t.toLowerCase(),
      async (t: string) => t,
    );
    assert.equal(
      inventedAssignment.get(invented[0]!)!.corroborationCount,
      1,
      'one server feed cannot manufacture corroboration with RSS <source> labels',
    );

    const genuine = [
      { title: TITLE_A, source: 'Reuters World', originPublisher: '', publishedAt: 1 },
      { title: TITLE_B, source: 'BBC World', originPublisher: '', publishedAt: 2 },
    ];
    const genuineAssignment = await assignStoryIdentity(
      genuine,
      (t: string) => t.toLowerCase(),
      async (t: string) => t,
    );
    assert.equal(
      genuineAssignment.get(genuine[0]!)!.corroborationCount,
      2,
      'two independently configured feeds still corroborate',
    );
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
      { ...base, source: 'Oil & Gas', originPublisher: 'Reuters', originPublisherTrusted: true, title: 'US and Iran close deal to ease Hormuz tensions', titleHash: 'h-1', publishedAt: now },
      { ...base, source: 'Reuters Energy', originPublisher: '', title: 'Iran deal could calm oil markets after Hormuz alarm', titleHash: 'h-2', publishedAt: now },
    ] as unknown as EntityItems;
    assert.equal(
      computeEntityCorroborationSignals(oneWire, now).get('h-1'),
      undefined,
      'a Reuters wire syndicated through a keyword feed must not corroborate Reuters',
    );

    const twoPublishers = [
      { ...base, source: 'Oil & Gas', originPublisher: 'Reuters', originPublisherTrusted: true, title: 'US and Iran close deal to ease Hormuz tensions', titleHash: 'h-1', publishedAt: now },
      { ...base, source: 'Oil & Gas', originPublisher: 'Al Jazeera', originPublisherTrusted: true, title: 'Iran deal could calm oil markets after Hormuz alarm', titleHash: 'h-2', publishedAt: now },
    ] as unknown as EntityItems;
    assert.deepEqual(computeEntityCorroborationSignals(twoPublishers, now).get('h-1'), {
      sourceCount: 2,
      tier12SourceCount: 0,
    });
  });
});
