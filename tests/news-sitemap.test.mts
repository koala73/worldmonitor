import assert from 'node:assert/strict';
import { it } from 'node:test';
import { __testing__, looksLikeRssXml } from '../server/worldmonitor/news/v1/list-feed-digest';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';

const gn = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
const serverFeed = (name: string) => Object.values(VARIANT_FEEDS.full!).flat().find(f => f.name === name)!;

it('reads the five latest CNN publications and retains older articles in the country pool', () => {
  const feed = VARIANT_FEEDS.full!.politics!.find(f => f.name === 'CNN World')!;
  const now = Date.now();
  const entries = Array.from({ length: 7 }, (_, i) => {
    const published = new Date(now - (7 - i) * 60_000).toISOString();
    return `<url><loc>https://www.cnn.com/story/${i}</loc><lastmod>${new Date(now - i).toISOString()}</lastmod>
      <news:news><news:publication_date>${published}</news:publication_date><news:title>World &amp; politics ${i}</news:title></news:news></url>`;
  });
  entries.unshift(`<url><loc>https://www.cnn.com/no-title</loc><news:publication_date>${new Date(now).toISOString()}</news:publication_date></url>`);
  const xml = `<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url><loc>missing-date</loc></url>${entries.join('')}</urlset>`;
  assert.equal(looksLikeRssXml(xml), true);
  assert.equal(looksLikeRssXml('<urlset><url><loc>x</loc></url></urlset>'), false);
  assert.equal(feed.url, 'https://www.cnn.com/sitemap/news.xml');
  const result = __testing__.parseRssXml(xml, feed, 'full')!;
  assert.deepEqual(result.items.map(x => x.title), [6, 5, 4, 3, 2].map(i => `World & politics ${i}`));
  assert.equal(result.items[0]!.publishedAt, now - 60_000);
  assert.equal(result.items[0]!.link, 'https://www.cnn.com/story/6');
  assert.ok(result.countryItems?.some(x => x.link.endsWith('/0')));
});

it('keeps CNN video clips, shopping and sponsored pages out of the CNN World feed', () => {
  // CNN's news sitemap covers the whole site. On 2026-11-18 its five newest
  // entries were all video clips, and shopping pages sat among the articles.
  const feed = serverFeed('CNN World');
  assert.deepEqual(feed.excludePathSegments, ['video', 'cnn-underscored', 'brandstories']);
  const now = Date.now();
  const url = (path: string, minutesAgo: number) => `<url><loc>https://www.cnn.com${path}</loc>
    <news:news><news:publication><news:name>CNN</news:name><news:language>en</news:language></news:publication>
    <news:publication_date>${new Date(now - minutesAgo * 60_000).toISOString()}</news:publication_date>
    <news:title>${path}</news:title></news:news><image:image><image:loc>https://media.cnn.com/x.jpg</image:loc></image:image></url>`;
  const excluded = [
    '/2026/11/17/politics/video/clip-a', '/2026/11/17/us/video/clip-b', '/cnn-underscored/reviews/best-can-opener',
    '/cnn-underscored/deals/kitchen-deals', '/brandstories/sponsor-story', '/2026/11/17/world/video/clip-c',
  ];
  const articles = Array.from({ length: 6 }, (_, i) => `/2026/11/17/world/story-${i}`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9" xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${excluded.map((p, i) => url(p, i)).join('')}${articles.map((p, i) => url(p, 10 + i)).join('')}
<url><loc>https://www.cnn.com/2026/11/17/world/videos-of-the-week</loc><news:news><news:publication_date>${new Date(now - 30 * 60_000).toISOString()}</news:publication_date><news:title>not a video segment</news:title></news:news></url>
</urlset>`;
  assert.equal(looksLikeRssXml(xml), true);
  const result = __testing__.parseRssXml(xml, feed, 'full')!;
  assert.deepEqual(result.items.map(x => x.link), articles.slice(0, 5).map(p => `https://www.cnn.com${p}`));
  const pooled = (result.countryItems ?? []).map(x => x.link);
  assert.ok(pooled.includes('https://www.cnn.com/2026/11/17/world/story-5'));
  assert.ok(pooled.includes('https://www.cnn.com/2026/11/17/world/videos-of-the-week'), 'a segment match, not a substring match');
  for (const path of excluded) assert.ok(!pooled.includes(`https://www.cnn.com${path}`), path);
});

it('ranks every feed newest first before the per-feed cap (#10978)', () => {
  // NYT World's RSS is in editorial order: on 2026-11-18, four of its five
  // newest items sat outside the first five the digest reads.
  const feed = serverFeed('New York Times World');
  const now = Date.now();
  const ages = [5, 600, 480, 720, 360, 1, 2, 3, 4];
  const item = (age: number) => `<item><title>Story ${age}</title><link>https://www.nytimes.com/2026/11/17/world/s-${age}.html</link>
    <pubDate>${new Date(now - age * 60_000).toUTCString()}</pubDate></item>`;
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>NYT</title>${ages.map(item).join('')}</channel></rss>`;
  const ranked = __testing__.parseRssXml(xml, feed, 'full')!;
  assert.deepEqual(ranked.items.map(x => x.title), [1, 2, 3, 4, 5].map(a => `Story ${a}`));
  assert.ok(ranked.countryItems?.some(x => x.title === 'Story 720'));
});

it('a fresh item at position 22 of a relevance-ordered Google News search reaches the digest (#10978)', () => {
  // At 10:50 UTC on 2026-11-18 Al Arabiya's ADNOC article sat at #22 of a
  // Google News search, which lists by relevance, below the 5-item cap.
  const feed = serverFeed('Al Arabiya');
  const now = Date.now();
  const item = (i: number, ageMin: number) => `<item><title>Gulf story ${i} - Al Arabiya English</title>
    <link>https://news.google.com/rss/articles/s-${i}</link>
    <pubDate>${new Date(now - ageMin * 60_000).toUTCString()}</pubDate><source url="https://english.alarabiya.net">Al Arabiya English</source></item>`;
  const items = Array.from({ length: 30 }, (_, i) => item(i + 1, i + 1 === 22 ? 3 : 600 + i));
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>GN</title>${items.join('')}</channel></rss>`;
  const parsed = __testing__.parseRssXml(xml, feed, 'full')!;
  assert.equal(parsed.items[0]?.title, 'Gulf story 22 - Al Arabiya English');
});

it('keeps feed order for undated items, after dated ones', () => {
  const feed = serverFeed('New York Times World');
  const dated = `<item><title>Dated</title><link>https://www.nytimes.com/2026/11/17/world/d.html</link><pubDate>${new Date().toUTCString()}</pubDate></item>`;
  const undated = (n: number) => `<item><title>Undated ${n}</title><link>https://www.nytimes.com/2026/11/17/world/u-${n}.html</link></item>`;
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>NYT</title>${undated(1)}${undated(2)}${dated}</channel></rss>`;
  const parsed = __testing__.parseRssXml(xml, feed, 'full')!;
  assert.equal(parsed.items[0]?.title, 'Dated');
});

it('keeps the Google News search as claim depth for publishers whose own feeds are shallow', () => {
  // Direct feeds held 6 (Sky) to 40 (NV EN) items on 2026-11-18; the Google
  // News searches they replaced held up to 100 for /verify and verify_claim.
  const expected: Record<string, string> = {
    'Sky News': gn('site:news.sky.com when:1d'),
    'Washington Post World': gn('site:washingtonpost.com world when:1d'),
    'Kyiv Independent': gn('site:kyivindependent.com when:3d'),
    Ukrinform: gn('site:ukrinform.net when:3d'),
    'NV EN': gn('site:english.nv.ua when:2d'),
  };
  for (const [name, depthUrl] of Object.entries(expected)) {
    const feed = serverFeed(name);
    assert.equal(feed.depthUrl, depthUrl, name);
    assert.ok(!feed.url.includes('news.google.com'), `${name}: the digest still reads the publisher`);
  }
});
