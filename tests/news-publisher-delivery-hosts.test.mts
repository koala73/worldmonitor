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
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import catalog from '../shared/news-catalog.json' with { type: 'json' };
import { publisherFamilyFor, PUBLISHER_FAMILY_DOMAIN_TABLE } from '../shared/publisher-families.js';

const require = createRequire(import.meta.url);
const { gateRelayStoryLink } = require('../scripts/lib/publisher-link-relay-gate.cjs');

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
