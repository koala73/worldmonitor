// Publishers whose feed comes from a delivery host (feeds.npr.org,
// moxie.foxnews.com, feeds.feedburner.com ...) publish their articles on
// another host. The publisher-link gate trusts the feed host and the
// publisher's curated family domains, so without a family entry every link
// from these feeds was blanked: a sweep of all 649 server feeds on
// 2026-10-28 found production serving NPR, NBC, Ars Technica and 13 others
// with no links at all.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { __testing__, toProtoItem } from '../server/worldmonitor/news/v1/list-feed-digest';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import catalog from '../shared/news-catalog.json' with { type: 'json' };
import { publisherFamilyFor, PUBLISHER_FAMILY_DOMAIN_TABLE } from '../shared/publisher-families.js';

const require = createRequire(import.meta.url);
const { gateRelayStoryLink } = require('../scripts/lib/publisher-link-relay-gate.cjs');
const { buildClassifyCandidateMap } = require('../scripts/lib/digest-stale-gate.cjs');

// Feed URL and an article link on the host each feed actually links to (live, 2026-10-28).
const DELIVERY_HOST_FEEDS = [
  ['NPR News', 'https://feeds.npr.org/1001/rss.xml', 'https://www.npr.org/2026/10/28/nx-s1-5584/story'],
  ['Fox News', 'https://moxie.foxnews.com/google-publisher/us.xml', 'https://www.foxnews.com/us/story'],
  ['Fox Business', 'https://moxie.foxbusiness.com/google-publisher/latest.xml', 'https://www.foxbusiness.com/markets/story'],
  ['NBC News', 'https://feeds.nbcnews.com/nbcnews/public/news', 'https://www.nbcnews.com/politics/story-rcna1'],
  ['NBC News', 'https://feeds.nbcnews.com/nbcnews/public/news', 'https://www.today.com/news/story-rcna2'],
  ['ABC News', 'https://feeds.abcnews.com/abcnews/topstories', 'https://abcnews.com/US/story?id=1'],
  ['Axios', 'https://api.axios.com/feed/', 'https://www.axios.com/2026/10/28/story'],
  ['NOS Nieuws', 'https://feeds.nos.nl/nosnieuwsalgemeen', 'https://nos.nl/artikel/1-story'],
  ['Ars Technica', 'https://feeds.arstechnica.com/arstechnica/technology-lab', 'https://arstechnica.com/gadgets/2026/10/story/'],
  ['Business Wire', 'https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeGVtRWA==', 'https://www.businesswire.com/news/home/1/en/'],
  ['NDTV India', 'https://feeds.feedburner.com/ndtvkhabar-latest', 'https://ndtv.in/india/story-1'],
  ['InfoQ', 'https://feed.infoq.com/', 'https://www.infoq.com/news/2026/10/story/'],
  ['Korea Times', 'https://feed.koreatimes.co.kr/k/allnews.xml', 'https://www.koreatimes.co.kr/world/20261120/story'],
  ['El Mundo', 'https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml', 'https://www.elmundo.es/espana/2026/10/28/story.html'],
  ['Die Zeit', 'https://newsfeed.zeit.de/index', 'https://www.zeit.de/politik/2026-10/story'],
  ['El País', 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada', 'https://elpais.com/espana/2026-10-28/story.html'],
  ['News24', 'https://feeds.news24.com/articles/news24/TopStories/rss', 'https://www.news24.com/news24/southafrica/news/story-20261028'],
  ['Fast Company', 'https://feeds.feedburner.com/fastcompany/headlines', 'https://www.fastcompany.com/91000000/story'],
  ['The Hacker News', 'https://feeds.feedburner.com/TheHackersNews', 'https://thehackernews.com/2026/10/story.html'],
] as const;

function rssWithLink(link: string): string {
  const pubDate = new Date(Date.now() - 3600_000).toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item>
    <title>Headline</title><link>${link}</link><pubDate>${pubDate}</pubDate></item></channel></rss>`;
}

describe('publisher-link gate: feeds served from a delivery host keep their article links', () => {
  for (const [name, url, article] of DELIVERY_HOST_FEEDS) {
    it(`${name}: ${new URL(article).hostname}`, () => {
      const result = __testing__.parseRssXml(rssWithLink(article), { name, url, lang: 'en' }, 'full');
      assert.equal(result?.items.length, 1);
      assert.equal(result!.items[0]!.link, article, 'digest keeps the link');
      assert.equal(gateRelayStoryLink(article, name), article, 'relay keeps the link');
    });
  }

  it('keeps a Tages-Anzeiger article on tagesanzeiger.ch when the feed is on the Tamedia partner host', () => {
    const feed = (catalog.feeds as Array<{ name: string; url: string; lang?: string; linkHosts?: string[] }>).find((entry) => entry.name === 'Tages-Anzeiger');
    assert.ok(feed);
    assert.equal(new URL(feed.url).hostname, 'partner-feeds.publishing.tamedia.ch');
    assert.deepEqual(feed.linkHosts, ['tagesanzeiger.ch']);
    const article = 'https://www.tagesanzeiger.ch/story-1';
    const kept = __testing__.parseRssXml(rssWithLink(article), feed, 'full');
    assert.equal(kept?.items[0]?.link, article);
    assert.equal(
      __testing__.storyTrackLinkForPersist({ link: article, source: feed.name, originPublisher: '', originPublisherTrusted: false }),
      article,
    );
    const dropped = __testing__.parseRssXml(rssWithLink('https://evil.example/story'), feed, 'full');
    assert.equal(dropped?.items[0]?.link, '');
  });

  it('still blanks a link that leaves the publisher', () => {
    const [name, url] = DELIVERY_HOST_FEEDS[0];
    const result = __testing__.parseRssXml(rssWithLink('https://evil.example/npr.org'), { name, url, lang: 'en' }, 'full');
    assert.equal(result?.items.length, 1);
    assert.equal(result!.items[0]!.link, '');
    assert.equal(gateRelayStoryLink('https://npr.org.evil.example/x', name), '');
  });
});

describe('every server feed on a delivery host names its publisher domains', () => {
  // Podcast hosts serve many shows and name no publisher; their items are
  // episodes, usually with no article link at all.
  const SHARED_PODCAST_HOSTS = new Set(['rss.libsyn.com', 'rss.art19.com', 'feeds.megaphone.fm']);
  const DELIVERY_HOST = /^(feeds?|rss|newsfeed|moxie)\./;

  it('has a curated family domain for each one', () => {
    const missing: string[] = [];
    for (const feed of catalog.feeds as Array<{ name: string; url: unknown; placements: Array<{ serverOrder?: number }> }>) {
      if (typeof feed.url !== 'string' || !/^https?:/.test(feed.url)) continue;
      if (!feed.placements.some((p) => p.serverOrder !== undefined)) continue;
      const host = new URL(feed.url).hostname.replace(/^www\./, '');
      if (!DELIVERY_HOST.test(host) || SHARED_PODCAST_HOSTS.has(host)) continue;
      const domains = (PUBLISHER_FAMILY_DOMAIN_TABLE as Record<string, string[]>)[publisherFamilyFor(feed.name)];
      if (!domains?.length) missing.push(`${feed.name} (${host})`);
    }
    assert.deepEqual(missing, [], 'add a family with the domains these publishers link to in shared/publisher-families.js and the relay gate');
  });
});

describe('publisher-link gate: a feed that lists other owners links to the hosts its catalog entry names', () => {
  // GitHub Trending's feed is on mshibanami.github.io and links to repositories
  // on github.com. github.com hosts many owners, so it cannot be a publisher
  // family domain; the catalog entry names it for this feed alone.
  const trending = (Object.values(VARIANT_FEEDS.tech ?? {}).flat() as Array<{ name: string; url: string; linkHosts?: string[] }>)
    .find((feed) => feed.name === 'GitHub Trending')!;
  const repo = 'https://github.com/owner/repo';
  const persisted = (source: string) =>
    __testing__.storyTrackLinkForPersist({ link: repo, source, originPublisher: '', originPublisherTrusted: false });

  it('the digest fetches GitHub Trending with github.com as its link host', () => {
    assert.ok(trending, 'GitHub Trending has a server placement');
    assert.deepEqual(trending.linkHosts, ['github.com']);
  });

  it('keeps a repository link from that feed, at parse and at persist', () => {
    const result = __testing__.parseRssXml(rssWithLink(repo), trending, 'tech');
    assert.equal(result!.items[0]!.link, repo);
    assert.equal(persisted(trending.name), repo);
  });

  it('blanks a link to any other host, and a github.com link from a feed without the entry', () => {
    const elsewhere = __testing__.parseRssXml(rssWithLink('https://evil.example/github.com'), trending, 'tech');
    assert.equal(elsewhere!.items[0]!.link, '');
    const unlisted = __testing__.parseRssXml(rssWithLink(repo), { name: 'Some Feed', url: trending.url }, 'tech');
    assert.equal(unlisted!.items[0]!.link, '');
    assert.equal(persisted('Some Feed'), '');
  });
});

describe('publisher-link gate: the relay sends the links the digest verified, and no others', () => {
  // The digest knows the feed host; the relay sees only the served item. A
  // publisher outside the relay's family table (Egypt Independent, 2026-11-17)
  // used to lose its link in every alert.
  const feed = { name: 'Egypt Independent', url: 'https://www.egyptindependent.com/feed/', lang: 'en' };
  const article = 'https://www.egyptindependent.com/exclusive-us-intel-indicates-iran-developing-plans/';
  const now = Date.now();

  /** Parse one feed, serve it as the digest does, and read the link the relay would alert with. */
  function relayLinkFor(xml: string): string {
    const parsed = __testing__.parseRssXml(xml, feed, 'full');
    assert.equal(parsed?.items.length, 1);
    const served = toProtoItem(parsed!.items[0]!);
    const digest = { coverage: { servedStale: false }, categories: { middleeast: { items: [served] } } };
    return buildClassifyCandidateMap(digest, [], 'full', now, 6 * 3600_000).get('Headline').link;
  }

  it('the relay table alone still blanks this publisher', () => {
    assert.equal(gateRelayStoryLink(article, feed.name), '');
  });

  it('a link on the feed host is stamped verified and reaches the relay', () => {
    const parsed = __testing__.parseRssXml(rssWithLink(article), feed, 'full');
    assert.equal(parsed!.items[0]!.linkVerified, true);
    assert.equal(toProtoItem(parsed!.items[0]!).linkVerified, true);
    assert.equal(relayLinkFor(rssWithLink(article)), article);
  });

  it('a spoofed link off the publisher is blanked, unverified, and never reaches the relay', () => {
    for (const hostile of [
      'https://evil.example/phish',
      'https://egyptindependent.com.evil.example/x',
      'https://evilegyptindependent.com/x',
    ]) {
      const parsed = __testing__.parseRssXml(rssWithLink(hostile), feed, 'full');
      assert.equal(parsed!.items[0]!.link, '', hostile);
      assert.equal(parsed!.items[0]!.linkVerified, false, hostile);
      const served = toProtoItem(parsed!.items[0]!);
      assert.equal(served.link, '');
      assert.equal(served.linkVerified, false);
      assert.equal(relayLinkFor(rssWithLink(hostile)), '', hostile);
    }
  });

  it('a feed cannot stamp its own item', () => {
    const pubDate = new Date(now - 3600_000).toUTCString();
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item>
      <title>Headline</title><link>https://evil.example/phish</link><pubDate>${pubDate}</pubDate>
      <linkVerified>true</linkVerified><link_verified>true</link_verified></item></channel></rss>`;
    assert.equal(relayLinkFor(xml), '');
  });

  it('a row with a link but no stamp is served unverified, and the relay falls back to its table', () => {
    const parsed = __testing__.parseRssXml(rssWithLink(article), feed, 'full');
    const { linkVerified: _stamp, ...cachedBeforeStamp } = parsed!.items[0]!;
    const served = toProtoItem(cachedBeforeStamp);
    assert.equal(served.link, article);
    assert.equal(served.linkVerified, false);
    const digest = { coverage: { servedStale: false }, categories: { middleeast: { items: [served] } } };
    assert.equal(buildClassifyCandidateMap(digest, [], 'full', now, 6 * 3600_000).get('Headline').link, '');
  });
});

describe('the relay scores a topic feed item on its original publisher (#10977)', () => {
  const feed = { name: 'Strategic Chokepoints', url: 'https://news.google.com/rss/search?q=Hormuz&hl=en-US&gl=US&ceid=US:en', lang: 'en' };
  const xml = (publisher: string) => `<?xml version="1.0"?><rss><channel><item><title>Headline - ${publisher}</title><link>https://news.google.com/rss/articles/abc</link><pubDate>${new Date().toUTCString()}</pubDate><source url="https://english.alarabiya.net">${publisher}</source></item></channel></rss>`;
  const relaySource = (served: ReturnType<typeof toProtoItem>) => {
    const digest = { coverage: { servedStale: false }, categories: { energy: { items: [served] } } };
    return [...buildClassifyCandidateMap(digest, [], 'energy', Date.now(), 6 * 3600_000).values()][0].source;
  };

  it('serves the original publisher and the relay scores on it', () => {
    const parsed = __testing__.parseRssXml(xml('Al Arabiya'), feed, 'energy');
    const served = toProtoItem(parsed!.items[0]!);
    assert.equal(served.source, 'Strategic Chokepoints');
    assert.equal(served.originPublisher, 'Al Arabiya');
    assert.equal(relaySource(served), 'Al Arabiya');
  });

  it('serves the tier table spelling of the publisher', () => {
    const served = toProtoItem(__testing__.parseRssXml(xml('al arabiya'), feed, 'energy')!.items[0]!);
    assert.equal(served.originPublisher, 'Al Arabiya');
  });

  it('keeps the feed name when the named publisher has no curated tier', () => {
    const parsed = __testing__.parseRssXml(xml('Totally Real Wire'), feed, 'energy');
    assert.equal(parsed!.items[0]!.originPublisher, 'Totally Real Wire');
    assert.equal(parsed!.items[0]!.originPublisherTrusted, true);
    const served = toProtoItem(parsed!.items[0]!);
    assert.equal(served.originPublisher, '');
    assert.equal(relaySource(served), 'Strategic Chokepoints');
  });

  it('resolves the name Google News gives Al Arabiya to its tier table spelling', () => {
    const served = toProtoItem(__testing__.parseRssXml(xml('Al Arabiya English'), feed, 'energy')!.items[0]!);
    assert.equal(served.originPublisher, 'Al Arabiya');
    assert.equal(relaySource(served), 'Al Arabiya');
    const relayTiers = { ...require('../shared/source-tiers.json'), ...require('../shared/x-account-source-tiers.json') };
    assert.equal(relayTiers[relaySource(served)], 2);
  });

  it('reads the publisher from <source>, never from the title suffix', () => {
    const spoofed = xml('Totally Real Wire').replace('Headline - Totally Real Wire', 'Headline - Reuters');
    const served = toProtoItem(__testing__.parseRssXml(spoofed, feed, 'energy')!.items[0]!);
    assert.equal(served.originPublisher, '');
    assert.equal(relaySource(served), 'Strategic Chokepoints');
  });

  it('keeps the feed name when the feed is not a trusted aggregator', () => {
    const parsed = __testing__.parseRssXml(xml('Al Arabiya'), { ...feed, url: 'https://example.com/feed' }, 'energy');
    const served = toProtoItem(parsed!.items[0]!);
    assert.equal(served.originPublisher, '');
    assert.equal(relaySource(served), 'Strategic Chokepoints');
  });
});
